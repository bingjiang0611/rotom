// Session replay: turn a reviewed failure into a re-runnable next step.
//
// A replay point pins one assistant message in a session ("the step that went
// wrong") together with what should have happened. Replaying takes the branch up
// to that message's parent, asks a product build to produce the next assistant
// message only, and judges it. Tools are never executed: the real workspace has
// moved on, so a replay judges the *decision* to call a tool, not its effect.
//
// Private by construction: cases and run records live under the dashboard's
// private eval directory (never a Git worktree), and the domain code here is
// plain data handling so it can be unit-tested without a model.
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertPrivatePath, readPrivate, validSessionId } from "./annotations.mjs";
import { privateWrite, statIfPresent } from "./session-data.mjs";
import { REPLAY_JUDGE_PROMPT_VERSION } from "./replay-judge.mjs";

export const REPLAY_CASE_SCHEMA = "rotom-replay-case/v1";
export const REPLAY_RUN_SCHEMA = "rotom-replay-run/v1";
// The judge input renderer and its version live together; re-exported because the
// run record stamps the version next to each model verdict.
export { REPLAY_JUDGE_PROMPT_VERSION };
/** Tool calls that gather information; a replay must not open with a write. */
export const QUERY_TOOLS = new Set(["bash", "read", "grep", "glob", "ls", "find"]);
export const REPLAY_RULES = ["checks-before-claiming", "no-identical-retry", "nonempty-handoff"];
/**
 * Sessions are read whole before the cut is taken, and a long real session is
 * easily 20 MB, so the eval tab's small-project cap would refuse them all.
 */
export const REPLAY_SESSION_MAX_BYTES = 128 * 1024 * 1024;
export const REPLAY_TOOL_BLOCK_REASON = "replay: tools are not executed";

export function replayRoot(directory) { return join(directory, "replay"); }
export function replayCasesDir(directory) { return join(replayRoot(directory), "cases"); }
export function replayRunsDir(directory, day) { return join(replayRoot(directory), "runs", day); }
export function replayCaseKey(sessionId, cutEntryId) { return `${sessionId}-${cutEntryId}`; }

function validEntryId(id) {
	return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 200 && !/[/\\\u0000-\u001f\u007f]/u.test(id) && !id.includes("..");
}

/** Reject a path that resolves outside the replay root, e.g. through a symlinked parent. */
export function assertInsideReplay(directory, path) {
	const root = resolve(replayRoot(directory)) + sep;
	if (!resolve(path).startsWith(root)) throw new Error("Path escapes replay storage");
}

export function replayCaseInput(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid replay case");
	const keys = Object.keys(input);
	if (keys.some((key) => !["sessionId", "cutEntryId", "expected", "check", "createdAt", "sessionSha256"].includes(key))) throw new Error("Invalid replay case");
	if (!validSessionId(input.sessionId) || !validEntryId(input.cutEntryId)) throw new Error("Invalid replay case");
	if (typeof input.expected !== "string" || !input.expected.trim()) throw new Error("Invalid replay case");
	const expected = Array.from(input.expected.trim()).slice(0, 400).join("");
	const check = input.check;
	const mode = check?.mode;
	if (mode === "rule" && REPLAY_RULES.includes(check?.rule) && Object.keys(check).length === 2) return { sessionId: input.sessionId, cutEntryId: input.cutEntryId, expected, check: { mode, rule: check.rule } };
	if (mode === "model" && Object.keys(check ?? {}).length === 1) return { sessionId: input.sessionId, cutEntryId: input.cutEntryId, expected, check: { mode } };
	throw new Error("Invalid replay case");
}

export function sessionSha256(content) { return createHash("sha256").update(content).digest("hex"); }

/** Move the cut to its parent: entries strictly before the pinned assistant message. */
export function cutEntries(branch, cutEntryId) {
	const index = branch.findIndex((entry) => entry?.id === cutEntryId);
	if (index < 0) return undefined;
	if (branch[index]?.type !== "message" || branch[index]?.message?.role !== "assistant") return undefined;
	return { entries: branch.slice(0, index), pinned: branch[index] };
}

/** The last failed tool call before the cut; `no-identical-retry` compares against it. */
export function lastFailedCall(entries) {
	let found;
	for (const entry of entries) {
		const message = entry?.message;
		if (entry?.type !== "message" || !message) continue;
		if (message.role === "toolResult" && message.isError === true) {
			const call = [...entries].reverse().map((row) => row?.message).find((row) => row?.role === "assistant" && (row.content ?? []).some((part) => part.type === "toolCall" && part.id === message.toolCallId));
			const part = (call?.content ?? []).find((item) => item.type === "toolCall" && item.id === message.toolCallId);
			if (part) found = { name: part.name, args: part.arguments ?? {} };
		}
	}
	return found;
}

export function assistantMessageOf(message) {
	const text = (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
	const toolCalls = (message?.content ?? []).filter((part) => part.type === "toolCall").map((part) => ({ name: part.name, args: part.arguments ?? {} }));
	return { text, toolCalls };
}

function sameCall(a, b) { return a?.name === b?.name && JSON.stringify(a?.args ?? {}) === JSON.stringify(b?.args ?? {}); }

/** Progress or next-step wording; shared with the behavioural case judge in spirit. */
export function statesProgressOrNext(text) {
	const zh = /完成|已|改|查|看|读了|剩下|还剩|未|没|下一步|接下来|建议|需要|继续|请/u;
	const en = /\b(done|read|checked|still|remain|next|continue|need|should|send|let me|i'll)\b/iu;
	return zh.test(text) || en.test(text);
}

/**
 * Rule verdicts. Each rule returns pass/fail with a short reason; a rule that
 * cannot decide returns unknown rather than guessing.
 */
export function ruleVerdict(rule, { reply, lastFailed }) {
	if (rule === "checks-before-claiming") {
		if (!reply.toolCalls.length) return { verdict: "fail", reason: "no tool call before concluding" };
		const query = reply.toolCalls.find((call) => QUERY_TOOLS.has(call.name));
		return query ? { verdict: "pass", reason: `queried with ${query.name}` } : { verdict: "fail", reason: `acted with ${reply.toolCalls[0]?.name} before querying` };
	}
	if (rule === "no-identical-retry") {
		if (!lastFailed) return { verdict: "unknown", reason: "no failed call before the cut" };
		const repeat = reply.toolCalls.find((call) => sameCall(call, lastFailed));
		return repeat ? { verdict: "fail", reason: `repeated ${repeat.name} with identical arguments` } : { verdict: "pass", reason: "no identical retry" };
	}
	if (rule === "nonempty-handoff") {
		if (!reply.text) return { verdict: "fail", reason: "empty reply" };
		return statesProgressOrNext(reply.text) ? { verdict: "pass", reason: "states progress or next step" } : { verdict: "fail", reason: "reply says nothing about progress or next step" };
	}
	return { verdict: "unknown", reason: "unknown rule" };
}

/** The arm that re-grades the pinned reply; it never generates anything. */
export const REPLAY_ORIGINAL_ARM = "original";

/**
 * What one replay point proves, judged from the original reply and the new one.
 * `judge-blind` is the important one: the pinned reply did not fail the check, so
 * the point cannot show improvement whatever the candidate does.
 */
export function replayConclusion({ original, candidate }) {
	if (!original || !candidate) return "unknown";
	if (original.verdict === "unknown" || candidate.verdict === "unknown") return "unknown";
	if (original.verdict === "pass") return "judge-blind";
	return candidate.verdict === "pass" ? "caught" : "still-failing";
}

async function ensurePrivate(folder) {
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	await chmod(folder, 0o700);
}

export async function readReplayCases(directory) {
	const folder = replayCasesDir(directory);
	await assertPrivatePath(folder);
	if (!(await statIfPresent(folder))) return [];
	const rows = [];
	for (const name of (await readdir(folder)).sort()) {
		if (!name.endsWith(".json")) continue;
		const row = JSON.parse(await readPrivate(join(folder, name), 16_384));
		if (row.schema !== REPLAY_CASE_SCHEMA) throw new Error("Invalid replay case");
		const value = replayCaseInput({ sessionId: row.sessionId, cutEntryId: row.cutEntryId, expected: row.expected, check: row.check });
		if (name !== `${replayCaseKey(value.sessionId, value.cutEntryId)}.json`) throw new Error("Replay case identity mismatch");
		if (typeof row.sessionSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.sessionSha256)) throw new Error("Invalid replay case digest");
		if (!Number.isFinite(Date.parse(row.createdAt))) throw new Error("Invalid replay case timestamp");
		rows.push({ ...value, createdAt: row.createdAt, sessionSha256: row.sessionSha256, key: replayCaseKey(value.sessionId, value.cutEntryId) });
	}
	return rows;
}

export async function writeReplayCase(directory, input, sessionSha256Value) {
	const value = replayCaseInput(input);
	if (typeof sessionSha256Value !== "string" || !/^[0-9a-f]{64}$/u.test(sessionSha256Value)) throw new Error("Invalid replay case digest");
	const folder = replayCasesDir(directory);
	await ensurePrivate(folder);
	const target = join(folder, `${replayCaseKey(value.sessionId, value.cutEntryId)}.json`);
	await assertPrivatePath(target);
	const row = { schema: REPLAY_CASE_SCHEMA, ...value, createdAt: input.createdAt ?? new Date().toISOString(), sessionSha256: sessionSha256Value };
	await privateWrite(target, JSON.stringify(row) + "\n");
	return { ...row, key: replayCaseKey(value.sessionId, value.cutEntryId) };
}

export async function deleteReplayCase(directory, sessionId, cutEntryId) {
	if (!validSessionId(sessionId) || !validEntryId(cutEntryId)) throw new Error("Invalid replay case");
	const target = join(replayCasesDir(directory), `${replayCaseKey(sessionId, cutEntryId)}.json`);
	assertInsideReplay(directory, target);
	await assertPrivatePath(target);
	await rm(target, { force: true });
	return { deleted: true };
}

/**
 * Load the branch a replay starts from. The digest check is what makes a replay
 * honest: a session that changed after the point was pinned cannot be replayed
 * against the same cut, so it is `unknown: source_changed`, never a guess.
 */
export function replaySource({ branch, sessionContent, expectedSha256, cutEntryId }) {
	if (sessionSha256(sessionContent) !== expectedSha256) return { status: "unknown", reason: "source_changed" };
	const cut = cutEntries(branch, cutEntryId);
	if (!cut) return { status: "unknown", reason: "cut_not_found" };
	return { status: "ready", entries: cut.entries, pinned: cut.pinned, lastFailed: lastFailedCall(cut.entries) };
}

/**
 * Grade one reply. The original arm goes through this same function, so a point
 * cannot be scored by a different rule or a different judge prompt than the one
 * that scored its candidate.
 */
async function gradeReply({ item, reply, lastFailed, judgeModel, entries }) {
	// A rule point is scored by its rule and nothing leaves the machine; only a
	// model point sends the judge input. One check per point, as the panel says.
	if (item.check.mode === "rule") return { verdict: ruleVerdict(item.check.rule, { reply, lastFailed }), usage: null, elapsedMs: null };
	const model = judgeModel ? await judgeModel({ item, reply, entries }) : undefined;
	return { verdict: model ?? { verdict: "unknown", reason: "model judge unavailable" }, usage: model?.usage ?? null, elapsedMs: model?.elapsedMs ?? null };
}

/** Run one replay point across arms and repetitions with injected model calls. */
export async function runReplayPlan({ directory, day, cases, arms, repeats = 1, sessionOf, generate, judgeModel, onRun, now = () => new Date(), productDigests }) {
	if (!Array.isArray(arms) || arms.length === 0) throw new Error("At least one arm is required");
	// Two arms can only be compared when their product surfaces differ. Stamping
	// the rows keeps that visible later: "baseline" that loads the same product is
	// a mistake, not a result.
	const sameProduct = productDigests && Object.keys(productDigests).length > 1
		? new Set(Object.values(productDigests)).size === 1
		: null;
	const count = Math.min(Math.max(Number(repeats) || 1, 1), 3);
	// The original arm runs once per point: it grades a stored reply, so repeating
	// it would only re-bill the judge for the same answer.
	const total = cases.length * (arms.length * count + 1);
	const folder = replayRunsDir(directory, day);
	await ensurePrivate(folder);
	const results = [];
	const progress = (key) => onRun?.({ done: results.length, total, key });
	for (const item of cases) {
		const source = await sessionOf(item);
		// Original arm first: it is the control that says whether the point can
		// show anything at all, and it costs one judge call rather than a run.
		const originalStartedAt = now().toISOString();
		if (source.status !== "ready") {
			results.push(await persist({ folder, item, arm: REPLAY_ORIGINAL_ARM, repetition: 1, startedAt: originalStartedAt, verdict: { verdict: "unknown", reason: source.reason }, checkMode: item.check.mode }));
		} else {
			const originalReply = assistantMessageOf(source.pinned?.message);
			const graded = await gradeReply({ item, reply: originalReply, lastFailed: source.lastFailed, judgeModel, entries: source.entries });
			results.push(await persist({ folder, item, arm: REPLAY_ORIGINAL_ARM, repetition: 1, startedAt: originalStartedAt, verdict: graded.verdict, checkMode: item.check.mode, reply: originalReply, usage: graded.usage, elapsedMs: graded.elapsedMs }));
		}
		progress(item.key);
		for (const arm of arms) {
			for (let repetition = 1; repetition <= count; repetition += 1) {
				const startedAt = now().toISOString();
				if (source.status !== "ready") {
					results.push(await persist({ folder, item, arm, repetition, startedAt, sameProduct, verdict: { verdict: "unknown", reason: source.reason }, checkMode: item.check.mode }));
					progress(item.key);
					continue;
				}
				let message;
				try {
					message = await generate({ entries: source.entries, arm, repetition, case: item });
				} catch (error) {
					results.push(await persist({ folder, item, arm, repetition, startedAt, sameProduct, verdict: { verdict: "unknown", reason: `generation_failed: ${error instanceof Error ? error.message : String(error)}` }, checkMode: item.check.mode }));
					progress(item.key);
					continue;
				}
				const reply = assistantMessageOf(message.message ?? message);
				const graded = await gradeReply({ item, reply, lastFailed: source.lastFailed, judgeModel, entries: source.entries });
				results.push(await persist({ folder, item, arm, repetition, startedAt, sameProduct, verdict: graded.verdict, checkMode: item.check.mode, reply, message: message.message ?? message, usage: message.usage ?? graded.usage, elapsedMs: message.elapsedMs, productDigest: message.productDigest }));
			}
			progress(item.key);
		}
	}
	return results;
}

/** Per-point conclusion from the rows of one run; `candidate` is the product arm. */
export function replayConclusions(results) {
	const byKey = new Map();
	for (const row of results) {
		const entry = byKey.get(row.key) ?? {};
		// Repetitions: the first is enough to label a point; later ones are shown
		// as separate rows, not averaged into a label that hides a flaky failure.
		if (!entry[row.arm]) entry[row.arm] = row;
		byKey.set(row.key, entry);
	}
	return [...byKey].map(([key, arms]) => ({ key, conclusion: replayConclusion({ original: arms[REPLAY_ORIGINAL_ARM], candidate: arms.candidate }) }));
}

async function persist({ folder, item, arm, repetition, startedAt, verdict, checkMode, reply, message, usage, elapsedMs, productDigest, sameProduct = null }) {
	const name = `${item.key ?? replayCaseKey(item.sessionId, item.cutEntryId)}-${arm}-${repetition}.json`;
	const target = join(folder, name);
	await assertPrivatePath(target);
	const row = {
		schema: REPLAY_RUN_SCHEMA, key: item.key ?? replayCaseKey(item.sessionId, item.cutEntryId), sessionId: item.sessionId,
		cutEntryId: item.cutEntryId, arm, repetition, checkMode, rule: item.check.rule ?? null,
		verdict: verdict.verdict, reason: verdict.reason, judgePromptVersion: checkMode === "model" ? REPLAY_JUDGE_PROMPT_VERSION : null,
		startedAt, finishedAt: new Date().toISOString(), elapsedMs: elapsedMs ?? null,
		reply: reply ? { text: reply.text.slice(0, 8000), toolCalls: reply.toolCalls.map((call) => ({ name: call.name, args: call.args })) } : null,
		usage: usage ?? null,
		productDigest: typeof productDigest === "string" ? productDigest : null,
		sameProduct,
	};
	await privateWrite(target, JSON.stringify(row) + "\n");
	return { ...row, path: target };
}

/** Latest run per replay point and arm, for the dashboard list. */
export async function readReplayRuns(directory) {
	const root = join(replayRoot(directory), "runs");
	await assertPrivatePath(root);
	if (!(await statIfPresent(root))) return new Map();
	// Keyed by point, then by arm: one point now has an original control and one
	// row per product, and dropping any of them would hide the comparison.
	const latest = new Map();
	for (const day of (await readdir(root)).sort()) {
		const folder = join(root, day);
		if (!(await statIfPresent(folder))) continue;
		for (const name of (await readdir(folder)).sort()) {
			if (!name.endsWith(".json")) continue;
			const row = JSON.parse(await readPrivate(join(folder, name), 262_144));
			if (row.schema !== REPLAY_RUN_SCHEMA) throw new Error("Invalid replay run");
			if (![REPLAY_ORIGINAL_ARM, "candidate", "baseline"].includes(row.arm)) throw new Error("Invalid replay run arm");
			const arms = latest.get(row.key) ?? {};
			const current = arms[row.arm];
			if (!current || String(row.finishedAt) > String(current.finishedAt)) arms[row.arm] = row;
			latest.set(row.key, arms);
		}
	}
	return latest;
}
