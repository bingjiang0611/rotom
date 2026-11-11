/**
 * Replay gate: the same question the offline gate asks, for failures that only reproduce as a real
 * session — did a change to the prompt, a tool description, or the continuation logic make a
 * captured failure worse? The case list, the checks and the session branches are private
 * (`~/.rotom/loop/replay-cases/`, 0700/0600) because they quote real sessions; the committed
 * manifest only names each case and summarises its mechanism.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const REPLAY_CASES_SCHEMA = "rotom-loop-replay-cases/v1";
/** Cases are private; a test id is a slug so the public manifest can name one without a path. */
const CASE_ID = /^[a-z0-9][a-z0-9-]{2,60}$/u;

export interface ReplayCase {
	id: string;
	/** `<sessionId>:<entryId>` in the local harvest. Never committed. */
	incident: string;
	/** Deterministic check, inside the case directory. Exit 0 = the failure is gone. */
	check: string;
	model?: { provider: string; model: string };
	frozen?: string;
	repeats?: number;
	/** De-identified one-line summary of what the case is about; this part may be committed. */
	mechanism: string;
}

/**
 * The committed half: what the public manifest may carry. No incident, no check, no paths.
 */
export interface ReplayCaseSummary {
	id: string;
	kind: "replay";
	mechanism: string;
}

export function parseReplayCases(text: string, casesDir: string): ReplayCase[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("replay cases: invalid JSON");
	}
	const value = parsed as { schema?: unknown; cases?: unknown };
	if (value?.schema !== REPLAY_CASES_SCHEMA) throw new Error(`replay cases: schema must be ${REPLAY_CASES_SCHEMA}`);
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error("replay cases: cases must be a non-empty array");
	const root = resolve(casesDir);
	const seen = new Set<string>();
	return value.cases.map((raw, index) => {
		const where = `replay case ${index + 1}`;
		const item = raw as Partial<ReplayCase>;
		if (typeof item.id !== "string" || !CASE_ID.test(item.id)) throw new Error(`${where}: id must be a slug`);
		if (seen.has(item.id)) throw new Error(`${where}: duplicate id ${item.id}`);
		seen.add(item.id);
		if (typeof item.incident !== "string" || !/^[0-9a-z-]+:[0-9a-f]{8}$/u.test(item.incident)) throw new Error(`${where}: incident must look like <sessionId>:<entryId>`);
		if (typeof item.mechanism !== "string" || !item.mechanism.trim()) throw new Error(`${where}: mechanism is required`);
		if (/\/Users\/|\/home\/|\.rotom/u.test(item.mechanism)) throw new Error(`${where}: mechanism must not carry a local path`);
		// A case may only run a check from its own directory: nothing outside the private case
		// directory is ever executed as a check.
		if (typeof item.check !== "string" || !isAbsolute(item.check) || !resolve(item.check).startsWith(`${root}/`)) {
			throw new Error(`${where}: check must be an absolute path inside ${root}`);
		}
		if (!existsSync(item.check) || !statSync(item.check).isFile()) throw new Error(`${where}: check ${item.check} does not exist`);
		if (item.repeats !== undefined && (!Number.isSafeInteger(item.repeats) || item.repeats < 1 || item.repeats > 5)) throw new Error(`${where}: repeats must be 1..5`);
		if (item.model !== undefined) {
			const model = item.model as { provider?: unknown; model?: unknown };
			if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) throw new Error(`${where}: model must be {provider, model}`);
		}
		if (item.frozen !== undefined && (typeof item.frozen !== "string" || !isAbsolute(item.frozen))) throw new Error(`${where}: frozen must be an absolute path`);
		return item as ReplayCase;
	});
}

/** One case's outcome. `unknown` is never a pass: a product that did not start or never finished did not hold anything. */
export type ReplayGateVerdict = "held" | "regressed" | "unknown";

export interface ReplayGateResult {
	id: string;
	verdict: ReplayGateVerdict;
	/** Why, in one line, so a reader does not have to open the artifacts. */
	detail: string;
	frozen: { pass: number; fail: number; unknown: number };
	candidate: { pass: number; fail: number; unknown: number };
}

/**
 * Classify one case from its per-run check verdicts. `frozen` shows whether the case still
 * reproduces at all: if the frozen arm passes, the candidate cannot be credited with a fix and the
 * case is unknown rather than held.
 */
export function replayGateVerdict(frozen: { pass: number; fail: number; unknown: number }, candidate: { pass: number; fail: number; unknown: number }): ReplayGateVerdict {
	if (candidate.fail > 0) return "regressed";
	if (candidate.unknown > 0 || candidate.pass === 0) return "unknown";
	if (frozen.fail === 0) return "unknown";
	return "held";
}

export function countVerdicts(runs: readonly { check: string }[]): { pass: number; fail: number; unknown: number } {
	const counts = { pass: 0, fail: 0, unknown: 0 };
	for (const run of runs) {
		if (run.check === "pass") counts.pass += 1;
		else if (run.check === "fail") counts.fail += 1;
		else counts.unknown += 1;
	}
	return counts;
}

/** The committed summary of the private case file, for `gate.json`. */
export function replayCaseSummaries(cases: readonly ReplayCase[]): ReplayCaseSummary[] {
	return cases.map((item) => ({ id: item.id, kind: "replay", mechanism: item.mechanism }));
}

export function replayCasesDir(loopDir: string): string {
	return join(loopDir, "replay-cases");
}
