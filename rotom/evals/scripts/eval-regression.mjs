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
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAnnotations } from "../../extensions/observability/eval/annotations.mjs";
import { REPLAY_JUDGE_PROMPT_VERSION, REPLAY_RULES, REPLAY_SESSION_MAX_BYTES, cutEntries, readReplayCases, replaySource, sessionSha256, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";
import { clampRepeats, measureReplayPlan } from "../../extensions/observability/eval/replay-plan.mjs";
import { resolveReplayBaseline } from "../../extensions/observability/eval/replay-service.mjs";
import { assertOutsideGitWorktree, loadSession, privateWrite } from "../../extensions/observability/eval/session-data.mjs";
import { armIdentity, buildRegressionSet, ensurePrivateFolder, readRegressionSet, reportsDir, sessionIndex, sourceReader, writeRegressionSet } from "./regression-set.mjs";
import { planDigestOf, runReplayRunner } from "./regression-runner.mjs";
import { summarizeRegression } from "./regression-compare.mjs";
import { suggestReplayPoints, writeSuggestions } from "./regression-suggest.mjs";


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
	excluded: (count) => `集合中有 ${count} 个点在冻结时已失效，不能开始运行；请复核后重新 prepare。`,
	judgeDrift: "集合冻结时的判定提示词版本与当前版本不同，重新评分不再是同一次对照；请重新 prepare。",
	piOverride: "ROTOM_PI 会换掉 Pi 运行时，而计划摘要没有绑定它；请先 unset ROTOM_PI 再运行。",
	setTruncated: "集合冻结时会话索引不完整，无法证明覆盖；请缩小 sessions 根目录后重新 prepare。",
	indexTruncated: "会话索引达到上限，无法证明集合完整；请缩小 sessions 根目录后重试。",
	git: "私有目录不能位于 Git 工作区；请用 --directory 指定工作区之外的路径。",
	addExists: (key) => `已存在回放点 ${key}；本命令只新增，不覆盖已复核的点。`,
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

async function loadBranch(index, sessionId) {
	const path = index.paths.get(sessionId);
	if (!path) throw new Error("session_not_indexed");
	const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set(), REPLAY_SESSION_MAX_BYTES);
	if (loaded.reason || !loaded.branch) throw new Error(`cannot_read_session: ${loaded.reason ?? "no_branch"}`);
	return loaded.branch;
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
	// Private annotations, expectations and suggestions must never land in a checkout.
	try { await assertOutsideGitWorktree(directory); }
	catch { err(COPY.git); return { exitCode: 2 }; }

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
		// A partial set cannot report success, so it never starts a paid run either.
		if (set.excluded.length) { err(COPY.excluded(set.excluded.length)); for (const item of set.excluded) err(`  ${item.key}：${item.reason}`); return { exitCode: 2 }; }
		if (set.judgePromptVersion !== REPLAY_JUDGE_PROMPT_VERSION) { err(COPY.judgeDrift); return { exitCode: 2 }; }
		// A set frozen from a truncated scan cannot be complete, whatever today's index says.
		if (set.scan?.indexComplete !== true || set.scan?.included !== set.cases.length) { err(COPY.setTruncated); return { exitCode: 2 }; }
		// The Pi runtime is inherited, not hashed: a different one would run unconfirmed code.
		if (process.env.ROTOM_PI) { err(COPY.piOverride); return { exitCode: 2 }; }
		const [baseline, candidate] = await Promise.all([resolveReplayBaseline(text(args, "baseline")), resolveReplayBaseline(text(args, "candidate"))]);
		if (!baseline.enabled) { err(`基线不可用：${baseline.reason}`); return { exitCode: 2 }; }
		if (!candidate.enabled) { err(`候选产品不可用：${candidate.reason}`); return { exitCode: 2 }; }
		const model = text(args, "model");
		if (!model || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/iu.test(model)) { err("需要 --model=provider/id"); return { exitCode: 2 }; }
		const repeats = clampRepeats(text(args, "repeats") ?? set.repeats);
		// `--extension` is how an offline check injects a faux provider; a real run
		// normally needs none.
		const extensions = (text(args, "extension") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
		const thinkingLevel = text(args, "thinking");
		const index = await sessionIndex(sessions);
		if (!index.complete) { err(COPY.indexTruncated); return { exitCode: 2 }; }
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
		const arms = { baseline: await armIdentity(baseline.path), candidate: await armIdentity(candidate.path) };
		const extensionIdentities = extensions.length ? await Promise.all(extensions.map((path) => armIdentity(path))) : [];
		const planDigest = planDigestOf({ set, model, repeats, extensions, extensionIdentities, thinkingLevel, arms });
		const planLines = [
			`${COPY.plan}：${set.cases.length} 个点 × ${repeats} 次 × 2 个产品 + 每点 1 次原回复对照（共 ${plan.runs} 行）`,
			`推理调用：生成 ${plan.generations} 次 + 模型判定 ${plan.judgments} 次${plan.localChecks ? `；本地规则判定 ${plan.localChecks} 次，不调用模型` : ""}`,
			`模型 ${model}（生成与判定共用）；生成上下文 ${plan.perCaseChars * repeats * 2} 字符，判定上下文与期望 ${plan.judgeChars} 字符（脱敏 ${plan.redactionTotal} 处，不含生成的回复与提示词框架）`,
			`基线 ${baseline.path}（内容 ${arms.baseline.digest.slice(0, 12)}，${arms.baseline.files} 项）`,
			`候选 ${candidate.path}（内容 ${arms.candidate.digest.slice(0, 12)}，${arms.candidate.files} 项）`,
			...(extensions.length ? [`扩展 ${extensions.map((path, index) => `${path}（内容 ${extensionIdentities[index].digest.slice(0, 12)}，仅覆盖入口文件）`).join("、")}`] : []),
			`内容不覆盖 node_modules、.git 与 evals/；Pi fork 由 lock/fork-build 的版本与 integrity 固定`,
			`内容身份是校验，不是执行快照：运行期间产品文件仍可能变化`,
			`未记录价格时费用保持未知`, `计划摘要 ${planDigest}`,
		];
		for (const line of planLines) (flag(args, "json") ? err : out)(line);
		if (!flag(args, "yes")) { out(COPY.confirm); return { exitCode: 2, planDigest }; }
		const expected = text(args, "plan-digest");
		if (expected && expected !== planDigest) { err(COPY.changed); return { exitCode: 2, planDigest }; }
		// The confirmed digest must still describe what is on disk: a path is not a
		// build, so an in-place edit cannot ride an old confirmation.
		const recheck = planDigestOf({
			set, model, repeats, extensions, thinkingLevel,
			extensionIdentities: extensions.length ? await Promise.all(extensions.map((path) => armIdentity(path))) : [],
			arms: { baseline: await armIdentity(baseline.path), candidate: await armIdentity(candidate.path) },
		});
		if (recheck !== planDigest) { err(COPY.changed); return { exitCode: 2, planDigest }; }
		const paths = {};
		for (const item of set.cases) paths[item.sessionId] = index.paths.get(item.sessionId);
		const startedAt = new Date().toISOString();
		// The runner executes these frozen records, not a second read of the live store:
		// editing a point after `prepare` must not change what a confirmed plan runs.
		const frozenPath = join(reportsDir(directory), `.plan-${planDigest.slice(0, 16)}-${randomUUID().slice(0, 8)}.json`);
		await ensurePrivateFolder(reportsDir(directory));
		await privateWrite(frozenPath, JSON.stringify({ schema: "rotom-replay-frozen/v1", judgePromptVersion: set.judgePromptVersion, cases: set.cases }) + "\n");
		const runnerArgs = [
			`--product=${candidate.path}`, "--arm=candidate", `--arm-baseline=${baseline.path}`, `--model=${model}`,
			`--repeats=${repeats}`, `--frozen=${frozenPath}`,
			`--directory=${directory}`, `--sessions=${sessions}`, `--paths=${JSON.stringify(paths)}`,
		];
		if (extensions.length) runnerArgs.push(`--extension=${extensions.join(",")}`);
		if (thinkingLevel) runnerArgs.push(`--thinking=${thinkingLevel}`);
		let runner;
		try {
			runner = await spawnRunner({
				node, args: runnerArgs, env: process.env,
				onLine: (row) => { if (row.progress) err(`进度 ${row.progress.done}/${row.progress.total}`); else if (row.text) err(row.text); },
			});
		} finally { await rm(frozenPath, { force: true }); }
		const finishedAt = new Date().toISOString();
		const failure = runner.code === 0 && runner.result ? undefined : { code: runner.code, message: (runner.stderr || COPY.runnerMissing).slice(0, 400) };
		const report = summarizeRegression({ set, rows: runner.result?.runs ?? [], model, arms: runner.result?.arms ?? {}, repeats, startedAt, finishedAt, failure });
		report.runnerWarnings = runner.result?.warnings ?? [];
		// The confirmed provenance travels with the report: content identities, the
		// plan digest and the extensions are what make a later question answerable.
		report.planDigest = planDigest;
		report.identities = { baseline: arms.baseline, candidate: arms.candidate, extensions: extensionIdentities };
		await ensurePrivateFolder(reportsDir(directory));
		const stamp = startedAt.replace(/[:.]/gu, "-");
		report.reportPath = join(reportsDir(directory), `${set.name}-${stamp}.json`);
		await privateWrite(report.reportPath, JSON.stringify(report) + "\n");
		if (flag(args, "json")) out(JSON.stringify(report));
		else {
			out(`${COPY.done}：退化 ${report.counts.regression}，仍失败 ${report.counts.stillFailing}，改进 ${report.counts.improved}，保持通过 ${report.counts.stablePass}，无法判断 ${report.counts.inconclusive + report.counts.judgeBlind + report.counts.incomplete}`);
			for (const point of report.points) out(`  ${point.comparison.padEnd(13)} ${point.key}${point.reasons.length ? `（${point.reasons.join("、")}）` : ""}`);
			if (failure) out(`运行器未正常结束（${failure.code}）：${failure.message}`);
			else if (report.runnerWarnings.length) out(`警告：${report.runnerWarnings.join("、")}`);
			out(`报告 ${report.reportPath}`);
		}
		return { exitCode: report.exitCode, report };
	}

	if (command === "suggest") {
		const index = await sessionIndex(sessions);
		const { items, stale } = await suggestReplayPoints({
			cases: await readReplayCases(directory), labels: await readAnnotations(directory),
			loadBranch: (sessionId) => loadBranch(index, sessionId),
			limit: Number(text(args, "limit") ?? 20),
		});
		const saved = await writeSuggestions(directory, items);
		if (flag(args, "json")) out(JSON.stringify({ path: saved.path, items, stale }));
		else {
			if (!items.length) out(COPY.suggestEmpty);
			if (stale.length) out(`${stale.length} 个会话已有回放点，未重复建议。`);
			for (const item of items) {
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
		const branch = await loadBranch(index, sessionId);
		if (!cutEntries(branch, entryId)) { err(`${entryId} 不是可用的 assistant 截断点`); return { exitCode: 2 }; }
		const existing = (await readReplayCases(directory)).find((item) => item.sessionId === sessionId && item.cutEntryId === entryId);
		if (existing) { err(COPY.addExists(existing.key)); return { exitCode: 2 }; }
		const saved = await writeReplayCase(directory, { sessionId, cutEntryId: entryId, expected, check }, sessionSha256(await readFile(path, "utf8")));
		out(COPY.addSaved(saved.key));
		return { exitCode: 0, case: saved.key };
	}

	err(`未知命令 ${command}`);
	out(COPY.usage);
	return { exitCode: 2 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().then((result) => { process.exitCode = result.exitCode ?? 0; })
		.catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
}
