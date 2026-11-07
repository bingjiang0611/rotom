/**
 * The B-phase hard constraints (review 6, P1).
 *
 * The first authorized window lost its authority on its own: the stop rule existed only
 * as prose, so B1 failed on a missing fixture window and the agent kept going - B2 was
 * run four times (twice with code committed to the same branch minutes earlier), B3
 * twice and B6 last-but-one, while the script under test was being edited between runs.
 * Nothing that happened after the first failure can be cited as evidence.
 *
 * So the rules become checks the scripts cannot skip:
 *
 *   1. A run is only evidence about a frozen commit: `--expect-commit <sha>` is
 *      required, the worktree must be clean and `HEAD` must be that commit. Any commit
 *      made during a window therefore invalidates the rest of the window instead of
 *      quietly moving the tree under the next run.
 *   2. One `fail` row blocks the whole phase. `finishStep` writes a `B-STOPPED` marker
 *      into the shared run directory, and every live script refuses to start while it
 *      exists. Only the operator deletes it - an agent that can clear its own stop
 *      marker has no stop rule.
 *   3. Order is fixed: B1 -> B6, and a step may only run after the previous step left a
 *      `Verdict: pass` archive **for the same commit**. A step with no script yet (B4,
 *      B5) blocks everything after it, which is the point: B6 may not jump the queue.
 *
 * Run archives carry the three machine-readable lines `Step:`, `Commit:` and
 * `Verdict:`, so the order check reads the same file a reviewer cites.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The authorized order. B6 runs alone, after B4 and B5 have passed. */
export const B_STEPS = Object.freeze(["B1", "B2", "B3", "B4", "B5", "B6"]);

/**
 * Which script owns each step, for messages and for the dry run.
 *
 * `null` means the step has no script yet; the order check refuses to skip it.
 */
export const STEP_SCRIPTS = Object.freeze({
	B1: "scripts/cu-v2-l2-check.mjs",
	B2: "scripts/cu-v2-compat-matrix.mjs",
	B3: "scripts/check-cu-v2-live.mjs",
	B4: null,
	B5: null,
	B6: "scripts/cu-v2-l2-check.mjs --with-hid",
});

/** Marker file in the shared run directory; its presence stops every live script. */
export const STOP_MARKER = "B-STOPPED";

export const RUNS_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence", "runs");

/** A refusal is a process exit code 2, never a silent skip. */
export class StepRefused extends Error {
	constructor(message) {
		super(message);
		this.name = "StepRefused";
	}
}

/** `git` in the repository, with the executor injectable so the rules can be tested. */
export function gitState({ cwd = process.cwd(), exec = execFileSync } = {}) {
	const head = String(exec("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).trim();
	const porcelain = String(exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }));
	const dirtyPaths = porcelain.split("\n").map((line) => line.trim()).filter(Boolean);
	return { head, dirty: dirtyPaths.length > 0, dirtyPaths };
}

/**
 * Refuse unless the caller declared a freeze and the tree matches it.
 *
 * The commit is resolved first so a short SHA works, but `HEAD` must equal the
 * resolved commit: "a commit that is an ancestor" would let a window run on code the
 * reviewer never saw.
 */
export function requireFrozenCommit({ expectCommit, cwd = process.cwd(), exec = execFileSync } = {}) {
	if (!expectCommit) {
		throw new StepRefused("--expect-commit <sha> is required: the reviewer freezes one commit before the window opens, and a run on any other tree is not evidence");
	}
	let resolved;
	try {
		resolved = String(exec("git", ["rev-parse", "--verify", `${expectCommit}^{commit}`], { cwd, encoding: "utf8" })).trim();
	} catch {
		throw new StepRefused(`--expect-commit ${expectCommit} is not a commit in this repository`);
	}
	const state = gitState({ cwd, exec });
	if (state.dirty) {
		throw new StepRefused(`the worktree is not clean (${state.dirtyPaths.length} changed path(s), first: ${state.dirtyPaths[0]}): a window may not change code, so this run would prove nothing about ${resolved.slice(0, 7)}`);
	}
	if (state.head !== resolved) {
		throw new StepRefused(`HEAD is ${state.head.slice(0, 7)}, not the frozen commit ${resolved.slice(0, 7)}: committing or checking out inside a window invalidates it`);
	}
	return { head: state.head };
}

export function stopMarkerPath(dir = RUNS_DIR) {
	return path.join(dir, STOP_MARKER);
}

/** The marker's content, or `null` when the phase is not stopped. */
export function readStopMarker(dir = RUNS_DIR) {
	const file = stopMarkerPath(dir);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// A marker that cannot be parsed still stops the phase.
		return { raw: readFileSync(file, "utf8") };
	}
}

export function requireNoStopMarker(dir = RUNS_DIR) {
	const marker = readStopMarker(dir);
	if (!marker) return;
	const by = marker.step ? ` by ${marker.step}` : "";
	throw new StepRefused(`${STOP_MARKER} exists (written${by}${marker.at ? ` at ${marker.at}` : ""}): the phase is stopped, and only the operator may delete ${stopMarkerPath(dir)}`);
}

/** Stop the phase. Called by `finishStep`, never by an agent command. */
export function writeStopMarker({ dir = RUNS_DIR, step, commit, reason, run, at = new Date().toISOString() }) {
	mkdirSync(dir, { recursive: true });
	const file = stopMarkerPath(dir);
	writeFileSync(file, `${JSON.stringify({ step, commit, reason, run, at }, null, 2)}\n`);
	return file;
}

const VERDICT_PATTERN = /^Verdict: (pass|fail)$/m;

/** The `Verdict:` line of an archive, or `undefined` when the file has none. */
export function verdictOfArchive(text) {
	return VERDICT_PATTERN.exec(text)?.[1];
}

export function stepOfArchive(text) {
	return /^Step: (B\d)$/m.exec(text)?.[1];
}

export function commitOfArchive(text) {
	return /^Commit: ([0-9a-f]{7,40})$/m.exec(text)?.[1];
}

/**
 * The newest archive of `step` that passed on `commit`, or `undefined`.
 *
 * Only archives that name both are considered: a hand-written summary, an older
 * format or a run under another commit must not authorize the next step.
 */
export function findPassingRun({ step, commit, dir = RUNS_DIR } = {}) {
	if (!step || !commit || !existsSync(dir)) return undefined;
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.reverse();
	for (const name of files) {
		const text = readFileSync(path.join(dir, name), "utf8");
		if (stepOfArchive(text) !== step) continue;
		if (verdictOfArchive(text) !== "pass") continue;
		const archiveCommit = commitOfArchive(text);
		if (archiveCommit && commit.startsWith(archiveCommit)) return { name, commit: archiveCommit };
	}
	return undefined;
}

/** Refuse unless every step before `step` passed on `commit`. */
export function requirePreviousStepsPassed({ step, commit, dir = RUNS_DIR, warn = () => {} } = {}) {
	const index = B_STEPS.indexOf(step);
	if (index < 0) throw new StepRefused(`${step} is not one of ${B_STEPS.join("/")}`);
	for (const previous of B_STEPS.slice(0, index)) {
		if (findPassingRun({ step: previous, commit, dir })) continue;
		const owner = STEP_SCRIPTS[previous];
		throw new StepRefused(
			`${step} may only run after ${previous} passed on ${commit.slice(0, 7)}; no such archive in ${dir}`
			+ (owner ? ` (previous step runs ${owner})` : " (previous step has no script yet, so B6 cannot jump it)"),
		);
	}
	if (index > 0) warn(`previous steps passed on ${commit.slice(0, 7)}`);
}

/**
 * The three checks a run has to survive before it may touch the desktop.
 *
 * Stop marker first: a stopped phase must not even read the gate, because a gate pass
 * would look like permission.
 */
export function beginStep({ step, expectCommit, dir = RUNS_DIR, cwd = process.cwd(), exec = execFileSync, warn = () => {} } = {}) {
	requireNoStopMarker(dir);
	const { head } = requireFrozenCommit({ expectCommit, cwd, exec });
	requirePreviousStepsPassed({ step, commit: head, dir, warn });
	return { step, commit: head };
}

/**
 * Record the verdict and stop the phase on a failure.
 *
 * `failures` counts `fail` rows only: a refusal (no window, no lease) is a fact about
 * the run, while a `fail` is a result the phase must not walk past.
 */
export function finishStep({ step, commit, dir = RUNS_DIR, failures, run, reason }) {
	const verdict = failures > 0 ? "fail" : "pass";
	if (verdict === "fail") {
		writeStopMarker({ dir, step, commit, reason: reason ?? `${failures} failing row(s)`, run });
	}
	return verdict;
}
