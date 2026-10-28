#!/usr/bin/env node
// Local failure-set regression: freeze reviewed replay points, then compare a newer
// agent build against the build it is meant to replace.
//
// This runs from a rotom checkout, never from the installed npm package: the replay
// runner needs the eval harness, and `evals/` is deliberately excluded from the
// release manifest. Real sessions and model calls are the person's own data and
// money, so `run` prints the exact plan and refuses to send without `--yes`.
//
// Usage:
//   node eval-regression.mjs prepare --name=failures [--selector=all|fail|failSet] [--repeats=1] [--force]
//   node eval-regression.mjs run --set=failures --baseline=<product dir> --candidate=<product dir> \
//     --model=provider/id [--repeats=1] [--plan-digest=<digest>] [--yes] [--json]
//   node eval-regression.mjs suggest [--limit=20] [--json]
//   node eval-regression.mjs add --session=<id> --entry=<entryId> --expected=<text> \
//     --check=model|rule:<rule> [--yes]
//   node eval-regression.mjs help
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPrivatePath, readAnnotations } from "../../extensions/observability/eval/annotations.mjs";
import { REPLAY_RULES, cutEntries, readReplayCases, replaySource, sessionSha256, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";
import { measureReplayPlan } from "../../extensions/observability/eval/replay-plan.mjs";
import { resolveReplayBaseline } from "../../extensions/observability/eval/replay-service.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import {
	buildRegressionSet, readRegressionSet, reportsDir, sessionIndex, sourceReader, suggestReplayPoints, summarizeRegression, writeRegressionSet, writeSuggestions,
} from "./regression-set.mjs";

const RUNNER = fileURLToPath(new URL("./session-replay.mjs", import.meta.url));
const MAX_SESSION_BYTES = 128 * 1024 * 1024;

const COPY = {
	usage: `用法：
  rotom eval-regression prepare --name=<集合名> [--selector=all|fail|failSet] [--repeats=1..3] [--force]
  rotom eval-regression run --set=<集合名> --baseline=<产品目录> --candidate=<产品目录> --model=<provider/id> [--repeats=1..3] [--extension=<文件>] [--thinking=<级别>] [--plan-digest=<摘要>] [--yes] [--json]
  rotom eval-regression suggest [--limit=20] [--json]
  rotom eval-regression add --session=<会话ID> --entry=<entryId> --expected=<期望行为> --check=model|rule:<规则> [--yes]
  rotom eval-regression help

prepare 读取已保存的回放点并冻结成本机集合，不调用模型。
run     先打印计划；没有 --yes 不会发送任何请求。
suggest 为标了「不满意」但没有回放点的会话给出截断点证据，不写回放点。
add     人工确认一条建议后写入回放点；之后需要重新 prepare --force。`,
	empty: "集合为空：没有可回归的有效回放点。",
	excludedWarn: (count) => `集合中有 ${count} 个点在冻结时已失效，本次不运行；请复核后重新 prepare。`,
	plan: "计划",
	confirm: "未发送：请在确认上面的计划后加 --yes 重新运行。",
	changed: "未发送：计划摘要与 --plan-digest 不一致，内容、模型或产品已变化。",
	invalidPoints: "以下回放点已失效，未发送请求：",
	runnerMissing: "回放运行器不可用：发行包不包含 evals/；请在 rotom 仓库 checkout 中运行。",
	done: "结果",
	suggestEmpty: "没有需要建议的会话：标为不满意的会话都已有回放点。",
	addNeedsYes: "未写入：加 --yes 确认这条回放点的期望行为与判定方式。",
	addSaved: (key) => `已保存回放点 ${key}；运行 prepare --force 可把它冻结进集合。`,
	setSaved: (path) => `已写入集合 ${path}`,
};

export function parseArgs(argv) {
	const args = { _: [] };
	for (const item of argv) {
		const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(item);
		if (!match) { args._.push(item); continue; }
		const [, name, value] = match;
		args[name] = value ?? true;
	}
	return args;
}

function flag(args, name) { return args[name] === true || args[name] === "true"; }
function text(args, name) { return typeof args[name] === "string" ? args[name] : undefined; }

function defaults(args) {
	return {
		directory: text(args, "directory") ?? join(homedir(), ".rotom", "evals"),
		sessions: text(args, "sessions") ?? join(homedir(), ".pi", "agent", "sessions"),
	};
}

async function loadBranch(sessions, index, sessionId) {
	const path = index.paths.get(sessionId);
	if (!path) throw new Error("session_not_indexed");
	const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set(), MAX_SESSION_BYTES);
	if (loaded.reason || !loaded.branch) throw new Error(`cannot_read_session: ${loaded.reason ?? "no_branch"}`);
	return loaded.branch;
}

/** One runner process; JSON lines carry progress, the last object carries results. */
export function runReplayRunner({ node, args, env, onLine }) {
	return new Promise((resolve) => {
		const child = spawn(node, [RUNNER, ...args], { env: { ...env, ROTOM_REPLAY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let buffered = "", stderr = "", result;
		const lines = [];
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			const parts = buffered.split("\n");
			buffered = parts.pop() ?? "";
			for (const line of parts) {
				if (!line.trim()) continue;
				let row;
				try { row = JSON.parse(line); } catch { onLine?.({ text: line }); continue; }
				lines.push(row);
				if (row.progress) onLine?.(row);
				else if (Array.isArray(row.runs)) result = row;
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
		child.once("error", (error) => resolve({ code: 1, result: undefined, stderr: String(error?.message ?? error), lines }));
		child.once("close", (code) => resolve({ code: code ?? 1, result, stderr: stderr.trim(), lines }));
	});
}

export async function main(argv = process.argv.slice(2), deps = {}) {
	const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
	const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
	const spawnRunner = deps.spawnRunner ?? runReplayRunner;
	const node = deps.node ?? process.execPath;
	const args = parseArgs(argv);
	const command = args._[0] ?? "help";
	const { directory, sessions } = defaults(args);

	if (command === "help" || flag(args, "help")) { out(COPY.usage); return { exitCode: 0 }; }

	if (command === "prepare") {
		const name = text(args, "name") ?? "failures";
		const selector = text(args, "selector") ?? "all";
		const index = await sessionIndex(sessions);
		const set = await buildRegressionSet({
			directory, name, selector: { kind: selector }, repeats: Number(text(args, "repeats") ?? 1),
			cases: await readReplayCases(directory), labels: await readAnnotations(directory),
			resolveSource: sourceReader(index), indexComplete: index.complete,
		});
		const saved = await writeRegressionSet(directory, set, { overwrite: flag(args, "force") });
		const summary = { command, name, path: saved.path, digest: saved.digest, cases: set.cases.length, excluded: set.excluded, scan: set.scan, selector: set.selector, repeats: set.repeats };
		if (flag(args, "json")) out(JSON.stringify(summary));
		else {
			out(COPY.setSaved(saved.path));
			out(`选择 ${JSON.stringify(set.selector)}；冻结 ${set.cases.length} 个点，排除 ${set.excluded.length} 个（回放点总数 ${set.scan.replayPoints}）。`);
			for (const item of set.excluded) out(`  排除 ${item.key}：${item.reason}`);
			if (!index.complete) out("警告：会话索引达到上限，集合可能不完整；请缩小 sessions 根目录后重试。");
		}
		return { exitCode: 0, set: summary };
	}

	if (command === "run") {
		const set = await readRegressionSet(directory, text(args, "set") ?? "failures");
		if (!set.cases.length) { err(COPY.empty); return { exitCode: 2 }; }
		if (set.excluded.length) err(COPY.excludedWarn(set.excluded.length));
		const [baseline, candidate] = await Promise.all([resolveReplayBaseline(text(args, "baseline")), resolveReplayBaseline(text(args, "candidate"))]);
		if (!baseline.enabled) { err(`基线不可用：${baseline.reason}`); return { exitCode: 2 }; }
		if (!candidate.enabled) { err(`候选产品不可用：${candidate.reason}`); return { exitCode: 2 }; }
		const model = text(args, "model");
		if (!model || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/iu.test(model)) { err("需要 --model=provider/id"); return { exitCode: 2 }; }
		const repeats = Math.min(Math.max(Number(text(args, "repeats") ?? set.repeats ?? 1) || 1, 1), 3);
		// `--extension` is how an offline check injects a faux provider; a real run
		// normally needs none.
		const extensions = (text(args, "extension") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
		const thinkingLevel = text(args, "thinking");
		const index = await sessionIndex(sessions);
		const read = sourceReader(index);
		const items = [], invalid = [];
		for (const item of set.cases) {
			try {
				const source = await read(item);
				const frozen = replaySource({ branch: source.branch, sessionContent: source.content, expectedSha256: item.sessionSha256, cutEntryId: item.cutEntryId });
				if (frozen.status !== "ready") invalid.push({ key: item.key, reason: frozen.reason });
				else items.push({ key: item.key, check: item.check, expected: item.expected, entries: frozen.entries });
			} catch (error) { invalid.push({ key: item.key, reason: error instanceof Error ? error.message : String(error) }); }
		}
		// A partial run would look like a complete one, so an invalid point stops it.
		if (invalid.length) { err(COPY.invalidPoints); for (const item of invalid) err(`  ${item.key}：${item.reason}`); return { exitCode: 2, invalid }; }
		const plan = measureReplayPlan({ items, repeats, arms: 2 });
		const planDigest = createHash("sha256").update(JSON.stringify({ set: set.digest, model, repeats, extensions, thinkingLevel: thinkingLevel ?? null, baseline: baseline.path, candidate: candidate.path, cases: set.cases.map((item) => item.key) })).digest("hex");
		const planLines = [
			`${COPY.plan}：${set.cases.length} 个点 × ${repeats} 次 × 2 个产品 + 每点 1 次原回复对照`,
			`模型 ${model}（生成与判定共用；模型点判定输入 ${plan.originalChars} 字符，脱敏 ${plan.redactionTotal} 处）`,
			`基线 ${baseline.path}`, `候选 ${candidate.path}`,
			`调用 ${plan.runs} 次，生成上下文合计 ${plan.totalChars} 字符；未记录价格时费用保持未知`,
			`计划摘要 ${planDigest}`,
		];
		for (const line of planLines) (flag(args, "json") ? err : out)(line);
		if (!flag(args, "yes")) { out(COPY.confirm); return { exitCode: 2, planDigest }; }
		const expected = text(args, "plan-digest");
		if (expected && expected !== planDigest) { err(COPY.changed); return { exitCode: 2, planDigest }; }
		const paths = {};
		for (const item of set.cases) paths[item.sessionId] = index.paths.get(item.sessionId);
		const startedAt = new Date().toISOString();
		const runnerArgs = [
			`--product=${candidate.path}`, "--arm=candidate", `--arm-baseline=${baseline.path}`, `--model=${model}`,
			`--repeats=${repeats}`, `--cases=${set.cases.map((item) => item.key).join(",")}`,
			`--directory=${directory}`, `--sessions=${sessions}`, `--paths=${JSON.stringify(paths)}`,
		];
		if (extensions.length) runnerArgs.push(`--extension=${extensions.join(",")}`);
		if (thinkingLevel) runnerArgs.push(`--thinking=${thinkingLevel}`);
		const runner = await spawnRunner({
			node, args: runnerArgs, env: process.env,
			onLine: (row) => { if (row.progress) err(`进度 ${row.progress.done}/${row.progress.total}`); else if (row.text) err(row.text); },
		});
		if (runner.code !== 0 || !runner.result) { err(`运行器退出 ${runner.code}：${runner.stderr || COPY.runnerMissing}`); return { exitCode: 2 }; }
		const report = summarizeRegression({ set, rows: runner.result.runs ?? [], model, arms: runner.result.arms ?? {}, startedAt, finishedAt: new Date().toISOString() });
		report.runnerWarnings = runner.result.warnings ?? [];
		await ensurePrivateFolder(reportsDir(directory));
		const stamp = startedAt.replace(/[:.]/gu, "-");
		report.reportPath = join(reportsDir(directory), `${set.name}-${stamp}.json`);
		const { privateWrite } = await import("../../extensions/observability/eval/session-data.mjs");
		await privateWrite(report.reportPath, JSON.stringify(report) + "\n");
		if (flag(args, "json")) out(JSON.stringify(report));
		else {
			out(`${COPY.done}：退化 ${report.counts.regression}，仍失败 ${report.counts.stillFailing}，改进 ${report.counts.improved}，保持通过 ${report.counts.stablePass}，无法判断 ${report.counts.inconclusive + report.counts.judgeBlind + report.counts.incomplete}`);
			for (const point of report.points) out(`  ${point.comparison.padEnd(13)} ${point.key}${point.reasons.length ? `（${point.reasons.join("、")}）` : ""}`);
			if (report.runnerWarnings.length) out(`警告：${report.runnerWarnings.join("、")}`);
			out(`报告 ${report.reportPath}`);
		}
		return { exitCode: report.exitCode, report };
	}

	if (command === "suggest") {
		const index = await sessionIndex(sessions);
		const items = await suggestReplayPoints({
			cases: await readReplayCases(directory), labels: await readAnnotations(directory),
			loadBranch: (sessionId) => loadBranch(sessions, index, sessionId),
			limit: Number(text(args, "limit") ?? 20),
		});
		// Sessions with a point are stale-point reports, not new suggestions.
		const pending = items.filter((item) => !item.hasReplayPoint);
		const saved = await writeSuggestions(directory, items);
		if (flag(args, "json")) out(JSON.stringify({ path: saved.path, items }));
		else {
			if (!pending.length) out(COPY.suggestEmpty);
			for (const item of pending) {
				out(`${item.sessionId}`);
				for (const candidate of item.candidates) out(`  截断点 ${candidate.entryId}：用户反馈「${candidate.evidence}」`);
				if (item.problem) out(`  需要你补充：${item.problem}；还缺 ${item.needs.join("、")}`);
			}
			out(`建议草稿 ${saved.path}`);
		}
		return { exitCode: 0, items };
	}

	if (command === "add") {
		const sessionId = text(args, "session"), entryId = text(args, "entry"), expected = text(args, "expected"), checkText = text(args, "check") ?? "model";
		if (!sessionId || !entryId || !expected) { err(COPY.usage); return { exitCode: 2 }; }
		const check = checkText === "model" ? { mode: "model" } : (() => {
			const rule = /^rule:([a-z-]+)$/u.exec(checkText)?.[1];
			return rule && REPLAY_RULES.includes(rule) ? { mode: "rule", rule } : undefined;
		})();
		if (!check) { err(`未知判定方式 ${checkText}`); return { exitCode: 2 }; }
		if (!flag(args, "yes")) { err(COPY.addNeedsYes); return { exitCode: 2 }; }
		const index = await sessionIndex(sessions);
		const path = index.paths.get(sessionId);
		if (!path) { err(`找不到会话 ${sessionId}`); return { exitCode: 2 }; }
		const branch = await loadBranch(sessions, index, sessionId);
		if (!cutEntries(branch, entryId)) { err(`${entryId} 不是可用的 assistant 截断点`); return { exitCode: 2 }; }
		const { readFile } = await import("node:fs/promises");
		const saved = await writeReplayCase(directory, { sessionId, cutEntryId: entryId, expected, check }, sessionSha256(await readFile(path, "utf8")));
		out(COPY.addSaved(saved.key));
		return { exitCode: 0, case: saved.key };
	}

	err(`未知命令 ${command}`);
	out(COPY.usage);
	return { exitCode: 2 };
}

async function ensurePrivateFolder(folder) {
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	await chmod(folder, 0o700);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().then((result) => { process.exitCode = result.exitCode ?? 0; })
		.catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
}
