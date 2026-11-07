/**
 * Review 6 P1: the B-phase rules as checks, not prose.
 *
 * The interesting cases are the ones the first window walked straight through: a
 * window that commits code, a phase that keeps going after a failure, and a step that
 * runs before its predecessor.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	B_STEPS,
	STEP_SCRIPTS,
	StepRefused,
	beginStep,
	finishStep,
	findPassingRun,
	gitState,
	readStopMarker,
	requireFrozenCommit,
	requireNoStopMarker,
	requirePreviousStepsPassed,
	stepOfArchive,
	verdictOfArchive,
	writeStopMarker,
	commitOfArchive,
} from "../scripts/lib/b-window.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/** A `git` that answers from canned output, so the rules run without a repository. */
function fakeGit({ head = HEAD, status = "", resolve = (sha) => (HEAD.startsWith(sha) ? HEAD : OTHER.startsWith(sha) ? OTHER : undefined) } = {}) {
	return (command, args) => {
		if (args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
		if (args[0] === "status") return status;
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			const resolved = resolve(args[2].replace(/\^\{commit\}$/, ""));
			if (!resolved) throw new Error("not a commit");
			return `${resolved}\n`;
		}
		throw new Error(`unexpected git ${args.join(" ")}`);
	};
}

function makeDir() {
	return mkdtempSync(path.join(tmpdir(), "cu-v2-b-window-"));
}

function archive(dir, name, { step, commit, verdict }) {
	writeFileSync(path.join(dir, name), `# run\n\nStep: ${step}\nCommit: ${commit}\nVerdict: ${verdict}\n`);
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
	const exec = fakeGit();
	assert.deepEqual(requireFrozenCommit({ expectCommit: HEAD.slice(0, 7), exec }), { head: HEAD });
});

test("gitState separates clean, dirty and short heads", () => {
	const clean = gitState({ exec: fakeGit() });
	assert.equal(clean.dirty, false);
	assert.equal(clean.head, HEAD);
	const dirty = gitState({ exec: fakeGit({ status: "?? a\n?? b\n" }) });
	assert.equal(dirty.dirty, true);
	assert.deepEqual(dirty.dirtyPaths, ["?? a", "?? b"]);
});

test("searching commits for a passing step", () => {
	const dir = makeDir();
	try {
		archive(dir, "b1-1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		archive(dir, "b1-2.md", { step: "B1", commit: HEAD, verdict: "pass" });
		archive(dir, "b2.md", { step: "B2", commit: HEAD, verdict: "fail" });
		// Newest by name: the archive names start with the run stamp.
		assert.equal(findPassingRun({ step: "B1", commit: HEAD, dir }).name, "b1-2.md");
		assert.equal(findPassingRun({ step: "B2", commit: HEAD, dir }), undefined);
		// A pass under a different commit does not authorize this one.
		assert.equal(findPassingRun({ step: "B1", commit: OTHER, dir }), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archives without the three lines are not evidence", () => {
	const dir = makeDir();
	try {
		writeFileSync(path.join(dir, "2026-11-06T2041-matrix-third.md"), "| App | Action |\n| --- | --- |\n");
		assert.equal(findPassingRun({ step: "B2", commit: HEAD, dir }), undefined);
		const text = "Step: B2\nCommit: 1111111\nVerdict: pass\n";
		assert.equal(stepOfArchive(text), "B2");
		assert.equal(verdictOfArchive(text), "pass");
		assert.equal(commitOfArchive(text), "1111111");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("B1 needs no predecessor, B2 needs a B1 pass on the same commit", () => {
	const dir = makeDir();
	try {
		requirePreviousStepsPassed({ step: "B1", commit: HEAD, dir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: HEAD, dir }), (error) => error instanceof StepRefused && /B1 passed/.test(error.message));
		archive(dir, "b1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		requirePreviousStepsPassed({ step: "B2", commit: HEAD, dir });
		assert.throws(() => requirePreviousStepsPassed({ step: "B2", commit: OTHER, dir }), (error) => error instanceof StepRefused);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("B6 cannot jump the steps that have no script yet", () => {
	const dir = makeDir();
	try {
		for (const step of ["B1", "B2", "B3"]) archive(dir, `${step}.md`, { step, commit: HEAD, verdict: "pass" });
		assert.equal(STEP_SCRIPTS.B4, null);
		assert.equal(STEP_SCRIPTS.B5, null);
		assert.throws(() => requirePreviousStepsPassed({ step: "B6", commit: HEAD, dir }), (error) => error instanceof StepRefused && /B4 passed/.test(error.message));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown step name is refused instead of guessed", () => {
	assert.throws(() => requirePreviousStepsPassed({ step: "B7", commit: HEAD, dir: makeDir() }), (error) => error instanceof StepRefused);
	assert.deepEqual([...B_STEPS], ["B1", "B2", "B3", "B4", "B5", "B6"]);
});

test("one failing row writes the stop marker, and only the operator removes it", () => {
	const dir = makeDir();
	try {
		assert.equal(finishStep({ step: "B2", commit: HEAD, dir, failures: 0, run: "b2.md" }), "pass");
		assert.equal(readStopMarker(dir), null);

		assert.equal(finishStep({ step: "B2", commit: HEAD, dir, failures: 1, run: "b2.md", reason: "press was unknown" }), "fail");
		const marker = readStopMarker(dir);
		assert.equal(marker.step, "B2");
		assert.equal(marker.commit, HEAD);
		assert.equal(marker.reason, "press was unknown");
		assert.match(marker.at, /^\d{4}-\d{2}-\d{2}T/);

		// Every later step refuses before it even reads the gate.
		assert.throws(() => beginStep({ step: "B3", expectCommit: HEAD, dir, exec: fakeGit() }), (error) => error instanceof StepRefused && /B-STOPPED/.test(error.message));
		assert.throws(() => requireNoStopMarker(dir), (error) => error instanceof StepRefused && /only the operator/.test(error.message));

		// An unparsable marker still stops the phase: a corrupt file is not a pass.
		writeFileSync(path.join(dir, "B-STOPPED"), "garbage");
		assert.throws(() => requireNoStopMarker(dir), (error) => error instanceof StepRefused);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("beginStep runs the checks in order: marker, freeze, predecessor", () => {
	const dir = makeDir();
	try {
		assert.throws(() => beginStep({ step: "B2", expectCommit: undefined, dir, exec: fakeGit() }), (error) => /--expect-commit/.test(error.message));
		assert.throws(() => beginStep({ step: "B2", expectCommit: HEAD, dir, exec: fakeGit() }), (error) => /B1 passed/.test(error.message));
		archive(dir, "b1.md", { step: "B1", commit: HEAD, verdict: "pass" });
		const started = beginStep({ step: "B2", expectCommit: HEAD, dir, exec: fakeGit() });
		assert.deepEqual(started, { step: "B2", commit: HEAD });
		const warned = [];
		beginStep({ step: "B2", expectCommit: HEAD, dir, exec: fakeGit(), warn: (message) => warned.push(message) });
		assert.match(warned.at(-1), /previous steps passed/);
		writeStopMarker({ dir, step: "B2", commit: HEAD, reason: "manual" });
		assert.throws(() => beginStep({ step: "B2", expectCommit: HEAD, dir, exec: fakeGit() }), (error) => /B-STOPPED/.test(error.message));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
