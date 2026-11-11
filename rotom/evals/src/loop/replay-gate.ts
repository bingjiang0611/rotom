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
	/**
	 * Hand-written correct answers the check must accept before the case may run. A check that only
	 * recognises the wording or the one route the author had in mind would score a correct answer as
	 * a failure, so every case carries at least two: one written in Chinese and one that reaches the
	 * same result by a different route.
	 */
	answers: ReplayAnswer[];
}

export interface ReplayAnswer {
	/** `<name>` for the operator; the check never sees it. */
	label: string;
	/** Session-format fixture inside the case directory holding the answer. */
	session: string;
	/** Entry id in that fixture the check judges from, exactly as it does for a replay. */
	cut: string;
	/** `zh` for a Chinese answer, `alternative` for an equivalent route in any language. */
	kind: "zh" | "alternative";
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
		const answers = item.answers;
		if (!Array.isArray(answers) || answers.length < 2) throw new Error(`${where}: at least two hand-written answers are required, one Chinese and one equivalent route`);
		const kinds = new Set<string>();
		for (const [position, answer] of answers.entries()) {
			const at = `${where} answer ${position + 1}`;
			const value = answer as Partial<ReplayAnswer>;
			if (typeof value.label !== "string" || !value.label.trim()) throw new Error(`${at}: label is required`);
			if (value.kind !== "zh" && value.kind !== "alternative") throw new Error(`${at}: kind must be zh or alternative`);
			if (typeof value.session !== "string" || !isAbsolute(value.session) || !resolve(value.session).startsWith(`${root}/`)) throw new Error(`${at}: session must be an absolute path inside ${root}`);
			if (!existsSync(value.session) || !statSync(value.session).isFile()) throw new Error(`${at}: session ${value.session} does not exist`);
			if (typeof value.cut !== "string" || !/^[0-9a-f]{8}$/u.test(value.cut)) throw new Error(`${at}: cut must be an entry id`);
			kinds.add(value.kind);
		}
		if (kinds.size !== 2) throw new Error(`${where}: answers must include both a zh and an alternative route`);
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

export type CheckRun = (env: { REPLAY_SESSION: string; REPLAY_CUT: string; VIEW_MODE: "before" | "after" }) => number;

export interface CaseValidation {
	usable: boolean;
	/** One line per answer and for the original trajectory, so a refusal says what to fix. */
	detail: string;
}

/**
 * A check is usable when it rejects the recorded failure and accepts every hand-written answer. It
 * runs against the case's own fixtures and the original session, before any product is spawned: a
 * check that fails either direction would make every replay of this case meaningless.
 */
export function validateReplayCase(item: ReplayCase, original: { session: string; cut: string }, runCheck: CheckRun): CaseValidation {
	const notes: string[] = [];
	let usable = true;
	const verdicts = item.answers.map((answer) => {
		// An answer is the turn after its user message, exactly like a replay run.
		const code = runCheck({ REPLAY_SESSION: answer.session, REPLAY_CUT: answer.cut, VIEW_MODE: "after" });
		const passed = code === 0;
		if (!passed) usable = false;
		notes.push(`${answer.kind} answer ${answer.label}: ${passed ? "accepted" : `rejected (check rc=${code})`}`);
		return passed;
	});
	// The recorded failure is the turn the person was reacting to, so the window ends at the cut.
	const originalCode = runCheck({ REPLAY_SESSION: original.session, REPLAY_CUT: original.cut, VIEW_MODE: "before" });
	const originalFailed = originalCode === 1;
	if (!originalFailed) usable = false;
	notes.push(`original trajectory: ${originalFailed ? "rejected, as the case requires" : `not rejected (check rc=${originalCode})`}`);
	if (!verdicts.some(Boolean) && originalFailed) usable = false;
	return { usable, detail: notes.join("; ") };
}
