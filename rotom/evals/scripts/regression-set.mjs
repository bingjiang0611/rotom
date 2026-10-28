// Failure set → local regression set.
//
// A regression set freezes the replay points a person already reviewed, so a newer
// agent build can be checked against the build it is meant to replace. Freezing is
// the point: a session that changed after review is reported as invalid instead of
// being silently re-anchored, and a run names the exact set, models and products it
// compared.
//
// This module is pure local logic: it reads private eval storage, never calls a
// model, and knows nothing about the CLI. The product's npm package deliberately
// excludes `evals/`, so nothing here is a runtime resource.
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertPrivatePath, readAnnotations, readPrivate, validSessionId } from "../../extensions/observability/eval/annotations.mjs";
import { replayRoot, REPLAY_JUDGE_PROMPT_VERSION, assistantMessageOf, readReplayCases, replayCaseInput, replayCaseKey, replaySource } from "../../extensions/observability/eval/replay.mjs";
import { redactSecrets } from "../../extensions/observability/eval/redaction.mjs";
import { privateWrite, readBounded, statIfPresent } from "../../extensions/observability/eval/session-data.mjs";

export const REGRESSION_SET_SCHEMA = "rotom-replay-set/v1";
export const REGRESSION_REPORT_SCHEMA = "rotom-replay-report/v1";
export const SELECTORS = ["all", "fail", "failSet"];
/** A point's arm is compared through this many repetitions at most. */
export const MAX_SET_REPEATS = 3;
const MAX_SET_BYTES = 1_048_576;
const MAX_INDEX_ENTRIES = 20_000;
const HEADER_BYTES = 1_048_576;
const SUGGESTION_EXCERPT_CHARS = 160;

/** Wording that usually marks a correction; only ever a hint for a person to confirm. */
const CORRECTION = /不对|错了|还是(?:不行|报错|失败|没|不|会)|没(?:看到|有(?:生效|改|完成|变化))|不能|不满意|重新做|再试|又(?:错|出现|失败|报)|仍未|依然|怎么还|没有解决|still (?:failing|broken|wrong)|not working|didn't work|doesn't work/iu;

export function setsDir(directory) { return join(replayRoot(directory), "sets"); }
export function reportsDir(directory) { return join(replayRoot(directory), "reports"); }
export function suggestionsDir(directory) { return join(replayRoot(directory), "suggestions"); }

function validName(name) { return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(name); }

/** The set path is always inside the private sets directory; a name cannot escape it. */
export function regressionSetPath(directory, name) {
	if (!validName(name)) throw new Error("invalid_set_name");
	return join(setsDir(directory), `${name}.json`);
}

/** Resolve `--set`: a name under the sets directory, or an absolute file inside it. */
export function resolveSetPath(directory, value) {
	if (validName(value)) return regressionSetPath(directory, value);
	const root = resolve(setsDir(directory)) + sep, path = resolve(value ?? "");
	if (!path.startsWith(root)) throw new Error("set_outside_private_storage");
	return path;
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}

export function regressionSetDigest(set) {
	const { digest: _ignored, ...payload } = set ?? {};
	return createHash("sha256").update(canonical({ schema: set?.schema, name: set?.name, selector: set?.selector, repeats: set?.repeats, cases: set?.cases, excluded: set?.excluded, scan: set?.scan })).digest("hex");
}

/** Which saved replay points belong in the set. Explicit keys win over a selector. */
export function selectReplayCases(cases, labels, selector = "all") {
	if (Array.isArray(selector?.cases)) {
		const wanted = selector.cases.map(String);
		const missing = wanted.filter((key) => !cases.some((item) => item.key === key || item.sessionId === key));
		// A point that was deleted must fail loudly: dropping it would shrink the set
		// behind the person's back.
		if (missing.length) throw new Error(`unknown_replay_point: ${missing.join(",")}`);
		return cases.filter((item) => wanted.includes(item.key) || wanted.includes(item.sessionId));
	}
	const kind = selector?.kind ?? selector ?? "all";
	if (!SELECTORS.includes(kind) || typeof kind !== "string") throw new Error("invalid_selector");
	if (kind === "all") return [...cases];
	return cases.filter((item) => labels.get(item.sessionId)?.verdict === "fail" && (kind === "fail" || labels.get(item.sessionId)?.failSet === true));
}

/**
 * Freeze the selected points. Every point is re-read here: its session must still
 * hash to the recorded digest and still contain the pinned assistant message, so a
 * set never claims a cut the session no longer has.
 */
export async function buildRegressionSet({ directory, name, selector = "all", repeats = 1, resolveSource, labels, cases, indexComplete = true, now = () => new Date() }) {
	if (!validName(name)) throw new Error("invalid_set_name");
	const saved = cases ?? await readReplayCases(directory);
	const annotations = labels ?? await readAnnotations(directory);
	const selected = selectReplayCases(saved, annotations, selector);
	const included = [], excluded = [], seen = new Set();
	for (const item of selected) {
		if (seen.has(item.key)) { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: "duplicate_point" }); continue; }
		seen.add(item.key);
		const value = replayCaseInput({ sessionId: item.sessionId, cutEntryId: item.cutEntryId, expected: item.expected, check: item.check });
		let source;
		try { source = await resolveSource(item); }
		catch (error) { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: `session_unreadable: ${message(error)}` }); continue; }
		const frozen = replaySource({ branch: source.branch, sessionContent: source.content, expectedSha256: item.sessionSha256, cutEntryId: item.cutEntryId });
		if (frozen.status !== "ready") { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: frozen.reason }); continue; }
		included.push({
			key: item.key, sessionId: value.sessionId, cutEntryId: value.cutEntryId, sessionSha256: item.sessionSha256,
			expected: value.expected, check: value.check,
			judgePromptVersion: value.check.mode === "model" ? REPLAY_JUDGE_PROMPT_VERSION : null,
		});
	}
	const scan = { replayPoints: saved.length, selected: selected.length, included: included.length, excluded: excluded.length, indexComplete: indexComplete === true };
	const set = {
		schema: REGRESSION_SET_SCHEMA, name, createdAt: now().toISOString(), selector: Array.isArray(selector?.cases) ? { cases: selector.cases.map(String) } : { kind: selector?.kind ?? selector ?? "all" },
		repeats: Math.min(Math.max(Number(repeats) || 1, 1), MAX_SET_REPEATS), cases: included, excluded, scan,
	};
	return { ...set, digest: regressionSetDigest(set) };
}

async function ensurePrivate(folder) {
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	await chmod(folder, 0o700);
}

/** Write the set; an existing set is only replaced when the caller says so. */
export async function writeRegressionSet(directory, set, { overwrite = false } = {}) {
	const expected = regressionSetDigest(set);
	if (expected !== set.digest) throw new Error("set_digest_mismatch");
	const path = regressionSetPath(directory, set.name);
	await ensurePrivate(setsDir(directory));
	await assertPrivatePath(path);
	if (!overwrite && await statIfPresent(path)) throw new Error("set_exists");
	await privateWrite(path, JSON.stringify(set) + "\n");
	return { ...set, path };
}

export async function readRegressionSet(directory, value) {
	const path = resolveSetPath(directory, value);
	await assertPrivatePath(path);
	const info = await statIfPresent(path);
	if (!info?.isFile()) throw new Error("set_not_found");
	const row = JSON.parse(await readPrivate(path, MAX_SET_BYTES));
	if (row.schema !== REGRESSION_SET_SCHEMA || !validName(row.name) || !Array.isArray(row.cases) || !Array.isArray(row.excluded)) throw new Error("invalid_set");
	// The digest covers exactly the fields a run depends on, so an edited set is
	// rejected instead of quietly changing what gets replayed.
	if (regressionSetDigest(row) !== row.digest) throw new Error("set_digest_mismatch");
	const seen = new Set();
	for (const item of row.cases) {
		const value = replayCaseInput({ sessionId: item.sessionId, cutEntryId: item.cutEntryId, expected: item.expected, check: item.check });
		if (replayCaseKey(value.sessionId, value.cutEntryId) !== item.key) throw new Error("invalid_set");
		if (!/^[0-9a-f]{64}$/u.test(item.sessionSha256) || seen.has(item.key)) throw new Error("invalid_set");
		seen.add(item.key);
	}
	return { ...row, path };
}

function message(error) { return error instanceof Error ? error.message : String(error); }

/**
 * Compare the arms of one point from the rows of a single run.
 *
 * The original control is unchanged: it says whether the point can show anything.
 * The new part is baseline vs candidate, which is what separates "still broken" from
 * "this build broke it".
 */
export function compareArms(rows) {
	const reasons = [];
	const arm = (name) => {
		const verdicts = rows.filter((row) => row.arm === name).map((row) => row.verdict);
		if (!verdicts.length) { reasons.push(`missing_${name}_arm`); return null; }
		const unique = new Set(verdicts);
		if (unique.size > 1) { reasons.push(`${name}_repetitions_disagree`); return "flaky"; }
		return verdicts[0];
	};
	const original = arm("original"), baseline = arm("baseline"), candidate = arm("candidate");
	// A model point scored by two different judge prompts is not a comparison.
	const versions = new Set(rows.filter((row) => row.checkMode === "model" && row.judgePromptVersion).map((row) => row.judgePromptVersion));
	if (versions.size > 1) reasons.push("judge_prompt_mismatch");
	const verdict = (() => {
		if (reasons.length) return "inconclusive";
		if ([original, baseline, candidate].includes("flaky") || [original, baseline, candidate].includes("unknown")) return "inconclusive";
		if (original === "pass") return "judge-blind";
		if (baseline === "pass" && candidate === "fail") return "regression";
		if (baseline === "fail" && candidate === "pass") return "improved";
		return baseline === "fail" && candidate === "fail" ? "still-failing" : "stable-pass";
	})();
	return { comparison: verdict, original, baseline, candidate, reasons };
}

const countKey = { regression: "regression", improved: "improved", "still-failing": "stillFailing", "stable-pass": "stablePass", "judge-blind": "judgeBlind", inconclusive: "inconclusive", incomplete: "incomplete" };

/** 0: every point held or improved. 1: a real failure remains. 2: cannot conclude. */
export function regressionExitCode({ total, complete, counts }) {
	if (!total || !complete) return 2;
	if (counts.regression || counts.stillFailing) return 1;
	return counts.judgeBlind || counts.inconclusive || counts.incomplete ? 2 : 0;
}

function usageTotals(rows) {
	const totals = { input: 0, output: 0, totalTokens: 0, cost: 0, known: 0, unknown: 0 };
	for (const row of rows) {
		const usage = row.usage;
		if (!usage) { totals.unknown++; continue; }
		totals.known++;
		totals.input += Number(usage.input) || 0;
		totals.output += Number(usage.output) || 0;
		totals.totalTokens += Number(usage.totalTokens) || 0;
		totals.cost += Number(usage.cost?.total) || 0;
	}
	return totals;
}

/** Build the report from the rows a run just produced; never re-reads old runs. */
export function summarizeRegression({ set, rows, model, arms, startedAt, finishedAt }) {
	const byKey = new Map();
	for (const row of rows) {
		const list = byKey.get(row.key) ?? [];
		list.push(row);
		byKey.set(row.key, list);
	}
	const points = set.cases.map((item) => {
		const pointRows = byKey.get(item.key) ?? [];
		// A point with no rows at all is incomplete, never a silent pass.
		const compared = pointRows.length ? compareArms(pointRows) : { comparison: "incomplete", original: null, baseline: null, candidate: null, reasons: ["no_rows"] };
		return { key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, check: item.check.mode, ...compared, runs: pointRows.length, usage: usageTotals(pointRows) };
	});
	const counts = { total: points.length, regression: 0, improved: 0, stillFailing: 0, stablePass: 0, judgeBlind: 0, inconclusive: 0, incomplete: 0 };
	for (const point of points) counts[countKey[point.comparison]]++;
	const complete = set.scan?.included === set.cases.length && set.scan?.excluded === 0 && set.scan?.indexComplete === true;
	const exitCode = regressionExitCode({ total: counts.total, complete, counts });
	return {
		schema: REGRESSION_REPORT_SCHEMA, setName: set.name, setDigest: set.digest, startedAt, finishedAt, model, arms,
		points, counts, complete, exitCode,
		usage: usageTotals(rows),
		warnings: [...(complete ? [] : ["set_has_excluded_points"])],
	};
}

/**
 * Index every session header under the root. The dashboard's list caps its newest
 * candidates, which can hide an older session a replay point refers to; resolving by
 * id here keeps "the set is complete" honest.
 */
export async function sessionIndex(root, { maximum = MAX_INDEX_ENTRIES } = {}) {
	const paths = new Map(), duplicates = [];
	let files = 0, truncated = false;
	await assertPrivatePath(root);
	const walk = async (folder) => {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			if (truncated) return;
			if (entry.isSymbolicLink()) continue;
			const path = join(folder, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "observability") await walk(path); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			if (++files > maximum) { truncated = true; return; }
			let header;
			try { header = (await readBounded(path, HEADER_BYTES, true)).firstRecord; } catch { continue; }
			const id = header?.type === "session" ? header.id : undefined;
			if (!validSessionId(id)) continue;
			if (paths.has(id)) { duplicates.push(id); paths.delete(id); continue; }
			paths.set(id, path);
		}
	};
	await walk(root);
	return { paths, files, duplicates, complete: !truncated };
}

/** Read one session for a frozen point, using the index instead of guessing a path. */
export function sourceReader(index) {
	return async (item) => {
		const path = index.paths.get(item.sessionId);
		if (!path) throw new Error("session_not_indexed");
		const { readFile } = await import("node:fs/promises");
		const { loadSession } = await import("../../extensions/observability/eval/session-data.mjs");
		const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set(), 128 * 1024 * 1024);
		if (loaded.reason || !loaded.branch) throw new Error(`cannot_read_session: ${loaded.reason ?? "no_branch"}`);
		return { branch: loaded.branch, content: await readFile(path, "utf8") };
	};
}

/**
 * Suggest a cut for a session that is marked fail but has no replay point.
 *
 * The suggestion is evidence, not a decision: it names the assistant message before a
 * later user correction, and says which fields a person still has to supply. Nothing
 * is written to the replay store and no model is called.
 */
export async function suggestReplayPoints({ cases, labels, loadBranch, limit = 20 }) {
	const items = [];
	for (const [sessionId, label] of labels) {
		if (label.verdict !== "fail") continue;
		const existing = cases.filter((item) => item.sessionId === sessionId);
		let branch;
		try { branch = await loadBranch(sessionId); }
		catch (error) { items.push({ sessionId, hasReplayPoint: existing.length > 0, candidates: [], problem: `session_unreadable: ${message(error)}`, needs: ["channel"] }); continue; }
		const candidates = [];
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index];
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const next = branch.slice(index + 1).find((row) => row?.type === "message" && row.message?.role === "user");
			const correction = next && typeof next.message.content !== "undefined" ? entryText(next) : "";
			if (!correction || !CORRECTION.test(correction)) continue;
			candidates.push({
				entryId: entry.id, isPinnedAssistant: true,
				evidence: redactSecrets(correction).text.slice(0, SUGGESTION_EXCERPT_CHARS),
				reply: redactSecrets(assistantMessageOf(entry.message).text).text.slice(0, SUGGESTION_EXCERPT_CHARS),
			});
		}
		// Latest correction first: the last wrong step is usually the one to fix.
		candidates.reverse();
		items.push({
			sessionId, hasReplayPoint: existing.length > 0, candidates: candidates.slice(0, 2),
			problem: candidates.length ? null : "no_correction_evidence",
			needs: ["expected", "check", ...(candidates.length ? [] : ["entry"])],
			note: redactSecrets(label.note ?? "").text.slice(0, SUGGESTION_EXCERPT_CHARS),
		});
		if (items.length >= limit) break;
	}
	return items;
}

function entryText(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

/** Suggestions are private drafts; the caller decides whether to accept one. */
export async function writeSuggestions(directory, items, now = () => new Date()) {
	const folder = suggestionsDir(directory);
	await ensurePrivate(folder);
	const at = now().toISOString(), path = join(folder, `${at.replace(/[:.]/gu, "-")}.json`);
	await assertPrivatePath(path);
	await privateWrite(path, JSON.stringify({ schema: "rotom-replay-suggestions/v1", createdAt: at, items }) + "\n");
	return { path, at };
}
