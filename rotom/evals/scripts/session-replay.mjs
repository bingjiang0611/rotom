#!/usr/bin/env node
// Session replay runner.
//
// Reads replay points from the dashboard's private eval directory, cuts each
// session at its pinned message, and asks a product build for the next assistant
// message only. Every tool call is blocked, so a replay records the *decision* to
// call a tool and never touches a real workspace.
//
// Usage:
//   node session-replay.mjs --product=<dir> --arm=candidate --model=provider/id \
//     [--arm-baseline=<dir>] [--repeats=1] [--cases=<id,id>] [--frozen=<file>] [--day=YYYY-MM-DD]
//     [--extension=<file>] [--dry-run] [--json]
import { lstat, mkdtemp, readFile, realpath, access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assistantMessageOf, readReplayCases, replayCaseInput, replayCaseKey, replayConclusions, REPLAY_SESSION_MAX_BYTES, REPLAY_TOOL_BLOCK_REASON, runReplayPlan, sessionSha256 } from "../../extensions/observability/eval/replay.mjs";
import { loadSession } from "../../extensions/observability/eval/session-data.mjs";
import { redactSecrets } from "../../extensions/observability/eval/redaction.mjs";
import { loadReplayProduct, openReplaySession, removeScratch } from "../src/replay-session.ts";

export function parseArgs(argv) {
	const args = { repeats: 1 };
	for (const item of argv) {
		const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(item);
		if (!match) throw new Error(`Unknown argument: ${item}`);
		const [, name, value] = match;
		if (name === "dry-run" || name === "json") args[name === "dry-run" ? "dryRun" : "json"] = true;
		else if (name === "arm-baseline") args.armBaseline = value;
		else if (["product", "arm", "model", "cases", "day", "extension", "sessions", "directory", "thinking", "pi", "paths", "frozen"].includes(name)) args[name === "thinking" ? "thinkingLevel" : name] = value;
		else if (name === "repeats") args.repeats = Math.min(Math.max(Number(value) || 1, 1), 3);
		else throw new Error(`Unknown argument: ${item}`);
	}
	for (const required of ["product", "model"]) if (!args[required]) throw new Error(`Missing --${required}`);
	if (!["baseline", "candidate"].includes(args.arm ?? "candidate")) throw new Error("--arm must be baseline or candidate");
	args.arm ??= "candidate";
	return args;
}

/** Session files are read from the dashboard's session root, never from a worktree. */
export async function loadReplaySession(sessionsRoot, sessionId, paths = {}) {
	const summary = { badJson: 0, lineTooLong: 0 };
	const path = paths[sessionId] ?? join(sessionsRoot, `${sessionId}.jsonl`);
	const loaded = await loadSession(path, summary, new Set(), REPLAY_SESSION_MAX_BYTES);
	if (loaded.reason || !loaded.branch) throw new Error(`cannot read session ${sessionId}: ${loaded.reason ?? "no branch"}`);
	const { readFile } = await import("node:fs/promises");
	return { branch: loaded.branch, content: await readFile(path, "utf8") };
}

import { usageOf } from "../../extensions/observability/eval/judge.mjs";
import { replayJudgeContext, REPLAY_JUDGE_BUDGET_CHARS, REPLAY_JUDGE_PROMPT_VERSION } from "../../extensions/observability/eval/replay-judge.mjs";

export { blockerSource as blockerExtension } from "../src/replay-session.ts";

/**
 * One generator per arm. The product (extensions, guidelines, tools) is loaded
 * once per arm, but every generation gets its own scratch tree and session, so a
 * later replay can never run without the tool blocker in place.
 */
export async function createGenerator({ productAgentDir, model, thinkingLevel, piExecutable, extensions = [], excludedResourceKeys, cwd, loadProduct = loadReplayProduct }) {
	const product = await loadProduct({ productAgentDir, piExecutable, excludedResourceKeys });
	const [provider, id] = String(model).split("/");
	if (!provider || !id) throw new Error(`model must be provider/id, got ${model}`);
	/** Exposed on the function so a caller does not load the same product twice. */
	const generate = async ({ entries }) => {
		const scratch = await realpath(await mkdtemp(join(tmpdir(), "rotom-replay-gen-")));
		let opened;
		try {
			opened = await openReplaySession({ product, model: { provider, id }, thinkingLevel, entries, scratch, extensions, cwd });
			const result = await opened.run();
			// Usage comes from the generated assistant message, in the same shape the
			// judge records; a missing usage stays unknown instead of becoming zero.
			return { message: result.message, usage: usageOf(result.message), elapsedMs: result.elapsedMs, productDigest: product.digest };
		} finally {
			await opened?.close?.();
			await removeScratch(scratch);
		}
	};
	generate.productDigest = product.digest;
	return generate;
}

/** Model verdict for mode=model points; reuses the background judge prompt pipeline. */
export async function createModelJudge({ model, launcher: launcherPath = undefined, timeoutMs = 180_000, budgetChars = REPLAY_JUDGE_BUDGET_CHARS }) {
	const judge = await import("../../extensions/observability/eval/judge.mjs");
	const { executeProcessTreeV1 } = await import("../../runtime/process-tree.mjs");
	return async ({ item, reply, entries }) => {
		// Same renderer and budget the confirmation dialog measured, so the number
		// the person approved is the number of characters the judge receives.
		const context = replayJudgeContext(entries, budgetChars);
		const prompt = [
			`版本：${REPLAY_JUDGE_PROMPT_VERSION}`,
			"你在评审一次会话回放：会话被截断在某个 assistant 消息之前，产品重新生成了下一步。",
			`期望行为：${redactSecrets(item.expected).text}`,
			`截断点之前的上下文（已脱敏，只含可读内容）：\n${context.text}`,
			`新的下一步：文本=${JSON.stringify(reply.text.slice(0, 2000))} 工具意图=${JSON.stringify(reply.toolCalls.slice(0, 5))}`,
			'只输出 JSON：{"verdict":"pass|fail|unknown","reason":"一句话"}',
		].join("\n\n");
		const started = Date.now();
		// rotom-launcher is a shell script: run it directly, never through node.
		const launcher = await realpath(launcherPath ?? judge.JUDGE_LAUNCHER);
		const info = await lstat(launcher);
		await access(launcher, constants.X_OK);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("judge launcher is not a regular file");
		const judgeCwd = await mkdtemp(join(tmpdir(), "rotom-replay-judge-"));
		let output;
		try {
			output = await executeProcessTreeV1(launcher, [...judge.JUDGE_BASE_ARGS, "--model", model], { cwd: judgeCwd, env: judge.childEnvironment(), stdin: prompt, timeoutMs, maxOutputBytes: judge.JUDGE_MAX_OUTPUT_BYTES });
		} finally {
			if (output?.terminal?.confirmed !== false) await removeScratch(judgeCwd);
		}
		if (output.code !== 0) return { verdict: "unknown", reason: `judge_exited_${output.code}` };
		const parsed = judge.parseJudgeEvents(output.stdout, new Set());
		const text = parsed.result ? JSON.stringify(parsed.result) : String(parsed.rawOutput ?? "");
		const match = /\{[\s\S]*\}/u.exec(text);
		if (!match) return { verdict: "unknown", reason: "judge_output_unparseable" };
		try {
			const value = JSON.parse(match[0]);
			const verdict = ["pass", "fail", "unknown"].includes(value.verdict) ? value.verdict : "unknown";
			// The original arm stores only the judge's own usage, so it must travel here.
			return { verdict, reason: String(value.reason ?? "").slice(0, 300), elapsedMs: Date.now() - started, usage: parsed.usage ?? usageOf(null) };
		} catch { return { verdict: "unknown", reason: "judge_json_invalid" }; }
	};
}

/** Frozen point records, validated the same way the private store validates them. */
async function readFrozenCases(path) {
	const row = JSON.parse(await readFile(path, "utf8"));
	if (row?.schema !== "rotom-replay-frozen/v1" || !Array.isArray(row.cases)) throw new Error("invalid frozen set");
	if (row.judgePromptVersion !== REPLAY_JUDGE_PROMPT_VERSION) throw new Error("judge prompt version changed since the set was frozen");
	return row.cases.map((item) => {
		const value = replayCaseInput({ sessionId: item.sessionId, cutEntryId: item.cutEntryId, expected: item.expected, check: item.check });
		if (!/^[0-9a-f]{64}$/u.test(item.sessionSha256 ?? "")) throw new Error("invalid frozen point digest");
		return { ...value, key: replayCaseKey(value.sessionId, value.cutEntryId), sessionSha256: item.sessionSha256 };
	});
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const directory = args.directory ?? join(process.env.HOME ?? tmpdir(), ".rotom", "evals");
	const sessionsRoot = args.sessions ?? join(process.env.HOME ?? tmpdir(), ".pi", "agent", "sessions");
	const wanted = args.cases ? new Set(args.cases.split(",").map((item) => item.trim()).filter(Boolean)) : undefined;
	// The dashboard resolves each session file (real sessions live in nested
	// project folders); a bare id would otherwise point at a path that is not there.
	const paths = args.paths ? JSON.parse(args.paths) : {};
	// `--frozen` makes the caller's frozen records the input: a point edited after it
	// was frozen must not change what this run replays.
	const cases = args.frozen ? await readFrozenCases(args.frozen) : (await readReplayCases(directory)).filter((item) => !wanted || wanted.has(item.key) || wanted.has(item.sessionId));
	if (!cases.length) throw new Error("no replay points selected");
	const armList = args.arm === "baseline" ? [{ name: "baseline", product: args.armBaseline ?? args.product }] : [{ name: "candidate", product: args.product }, ...(args.armBaseline ? [{ name: "baseline", product: args.armBaseline }] : [])];
	if (args.dryRun) {
		// Count what will actually be sent: the truncated prefix after redaction,
		// not just the expected-behaviour text.
		const { measureReplayPlan } = await import("../../extensions/observability/eval/replay-plan.mjs");
		const { cutEntries } = await import("../../extensions/observability/eval/replay.mjs");
		const items = [];
		for (const item of cases) {
			const source = await loadReplaySession(sessionsRoot, item.sessionId, paths);
			items.push({ key: item.key, check: item.check, entries: cutEntries(source.branch, item.cutEntryId)?.entries ?? [] });
		}
		const plan = measureReplayPlan({ items, repeats: args.repeats, arms: armList.length });
		return {
			dryRun: true, cases: cases.length, arms: armList.map((arm) => arm.name), repeats: plan.repeats, runs: plan.runs,
			expectedChars: cases.reduce((total, item) => total + item.expected.length, 0),
			context: { perCaseChars: plan.perCaseChars, maxChars: plan.maxChars, totalChars: plan.totalChars, redactionTotal: plan.redactionTotal },
		};
	}
	// One empty workspace per run: the replay must never see the private eval
	// directory or a real project as its cwd.
	const workspace = await mkdtemp(join(tmpdir(), "rotom-replay-cwd-"));
	const extensions = args.extension ? String(args.extension).split(",").map((item) => item.trim()).filter(Boolean) : [];
	const generators = new Map(), digests = new Map();
	for (const arm of armList) {
		const generate = await createGenerator({ productAgentDir: arm.product, model: args.model, thinkingLevel: args.thinkingLevel, piExecutable: args.pi, extensions, cwd: workspace });
		generators.set(arm.name, generate);
		digests.set(arm.name, generate.productDigest);
	}
	const judgeModel = cases.some((item) => item.check.mode === "model") ? await createModelJudge({ model: args.model }) : undefined;
	const cache = new Map();
	const results = await runReplayPlan({
		directory, day: args.day ?? new Date().toISOString().slice(0, 10), cases, arms: armList.map((arm) => arm.name), repeats: args.repeats,
		sessionOf: async (item) => {
			if (!cache.has(item.sessionId)) cache.set(item.sessionId, await loadReplaySession(sessionsRoot, item.sessionId, paths));
			const source = cache.get(item.sessionId);
			const { replaySource } = await import("../../extensions/observability/eval/replay.mjs");
			return replaySource({ branch: source.branch, sessionContent: source.content, expectedSha256: item.sessionSha256, cutEntryId: item.cutEntryId });
		},
		generate: async ({ entries, arm }) => generators.get(arm)({ entries }),
		judgeModel,
		productDigests: Object.fromEntries(digests),
		// Progress goes to stdout so the dashboard can show it without parsing logs.
		onRun: (progress) => process.stdout.write(JSON.stringify({ progress }) + "\n"),
	});
	await removeScratch(workspace);
	const arms = Object.fromEntries(digests);
	// Same digest on both arms means the baseline is not a different product, so
	// any difference between arms would be noise. Say so instead of letting the
	// numbers look like a comparison.
	const warnings = new Set(Object.values(arms)).size === 1 && Object.keys(arms).length > 1 ? ["baseline_product_matches_candidate"] : [];
	return {
		arms, warnings,
		// The label per point is computed from the rows just written, by the same
		// function the dashboard list uses.
		conclusions: replayConclusions(results),
		runs: results.map((row) => ({ key: row.key, arm: row.arm, repetition: row.repetition, verdict: row.verdict, reason: row.reason, checkMode: row.checkMode, judgePromptVersion: row.judgePromptVersion, sameProduct: row.sameProduct, usage: row.usage })),
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// One line: the dashboard reads JSONL, so an indented object would be dropped.
	main().then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); })
		.catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
