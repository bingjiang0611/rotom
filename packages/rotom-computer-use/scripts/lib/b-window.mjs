/**
 * The B-phase hard constraints (review 6 P1, tightened by the re-review K1-K4).
 *
 * The first authorized window lost its authority on its own: the stop rule existed only
 * as prose, so B1 failed on a missing fixture window and the agent kept going - B2 was
 * run four times (twice with code committed minutes earlier), B3 twice and B6
 * last-but-one. Nothing that happened after the first failure can be cited as evidence.
 *
 * The re-review found three holes in the first attempt to make the rules mechanical:
 *
 *   K1  Window output was written into `docs/.../evidence/`, i.e. into the worktree. Any
 *       archive makes the tree dirty, and committing it moves HEAD off the frozen commit,
 *       so B1 could pass and B2 could never start. Output now goes to a required
 *       `--runs-dir` outside the repository, and a path inside it is refused.
 *   K2  Only `fail` rows counted, so a B1 whose directed click came back `didnt` or
 *       `unknown` still said `Verdict: pass`. Every step now declares the rows it cannot
 *       pass without, and a required row that is `inconclusive`/`skipped`/missing blocks
 *       the phase. Real user input is one of those rows for every step.
 *   K3  The acceptance run never called `finishStep`, and it shared the `B3` id with the
 *       live check, so one pass opened B4 on its own. B3 is now `B3-live` and
 *       `B3-acceptance`; both have to pass on the same commit.
 *   K4  Two scripts claimed B6. Only `check-cu-v2-live.mjs --with-hid` is B6.
 *
 * `B-STOPPED` lives in the runs directory too: the operator deletes it, and an agent that
 * can clear its own stop marker has no stop rule.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The authorized order. B6 runs alone, after B4 and B5 have passed. */
export const B_STEPS = Object.freeze(["B1", "B2", "B3-live", "B3-acceptance", "B4", "B5", "B6"]);

/**
 * Steps that only collect data (review 7, R2).
 *
 * B0 is the attribution run: same gate, same frozen commit, same actions as B1, but its
 * archive carries no `Verdict:` line, so `findPassingRun` never reads it as permission for
 * anything, and it writes no stop marker, because a run that was only supposed to report
 * cannot fail a step. It sits outside `B_STEPS` on purpose: putting it first would make B1
 * depend on it, which is the opposite of what a report-only probe is for.
 */
export const REPORT_ONLY_STEPS = Object.freeze(["B0"]);

/**
 * Which script owns each step, for messages and for the dry run.
 *
 * `null` means the step has no script yet; the order check refuses to skip it. `B6` has
 * exactly one owner (K4): the live check's `--with-hid` mode.
 */
export const STEP_SCRIPTS = Object.freeze({
	B1: "scripts/cu-v2-l2-check.mjs",
	B2: "scripts/cu-v2-compat-matrix.mjs",
	"B3-live": "scripts/check-cu-v2-live.mjs",
	"B3-acceptance": "scripts/cu-v2-acceptance.mjs",
	B4: null,
	B5: null,
	B6: "scripts/check-cu-v2-live.mjs --with-hid",
	B0: "scripts/cu-v2-l2-check.mjs --b0-attribution",
});

/** Marker file in the runs directory; its presence stops every live script. */
export const STOP_MARKER = "B-STOPPED";

const isAsciiInput = (rows) => rows.some((row) => row.area === "environment" && row.action === "input source" && row.result === "pass");

/**
 * The rows a step cannot pass without (K2).
 *
 * A requirement is `{area, action}` or a `{matches}` predicate; `note` adds a condition
 * on the row's note (B1 has to show `delivery=l2`, not merely a `pass`), and `when`
 * makes a row conditional (the directed text line only exists on an ASCII input source).
 * `optional` rows are recorded but never block.
 */
export const STEP_CONTRACT = Object.freeze({
	B1: Object.freeze([
		{ area: "gate", action: "verdict" },
		{ area: "direct L2", action: "click", note: /delivery=l2/ },
		{ area: "direct L2", action: "typeText", note: /delivery=l2/, when: isAsciiInput },
		{ area: "helper", action: "still alive" },
		{ area: "restore", action: "operator app" },
		{ area: "run", action: "real user input" },
	]),
	B2: Object.freeze([
		{ area: "gate", action: "verdict" },
		{ matches: (row) => row.action === "observe" && row.result === "pass", label: "an observe cell" },
		{ area: "restore", action: "operator app" },
		{ area: "run", action: "real user input" },
	]),
	"B3-live": Object.freeze([
		{ area: "gate", action: "verdict" },
		{ matches: (row) => row.area === "act" && row.result === "pass", label: "a semantic action" },
		{ area: "background", action: "cursor unchanged" },
		{ area: "background", action: "frontmost app unchanged" },
		{ area: "restore", action: "operator app" },
		{ area: "run", action: "real user input" },
	]),
	"B3-acceptance": Object.freeze([
		{ area: "gate", action: "verdict" },
		{ matches: (row) => row.area.startsWith("agent") && row.action === "click", label: "an agent click" },
		{ area: "restore", action: "operator app" },
		{ area: "run", action: "real user input" },
	]),
	B6: Object.freeze([
		{ area: "gate", action: "verdict" },
		{ area: "act", action: "click went through HID" },
		{ area: "act", action: "click took effect" },
		{ area: "restore", action: "operator app" },
		{ area: "run", action: "real user input" },
	]),
	B4: Object.freeze([{ area: "run", action: "real user input" }]),
	B5: Object.freeze([{ area: "run", action: "real user input" }]),
});

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
 * The commit is resolved first so a short SHA works, but `HEAD` must equal the resolved
 * commit: "a commit that is an ancestor" would let a window run on code the reviewer
 * never saw.
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

/**
 * Require a runs directory outside the worktree (K1).
 *
 * Everything a window writes - archives, logs, gate readings, `B-STOPPED` - lands here.
 * Writing into the repository would either dirty the tree (refusing the next step) or
 * require a commit (moving HEAD off the frozen commit), which is how B1 used to close the
 * window after itself.
 */
export function requireRunsDir(value, { cwd = process.cwd(), exec = execFileSync } = {}) {
	if (!value) {
		throw new StepRefused("--runs-dir <absolute path outside the repository> is required: window output may not touch the worktree");
	}
	if (!path.isAbsolute(value)) {
		throw new StepRefused(`--runs-dir must be an absolute path, got ${value}`);
	}
	let toplevel;
	try {
		toplevel = String(exec("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })).trim();
	} catch {
		toplevel = undefined;
	}
	if (toplevel) {
		const relative = path.relative(toplevel, value);
		const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
		if (inside) {
			throw new StepRefused(`--runs-dir ${value} is inside the worktree (${toplevel}): window output must live outside the repository, otherwise the next step sees a dirty tree or a moved HEAD`);
		}
	}
	mkdirSync(value, { recursive: true });
	return value;
}

export function stopMarkerPath(runsDir) {
	return path.join(runsDir, STOP_MARKER);
}

/** The marker's content, or `null` when the phase is not stopped. */
export function readStopMarker(runsDir) {
	const file = stopMarkerPath(runsDir);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// A marker that cannot be parsed still stops the phase.
		return { raw: readFileSync(file, "utf8") };
	}
}

export function requireNoStopMarker(runsDir) {
	const marker = readStopMarker(runsDir);
	if (!marker) return;
	const by = marker.step ? ` by ${marker.step}` : "";
	throw new StepRefused(`${STOP_MARKER} exists (written${by}${marker.at ? ` at ${marker.at}` : ""}): the phase is stopped, and only the operator may delete ${stopMarkerPath(runsDir)}`);
}

/** Stop the phase. Called by `finishStep`, never by an agent command. */
export function writeStopMarker({ runsDir, step, commit, reason, run, at = new Date().toISOString() }) {
	mkdirSync(runsDir, { recursive: true });
	const file = stopMarkerPath(runsDir);
	writeFileSync(file, `${JSON.stringify({ step, commit, reason, run, at }, null, 2)}\n`);
	return file;
}

/** The `Verdict:` line of an archive, or `undefined` when the file has none. */
export function verdictOfArchive(text) {
	return /^Verdict: (pass|fail)$/m.exec(text)?.[1];
}

export function stepOfArchive(text) {
	return /^Step: (B\d[\w-]*)$/m.exec(text)?.[1];
}

export function commitOfArchive(text) {
	return /^Commit: ([0-9a-f]{7,40})$/m.exec(text)?.[1];
}

/**
 * The newest archive of `step` that passed on `commit`, or `undefined`.
 *
 * Only archives that name both are considered: a hand-written summary, an older format
 * or a run under another commit must not authorize the next step.
 */
export function findPassingRun({ step, commit, runsDir } = {}) {
	if (!step || !commit || !runsDir || !existsSync(runsDir)) return undefined;
	const files = readdirSync(runsDir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.reverse();
	for (const name of files) {
		const text = readFileSync(path.join(runsDir, name), "utf8");
		if (stepOfArchive(text) !== step) continue;
		if (verdictOfArchive(text) !== "pass") continue;
		const archiveCommit = commitOfArchive(text);
		if (archiveCommit && commit.startsWith(archiveCommit)) return { name, commit: archiveCommit };
	}
	return undefined;
}

/** Refuse unless every step before `step` passed on `commit`. */
export function requirePreviousStepsPassed({ step, commit, runsDir, warn = () => {} } = {}) {
	const index = B_STEPS.indexOf(step);
	if (index < 0) throw new StepRefused(`${step} is not one of ${B_STEPS.join("/")}`);
	for (const previous of B_STEPS.slice(0, index)) {
		if (findPassingRun({ step: previous, commit, runsDir })) continue;
		const owner = STEP_SCRIPTS[previous];
		throw new StepRefused(
			`${step} may only run after ${previous} passed on ${commit.slice(0, 7)}; no such archive in ${runsDir}`
			+ (owner ? ` (that step runs ${owner})` : " (that step has no script yet, so later steps cannot jump it)"),
		);
	}
	if (index > 0) warn(`previous steps passed on ${commit.slice(0, 7)}`);
}

/**
 * The checks a run has to survive before it may touch the desktop.
 *
 * Stop marker first: a stopped phase must not even read the gate, because a gate pass
 * would look like permission.
 */
export function beginStep({ step, expectCommit, runsDir, cwd = process.cwd(), exec = execFileSync, warn = () => {} } = {}) {
	const dir = requireRunsDir(runsDir, { cwd, exec });
	requireNoStopMarker(dir);
	const { head } = requireFrozenCommit({ expectCommit, cwd, exec });
	const reportOnly = REPORT_ONLY_STEPS.includes(step);
	if (!reportOnly) requirePreviousStepsPassed({ step, commit: head, runsDir: dir, warn });
	return { step, commit: head, runsDir: dir, reportOnly };
}

/**
 * Decide the step from its rows (K2).
 *
 * Three things block a step: a `fail` row, a missing required row, and a required row
 * that is `inconclusive` or `skipped`. The last one is the hole the re-review found -
 * B1's directed click reported `inconclusive` on its way to `Verdict: pass`.
 */
export function evaluateStep({ step, rows = [] } = {}) {
	const contract = STEP_CONTRACT[step];
	if (!contract) throw new StepRefused(`${step} has no row contract; a step without required rows cannot pass`);
	const blockers = [];
	for (const row of rows) {
		if (row.result === "fail") blockers.push(`${row.area} | ${row.action} = fail${row.note ? ` (${row.note})` : ""}`);
	}
	for (const requirement of contract) {
		if (requirement.when && !requirement.when(rows)) continue;
		if (requirement.optional) continue;
		const label = requirement.label ?? `${requirement.area} | ${requirement.action}`;
		const candidates = requirement.matches
			? rows.filter(requirement.matches)
			: rows.filter((row) => row.area === requirement.area && row.action === requirement.action);
		if (candidates.length === 0) {
			blockers.push(`required row missing: ${label}`);
			continue;
		}
		const passing = candidates.filter((row) => row.result === "pass");
		if (passing.length === 0) {
			blockers.push(`required row not passing: ${label} = ${candidates.map((row) => row.result).join("/")}`);
			continue;
		}
		if (requirement.note) {
			const withNote = passing.filter((row) => requirement.note.test(row.note ?? ""));
			if (withNote.length === 0) blockers.push(`required row lacks ${requirement.note}: ${label} (${passing[0].note ?? "no note"})`);
		}
	}
	return { verdict: blockers.length === 0 ? "pass" : "fail", blockers };
}

/** Record the verdict and stop the phase on a failure. */
export function finishStep({ step, commit, runsDir, rows = [], run, reason }) {
	const { verdict, blockers } = evaluateStep({ step, rows });
	if (verdict === "fail") {
		writeStopMarker({ runsDir, step, commit, reason: reason ?? blockers[0] ?? "step blocked", run });
	}
	return { verdict, blockers };
}

/**
 * Write the archive a later step reads, and finish the step in one place.
 *
 * The archive keeps `Step:`, `Commit:` and `Verdict:` machine-readable; `Blockers:` names
 * what stopped a failing run instead of leaving the reader to scan the table.
 */
export function writeRunArchive({ runsDir, runName, title, step, commit, rows = [], table, log = [], intro = [], notes = [], reportOnly = false }) {
	// A report-only archive is not evidence about a step: it neither finishes one nor
	// writes the marker (review 7, R2). No `Verdict:` line means `findPassingRun` skips it.
	const { verdict, blockers } = reportOnly
		? { verdict: "report", blockers: [] }
		: finishStep({ step, commit, runsDir, rows, run: runName });
	const lines = [
		`# ${title} (${new Date().toISOString()})`,
		"",
		`Rows: ${rows.length} · Failures: ${rows.filter((row) => row.result === "fail").length}`,
		"",
		`Step: ${step}`,
		`Commit: ${commit}`,
		...(reportOnly
			? ["归因报告：本次运行不写 `Verdict:`，不放行任何步骤，也不写 `B-STOPPED`。"]
			: [`Verdict: ${verdict}`, ...(blockers.length > 0 ? [`Blockers: ${blockers.length}`] : [])]),
		"",
		`本次运行存档：\`${runName}\``,
		"",
		...intro,
		"",
		...(table ?? renderTable(rows)),
		"",
		...(blockers.length > 0 ? ["## Blockers", "", ...blockers.map((line) => `- ${line}`), ""] : []),
		...notes,
		...(log.length > 0 ? ["## Log", "", "```", ...log, "```", ""] : []),
	];
	const target = path.join(runsDir, runName);
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(target, lines.join("\n"));
	return { path: target, verdict, blockers };
}

export function renderTable(rows) {
	return [
		"| Area | Action | Result | Note |",
		"| --- | --- | --- | --- |",
		...rows.map((row) => `| ${row.area} | ${row.action} | ${row.result} | ${String(row.note ?? "").replace(/\|/g, "\\|")} |`),
	];
}
