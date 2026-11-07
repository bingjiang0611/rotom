/**
 * The dry run that actually executes `cu-v2-l2-check.mjs` (review 8, T1).
 *
 * Three of the four wasted windows failed on something a Linux run of the main path would
 * have caught (`alive is not defined`, a gate report that never parsed, a delivery default
 * of `process.argv[0]`). Grepping the source could not see any of them, so this spawns the
 * whole script as a subprocess against `fake-cu-backend.mjs` and reads the archive it writes.
 *
 * Everything lands in temporary directories: a throwaway git repository for the frozen-commit
 * bookkeeping, a temporary runs directory, and a temporary HOME so the script's own
 * `~/cu-v2-test/runs` staging area is not the operator's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expectedFixtureSourceDigest } from "./l2-env.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "cu-v2-l2-check.mjs");
const FAKE = path.join(import.meta.dirname, "fake-cu-backend.mjs");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "cu-v2 dry run",
	GIT_AUTHOR_EMAIL: "dry-run@example.invalid",
	GIT_COMMITTER_NAME: "cu-v2 dry run",
	GIT_COMMITTER_EMAIL: "dry-run@example.invalid",
};

/** A throwaway repository: `requireRunsDir` refuses paths inside the checkout it is given. */
function tempRepo() {
	const dir = mkdtempSync(path.join(tmpdir(), "cu-v2-exec-repo-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
	writeFileSync(path.join(dir, "README.md"), "dry run\n");
	execFileSync("git", ["-C", dir, "add", "README.md"], { env: GIT_ENV });
	execFileSync("git", ["-C", dir, "commit", "-qm", "dry run"], { env: GIT_ENV });
	return dir;
}

/** A bundle that carries the digest of the frozen source, which is all the script checks. */
function fixtureBundle({ digest = expectedFixtureSourceDigest(PACKAGE_ROOT) } = {}) {
	const app = path.join(mkdtempSync(path.join(tmpdir(), "cu-v2-exec-app-")), "Fixture.app");
	mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
	mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
	writeFileSync(
		path.join(app, "Contents", "Info.plist"),
		'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.cu-fixture</string></dict></plist>\n',
	);
	writeFileSync(path.join(app, "Contents", "MacOS", "Fixture"), "");
	if (digest) writeFileSync(path.join(app, "Contents", "Resources", "source.sha256"), `${digest}\n`);
	return app;
}

function runScript({ scenario = "pass", args = [], app = fixtureBundle(), repo = tempRepo() } = {}) {
	const runsDir = mkdtempSync(path.join(tmpdir(), "cu-v2-exec-runs-"));
	const home = mkdtempSync(path.join(tmpdir(), "cu-v2-exec-home-"));
	const spawned = spawnSync(
		process.execPath,
		// `--direct-l2` is what the live B0/B1 command uses, and the rows it produces are the
		// ones the B1 contract requires; without it the run would pass while skipping them.
		[SCRIPT, "--fixture", app, "--runs-dir", runsDir, "--window-start", "2026-01-01T00:00:00+0000", "--window-minutes", "60", "--direct-l2", ...args],
		{
			encoding: "utf8",
			timeout: 120_000,
			env: { ...process.env, HOME: home, PI_CU_FAKE_BACKEND: FAKE, PI_CU_FAKE_REPO: repo, PI_CU_FAKE_SCENARIO: scenario },
		},
	);
	const archives = readdirSync(runsDir).filter((name) => name.endsWith(".md"));
	return {
		status: spawned.status,
		signal: spawned.signal,
		stdout: spawned.stdout ?? "",
		stderr: spawned.stderr ?? "",
		runsDir,
		marker: readdirSync(runsDir).includes("B-STOPPED"),
		archive: archives.length === 1 ? readFileSync(path.join(runsDir, archives[0]), "utf8") : undefined,
		archives,
		cleanup() {
			rmSync(runsDir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			rmSync(repo, { recursive: true, force: true });
		},
	};
}

/** One row of the archive, or undefined when the run never wrote one. */
function row(archive, area, action) {
	const match = new RegExp(`^\\| ${area} \\| ${action} \\| ([a-z]+) \\|`, "m").exec(archive ?? "");
	return match?.[1];
}

function expectOk(result, message) {
	if (result.status !== 0) throw new Error(`${message}: exit ${result.status}${result.signal ? ` (${result.signal})` : ""}\n${result.stderr.slice(-600)}${result.stdout.slice(-600)}`);
}

export const executionChecks = [
	{
		name: "T1: the script runs end to end on a fake backend (B0 reports, authorizes nothing)",
		run: () => {
			const result = runScript({ scenario: "pass", args: ["--b0-attribution"] });
			try {
				expectOk(result, "B0 run");
				const archive = result.archive;
				if (!archive) throw new Error("B0 wrote no archive");
				if (/^Verdict:/m.test(archive)) throw new Error("B0 wrote a Verdict line, so it authorizes a step");
				if (result.marker) throw new Error("B0 wrote B-STOPPED");
				if (row(archive, "fixture", "present") !== "pass") throw new Error(`fixture | present = ${row(archive, "fixture", "present")}; the fake fixture never launched`);
				if (row(archive, "fixture", "launch") !== undefined) throw new Error("the fake launch failed");
				if (row(archive, "attribution", "ring") !== undefined && row(archive, "attribution", "ring") !== "pass") throw new Error("the fake helper reported no ring");
				if (!/\| attribution \| summary \| recorded \|/.test(archive)) throw new Error("no attribution summary row");
				const effect = /\| direct L2 \| click effect \| pass \| before=clicks:(\d+) after=clicks:(\d+)/.exec(archive);
				if (!effect) throw new Error("the directed click was not judged against the fixture counter");
				if (Number(effect[2]) !== Number(effect[1]) + 1) throw new Error(`the directed click moved the counter ${effect[1]} → ${effect[2]}`);
				return `fixture launched, click ${effect[1]} → ${effect[2]}, attribution recorded, no Verdict, no marker`;
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T1: a passing B1 run writes Verdict: pass and no marker",
		run: () => {
			const result = runScript({ scenario: "pass" });
			try {
				expectOk(result, "B1 run");
				if (!/^Verdict: pass$/m.test(result.archive ?? "")) throw new Error(`no passing verdict:\n${(result.archive ?? "no archive").slice(0, 800)}`);
				if (result.marker) throw new Error("a passing run wrote B-STOPPED");
				for (const [area, action] of [["gate", "verdict"], ["helper", "still alive"], ["restore", "operator app"], ["run", "real user input"]]) {
					const value = row(result.archive, area, action);
					if (value !== "pass") throw new Error(`${area} | ${action} = ${value ?? "missing"}, which the B1 contract requires`);
				}
				return "every required B1 row passed";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T1: a directed click that does not land fails the step and stops the phase",
		run: () => {
			const result = runScript({ scenario: "fail" });
			try {
				if (result.status !== 1) throw new Error(`expected exit 1, got ${result.status}`);
				const archive = result.archive ?? "";
				if (!/^Verdict: fail$/m.test(archive)) throw new Error("a failed click did not produce Verdict: fail");
				if (!result.marker) throw new Error("the failed step wrote no B-STOPPED marker");
				const effect = /direct L2 \| click \| (\w+) \|/.exec(archive)?.[1];
				if (effect === "pass") throw new Error("a click that never landed was judged pass");
				return `${effect ?? "failed"} on the click row, marker written`;
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T2: a ring that disappears mid-run is a failure, not an empty summary",
		run: () => {
			const result = runScript({ scenario: "ring-lost", args: ["--b0-attribution"] });
			try {
				expectOk(result, "ring-lost run");
				const archive = result.archive ?? "";
				if (!/attribution \| ring \| fail \|/.test(archive)) throw new Error(`a missing ring was not reported:\n${archive.slice(0, 800)}`);
				if (/attribution \| summary \|/.test(archive)) throw new Error("a missing ring was still summarised as zero unmarked events");
				return "attribution | ring = fail, no summary row";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T2: a ring that disagrees with the counters is a failure",
		run: () => {
			const result = runScript({ scenario: "lost-events", args: ["--b0-attribution"] });
			try {
				expectOk(result, "lost-events run");
				if (!/attribution \| ring complete \| fail \|/.test(result.archive ?? "")) throw new Error(`no reconciliation failure:\n${(result.archive ?? "").slice(0, 800)}`);
				return "ring complete = fail";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T3: a helper that cannot attribute is refused before an app is launched",
		run: () => {
			const result = runScript({ scenario: "no-support", args: ["--b1"] });
			try {
				if (result.status !== 2) throw new Error(`expected exit 2, got ${result.status}`);
				if (result.marker) throw new Error("an environment refusal wrote B-STOPPED");
				if (result.archives.length !== 0) throw new Error(`a refusal wrote an archive: ${result.archives.join(",")}`);
				if (!/recentEventLimit/.test(result.stderr)) throw new Error(`the refusal did not name the missing capability:\n${result.stderr.slice(-400)}`);
				return "exit 2, no archive, no marker";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T3: a fixture built from other source is refused before it is launched",
		run: () => {
			const result = runScript({ app: fixtureBundle({ digest: "f".repeat(64) }) });
			try {
				if (result.status !== 2) throw new Error(`expected exit 2, got ${result.status}`);
				if (result.marker || result.archives.length !== 0) throw new Error("a fixture refusal wrote something");
				if (!/built from other source/.test(result.stderr)) throw new Error(`the refusal did not explain itself:\n${result.stderr.slice(-400)}`);
				return "exit 2 with the digest mismatch named";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "a gate hold names the missing helper instead of leaving it to guesswork",
		run: () => {
			const result = runScript({ scenario: "gate-hold", args: ["--b0-attribution"] });
			try {
				if (result.status !== 1) throw new Error(`expected exit 1, got ${result.status}`);
				const archive = result.archive ?? "";
				const note = /\| gate \| verdict \| fail \| (.*) \|/.exec(archive)?.[1] ?? "";
				if (!/helper_error=/.test(note)) throw new Error(`the hold row does not say why: ${note}`);
				if (!/daemon is unavailable/.test(note)) throw new Error(`the helper error was dropped: ${note}`);
				if (result.marker) throw new Error("a gate hold wrote B-STOPPED");
				if (/\| fixture \| launch/.test(archive)) throw new Error("the run kept going after the hold");
				return "the row carries helper_error and nothing was launched";
			} finally {
				result.cleanup();
			}
		},
	},
	{
		name: "T1: the fake backend cannot be combined with --expect-commit",
		run: () => {
			const result = runScript({ args: ["--expect-commit", "a".repeat(40)] });
			try {
				if (result.status !== 2) throw new Error(`expected exit 2, got ${result.status}`);
				if (!/not evidence/.test(result.stderr)) throw new Error(`the refusal did not explain itself:\n${result.stderr.slice(-400)}`);
				return "exit 2 before anything ran";
			} finally {
				result.cleanup();
			}
		},
	},
];
