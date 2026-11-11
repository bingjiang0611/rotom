/**
 * Review 6 (P1) and its re-review (K1-K4): the B-phase rules as checks, not prose.
 *
 * The interesting cases are the ones the first window walked straight through - a window
 * that commits code, a phase that keeps going after a failure, a step that runs before its
 * predecessor - plus the two holes the re-review found: output written into the worktree,
 * and a required row that could be `inconclusive` while the step still passed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	B_STEPS,
	STEP_CONTRACT,
	STEP_SCRIPTS,
	StepRefused,
	beginStep,
	evaluateStep,
	findPassingRun,
	finishStep,
	gitState,
	readStopMarker,
	requireFrozenCommit,
	requireNoStopMarker,
	requirePreviousStepsPassed,
	requireRunsDir,
	stepOfArchive,
	verdictOfArchive,
	commitOfArchive,
	writeRunArchive,
	writeStopMarker,
} from "../scripts/lib/b-window.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/** A `git` that answers from canned output, so the rules run without a repository. */
function fakeGit({ head = HEAD, status = "", toplevel = "/repo", resolve = (sha: string) => (HEAD.startsWith(sha) ? HEAD : OTHER.startsWith(sha) ? OTHER : undefined) } = {}) {
	return (command: string, args: readonly string[]) => {
		if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
		if (args[0] === "status") return status;
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${toplevel}\n`;
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			const resolved = resolve(args[2].replace(/\^\{commit\}$/, ""));
			if (!resolved) throw new Error("not a commit");
			return `${resolved}\n`;
		}
		throw new Error(`unexpected git ${args.join(" ")}`);
	};
}

function makeDir(prefix = "cu-v2-b-window-") {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function archive(runsDir: string, name: string, { step, commit, verdict }: { step: string; commit: string; verdict: string }) {
	writeFileSync(path.join(runsDir, name), `# run\n\nStep: ${step}\nCommit: ${commit}\nVerdict: ${verdict}\n`);
}

/** A git repository with one commit, for the checks that must not run on a fake git. */
function realRepo() {
	const repo = makeDir("cu-v2-real-repo-");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(path.join(repo, "file.txt"), "one\n");
	git("add", "file.txt");
	git("commit", "-q", "-m", "init");
	return { repo, head: git("rev-parse", "HEAD"), git };
}

test("a run needs a declared commit", () => {
	assert.throws(() => requireFrozenCommit({ exec: fakeGit() }), (error) => error instanceof StepRefused && /--expect-commit/.test(error.message));
});

test("an unknown commit is refused", () => {
	assert.throws(() => requireFrozenCommit({ expectCommit: "3333333", exec: fakeGit() }), (error) => error instanceof StepRefused && /not a commit/.test(error.message));
});

test("a dirty worktree is refused even when HEAD matches", () => {
	const exec = fakeGit({ status: " M packages/rotom-computer-use/scripts/lib/fixture.mjs\n?? notes.md\n" });
	assert.throws(() => requireFrozenCommit({ expectCommit: HEAD, exec }), (error) => error instanceof StepRefused && /worktree is not clean/.test(error.message));
});

test("HEAD must be the frozen commit, not an ancestor of it", () => {
	const exec = fakeGit({ head: OTHER, resolve: () => HEAD });
	assert.throws(() => requireFrozenCommit({ expectCommit: HEAD, exec }), (error) => error instanceof StepRefused && /not the frozen commit/.test(error.message));
});

test("a clean tree on the frozen commit passes and reports the head", () => {
	assert.deepEqual(requireFrozenCommit({ expectCommit: HEAD.slice(0, 7), exec: fakeGit() }), { head: HEAD });
});

test("gitState separates clean, dirty and short heads", () => {
	assert.equal(gitState({ exec: fakeGit() }).dirty, false);
	const dirty = gitState({ exec: fakeGit({ status: "?? a\n?? b\n" }) });
	assert.equal(dirty.dirty, true);
	assert.deepEqual(dirty.dirtyPaths, ["?? a", "?? b"]);
});

test("K1: window output may not live inside the worktree", () => {
	const exec = fakeGit({ toplevel: "/repo" });
	assert.throws(() => requireRunsDir(undefined, { exec }), (error) => error instanceof StepRefused && /--runs-dir/.test(error.message));
	assert.throws(() => requireRunsDir("runs", { exec }), (error) => error instanceof StepRefused && /absolute/.test(error.message));
	assert.throws(() => requireRunsDir("/repo/docs/agent/computer-use-v2/evidence/runs", { exec }), (error) => error instanceof StepRefused && /inside the worktree/.test(error.message));
	assert.throws(() => requireRunsDir("/repo", { exec }), (error) => error instanceof StepRefused && /inside the worktree/.test(error.message));
	// A sibling of the repository is fine, and the directory is created for the caller.
	const runsDir = path.join(makeDir("cu-v2-runs-"), "nested", "runs");
	assert.equal(requireRunsDir(runsDir, { exec }), runsDir);
	// Outside any repository there is nothing to protect; a failing `git` is not a refusal.
	const outside = path.join(makeDir("cu-v2-runs-"), "runs");
	const rejecting = () => {
		throw new Error("not a repository");
	};
	assert.equal(requireRunsDir(outside, { exec: rejecting }), outside);
});

test("K1: a real repository - B2 is allowed after a passing B1", () => {
	// The re-review reproduced the opposite with real git: B1 wrote its archive into the
	// worktree, so B2 saw a dirty tree forever. This test drives the same path.
	const { repo, head } = realRepo();
	const runsDir = path.join(makeDir("cu-v2-runs-"), "runs");
	try {
		const b1 = beginStep({ step: "B1", expectCommit: head, runsDir, cwd: repo });
		assert.equal(b1.commit, head);
		const passingB1 = [
			{ area: "gate", action: "verdict", result: "pass", note: "minutes_left=40" },
			{ area: "direct L2", action: "click", result: "pass", note: "outcome=worked delivery=l2 helperAlive=true" },
			{ area: "helper", action: "still alive", result: "pass", note: "" },
			{ area: "background", action: "agent HID events", result: "pass", note: "agentEvents 10 → 10 (+0)" },
			{ area: "background", action: "focus taken", result: "pass", note: "owned/helper focus events=0" },
			{ area: "background", action: "cursor warped", result: "pass", note: "static source check: no cursor positioning APIs" },
			{ area: "run", action: "real user input", result: "recorded", note: "userEvents 10 → 12" },
		];
		const written = writeRunArchive({ runsDir, runName: "b1.md", title: "B1", step: "B1", commit: head, rows: passingB1 });
		assert.equal(written.verdict, "pass");
		assert.equal(readStopMarker(runsDir), null);

		// The worktree is untouched, so the freeze still holds and B2 may start.
		assert.deepEqual(gitState({ cwd: repo }).dirtyPaths, []);
		const b2 = beginStep({ step: "B2", expectCommit: head, runsDir, cwd: repo });
		assert.equal(b2.step, "B2");
		assert.equal(findPassingRun({ step: "B1", commit: head, runsDir })?.name, "b1.md");

		// And the old failure mode is still a refusal: an archive written into the worktree
		// makes every later step see a dirty tree.
		writeFileSync(path.join(repo, "stray.md"), "x\n");
		assert.throws(() => beginStep({ step: "B2", expectCommit: head, runsDir, cwd: repo }), (error) => error instanceof StepRefused && /not clean/.test(error.message));
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("searching commits for a passing step", () => {
	const runsDir = makeDir();
	try {
		archive(runsDir, "b1-1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		archive(runsDir, "b1-2.md", { step: "B1", commit: HEAD, verdict: "pass" });
		archive(runsDir, "b2.md", { step: "B2", commit: HEAD, verdict: "fail" });
		// Newest by name: the archive names start with the run stamp.
		assert.equal(findPassingRun({ step: "B1", commit: HEAD, runsDir })?.name, "b1-2.md");
		assert.equal(findPassingRun({ step: "B2", commit: HEAD, runsDir }), undefined);
		// A pass under a different commit does not authorize this one.
		assert.equal(findPassingRun({ step: "B1", commit: OTHER, runsDir }), undefined);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("archives without the three lines are not evidence", () => {
	const runsDir = makeDir();
	try {
		writeFileSync(path.join(runsDir, "2026-11-06T2017-matrix-third.md"), "| App | Action |\n| --- | --- |\n");
		assert.equal(findPassingRun({ step: "B2", commit: HEAD, runsDir }), undefined);
		const text = "Step: B3-live\nCommit: 1111111\nVerdict: pass\n";
		assert.equal(stepOfArchive(text), "B3-live");
		assert.equal(verdictOfArchive(text), "pass");
		assert.equal(commitOfArchive(text), "1111111");
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("B1 needs no predecessor; B2 needs a B1 pass on the same commit", () => {
	const runsDir = makeDir();
	try {
		requirePreviousStepsPassed({ step: "B1", commit: HEAD, runsDir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: HEAD, runsDir }), (error) => error instanceof StepRefused && /B1 passed/.test(error.message));
		archive(runsDir, "b1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		requirePreviousStepsPassed({ step: "B2", commit: HEAD, runsDir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: OTHER, runsDir }), (error) => error instanceof StepRefused);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("K3: B3 needs both the live check and the acceptance run", () => {
	const runsDir = makeDir();
	try {
		archive(runsDir, "B1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		// Without B2 there is no B3 at all, and the message names the step that is missing.
		assert.throws(() => requirePreviousStepsPassed({ step: "B3-live", commit: HEAD, runsDir }), (error) => error instanceof StepRefused && /B2 passed/.test(error.message));
		archive(runsDir, "B2.md", { step: "B2", commit: HEAD, verdict: "pass" });
		requirePreviousStepsPassed({ step: "B3-live", commit: HEAD, runsDir });
		archive(runsDir, "b3-live.md", { step: "B3-live", commit: HEAD, verdict: "pass" });
		requirePreviousStepsPassed({ step: "B3-acceptance", commit: HEAD, runsDir });
		// A live pass alone must not open B4.
		assert.throws(() => requirePreviousStepsPassed({ step: "B4", commit: HEAD, runsDir }), /B3-acceptance passed/);
		archive(runsDir, "b3-acceptance.md", { step: "B3-acceptance", commit: HEAD, verdict: "pass" });
		requirePreviousStepsPassed({ step: "B4", commit: HEAD, runsDir });
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("B6 cannot jump the steps that have no script yet", () => {
	const runsDir = makeDir();
	try {
		for (const step of ["B1", "B2", "B3-live", "B3-acceptance"]) archive(runsDir, `${step}.md`, { step, commit: HEAD, verdict: "pass" });
		assert.equal(STEP_SCRIPTS.B4, null);
		assert.equal(STEP_SCRIPTS.B5, null);
		assert.throws(() => requirePreviousStepsPassed({ step: "B6", commit: HEAD, runsDir }), (error) => error instanceof StepRefused && /B4 passed/.test(error.message));
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("K4: exactly one script owns B6", () => {
	const owners = Object.entries(STEP_SCRIPTS).filter(([, script]) => script && script.includes("--with-hid"));
	assert.deepEqual(owners.map(([step]) => step), ["B6"]);
	assert.equal(STEP_SCRIPTS.B6, "scripts/check-cu-v2-live.mjs --with-hid");
	assert.equal(STEP_SCRIPTS["B3-live"], "scripts/check-cu-v2-live.mjs");
	assert.deepEqual([...B_STEPS], ["B1", "B2", "B3-live", "B3-acceptance", "B4", "B5", "B6"]);
});

test("an unknown step name is refused instead of guessed", () => {
	assert.throws(() => requirePreviousStepsPassed({ step: "B7", commit: HEAD, runsDir: makeDir() }), (error) => error instanceof StepRefused);
	assert.throws(() => evaluateStep({ step: "B7", rows: [] }), (error) => error instanceof StepRefused && /no row contract/.test(error.message));
});

test("one failing row writes the stop marker, and only the operator removes it", () => {
	const runsDir = makeDir();
	try {
		const clean = [
			{ area: "gate", action: "verdict", result: "pass", note: "" },
			{ area: "background", action: "agent HID events", result: "pass", note: "" },
			{ area: "background", action: "focus taken", result: "pass", note: "" },
			{ area: "background", action: "cursor warped", result: "pass", note: "" },
		];
		assert.equal(finishStep({ step: "B2", commit: HEAD, runsDir, rows: [...clean, { area: "Fixture", action: "observe", result: "pass", note: "" }], run: "b2.md" }).verdict, "pass");
		assert.equal(readStopMarker(runsDir), null);

		const blocked = finishStep({ step: "B2", commit: HEAD, runsDir, rows: [...clean, { area: "Fixture", action: "press", result: "fail", note: "code=timeout" }], run: "b2.md" });
		assert.equal(blocked.verdict, "fail");
		const marker = readStopMarker(runsDir);
		assert.equal(marker.step, "B2");
		assert.equal(marker.commit, HEAD);
		assert.match(marker.reason, /press = fail/);
		assert.match(marker.at, /^\d{4}-\d{2}-\d{2}T/);

		// Every later step refuses before it even reads the gate.
		assert.throws(() => beginStep({ step: "B3-live", expectCommit: HEAD, runsDir, exec: fakeGit() }), (error) => error instanceof StepRefused && /B-STOPPED/.test(error.message));
		assert.throws(() => requireNoStopMarker(runsDir), (error) => error instanceof StepRefused && /only the operator/.test(error.message));

		// An unparsable marker still stops the phase: a corrupt file is not a pass.
		writeFileSync(path.join(runsDir, "B-STOPPED"), "garbage");
		assert.throws(() => requireNoStopMarker(runsDir), (error) => error instanceof StepRefused);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("beginStep runs its checks in order: runs dir, marker, freeze, predecessor", () => {
	const runsDir = makeDir();
	try {
		assert.throws(() => beginStep({ step: "B2", expectCommit: HEAD, exec: fakeGit() }), (error) => error instanceof Error && /--runs-dir/.test(error.message));
		assert.throws(() => beginStep({ step: "B2", expectCommit: undefined, runsDir, exec: fakeGit() }), (error) => error instanceof Error && /--expect-commit/.test(error.message));
		assert.throws(() => beginStep({ step: "B2", expectCommit: HEAD, runsDir, exec: fakeGit() }), (error) => error instanceof Error && /B1 passed/.test(error.message));
		archive(runsDir, "b1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		const started = beginStep({ step: "B2", expectCommit: HEAD, runsDir, exec: fakeGit() });
		assert.deepEqual(started, { step: "B2", commit: HEAD, runsDir, reportOnly: false });
		const warned: string[] = [];
		beginStep({ step: "B2", expectCommit: HEAD, runsDir, exec: fakeGit(), warn: (message) => warned.push(message) });
		assert.match(warned.at(-1)!, /previous steps passed/);
		writeStopMarker({ runsDir, step: "B2", commit: HEAD, reason: "manual" });
		assert.throws(() => beginStep({ step: "B2", expectCommit: HEAD, runsDir, exec: fakeGit() }), (error) => error instanceof Error && /B-STOPPED/.test(error.message));
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

