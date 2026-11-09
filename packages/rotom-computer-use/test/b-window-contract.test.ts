/**
 * Review 6 (K2-K4): the rows a step cannot pass without.
 *
 * `Verdict: pass` used to mean only "no row says fail", so B1 could pass with its
 * directed click `inconclusive` and open B2. These tests drive the per-step contracts,
 * the delivery condition on B1, and the split between B3-live and B3-acceptance.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	B_STEPS,
	REPORT_ONLY_STEPS,
	STEP_CONTRACT,
	STEP_SCRIPTS,
	beginStep,
	evaluateStep,
	findPassingRun,
	readStopMarker,
	writeRunArchive,
} from "../scripts/lib/b-window.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const backgroundRows = [
	{ area: "background", action: "agent HID events", result: "pass", note: "" },
	{ area: "background", action: "focus taken", result: "pass", note: "" },
	{ area: "background", action: "cursor warped", result: "pass", note: "" },
];

function makeDir(prefix = "cu-v2-b-contract-") {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

test("K2: B1 does not pass without a directed L2 click", () => {
	const rows = [
		{ area: "gate", action: "verdict", result: "pass", note: "minutes_left=40" },
		{ area: "direct L2", action: "click", result: "inconclusive", note: "outcome=didnt delivery=pid" },
		{ area: "helper", action: "still alive", result: "pass", note: "" },
		...backgroundRows,
	];
	const verdict = evaluateStep({ step: "B1", rows });
	assert.equal(verdict.verdict, "fail");
	assert.match(verdict.blockers.join("\n"), /required row not passing: direct L2 \| click = inconclusive/);

	// A `pass` row whose note does not show the directed transport is not enough either.
	const wrongTransport = rows.map((row) => (row.action === "click" ? { ...row, result: "pass", note: "outcome=worked delivery=pid" } : row));
	assert.match(evaluateStep({ step: "B1", rows: wrongTransport }).blockers.join("\n"), /required row lacks/);

	const passing = rows.map((row) => (row.action === "click" ? { ...row, result: "pass", note: "outcome=worked delivery=l2" } : row));
	assert.deepEqual(evaluateStep({ step: "B1", rows: passing }), { verdict: "pass", blockers: [] });
});

test("K2: the directed text row is required only on an ASCII input source", () => {
	const base = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		{ area: "direct L2", action: "click", result: "pass", note: "delivery=l2" },
		{ area: "helper", action: "still alive", result: "pass", note: "" },
		...backgroundRows,
	];
	const ime = [...base, { area: "environment", action: "input source", result: "inconclusive", note: "input method com.sogou" }];
	assert.equal(evaluateStep({ step: "B1", rows: ime }).verdict, "pass");
	const ascii = [...base, { area: "environment", action: "input source", result: "pass", note: "layout ABC" }, { area: "direct L2", action: "typeText", result: "skipped", note: "" }];
	const verdict = evaluateStep({ step: "B1", rows: ascii });
	assert.equal(verdict.verdict, "fail");
	assert.match(verdict.blockers.join("\n"), /required row not passing: direct L2 \| typeText = skipped/);
});

test("K2: real user input is recorded but does not block B0-B4", () => {
	const rows = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		{ area: "direct L2", action: "click", result: "pass", note: "delivery=l2" },
		{ area: "helper", action: "still alive", result: "pass", note: "" },
		...backgroundRows,
		{ area: "run", action: "real user input", result: "recorded", note: "userEvents 10 → 14" },
	];
	assert.equal(evaluateStep({ step: "B1", rows }).verdict, "pass");
	assert.equal(evaluateStep({ step: "B1", rows: rows.filter((row) => row.action !== "real user input") }).verdict, "pass");
});

test("K2/K4: B6 needs both HID rows and the restore, or it fails", () => {
	const rows = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		{ area: "act", action: "click went through HID", result: "pass", note: "delivery=hid" },
		{ area: "act", action: "click took effect", result: "unknown", note: "outcome=unknown" },
		{ area: "restore", action: "operator app", result: "pass", note: "" },
		{ area: "run", action: "real user input", result: "pass", note: "" },
	];
	assert.match(evaluateStep({ step: "B6", rows }).blockers.join("\n"), /click took effect = unknown/);
	const effects = rows.map((row) => (row.action === "click took effect" ? { ...row, result: "pass" } : row));
	assert.equal(evaluateStep({ step: "B6", rows: effects }).verdict, "pass");
});

test("an archive names its blockers instead of leaving the reader to scan", () => {
	const runsDir = makeDir();
	try {
		const rows = [
			{ area: "gate", action: "verdict", result: "pass", note: "" },
			{ area: "run", action: "real user input", result: "pass", note: "" },
		];
		const written = writeRunArchive({ runsDir, runName: "b2.md", title: "B2", step: "B2", commit: HEAD, rows });
		assert.equal(written.verdict, "fail");
		const text = readFileSync(written.path, "utf8");
		assert.match(text, /^Verdict: fail$/m);
		assert.match(text, /^Blockers: 4$/m);
		assert.match(text, /an observe cell/);
		assert.match(text, /agent HID events/);
		assert.match(text, /focus taken/);
		assert.match(text, /cursor warped/);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("every scripted step declares the rows it cannot pass without", () => {
	for (const [step, contract] of Object.entries(STEP_CONTRACT)) assert.ok(contract.length > 0, `${step} needs a contract`);
	for (const step of ["B0", "B1", "B2", "B3-live", "B3-acceptance", "B4"] as const) {
		for (const action of ["agent HID events", "focus taken", "cursor warped"]) {
			assert.ok(STEP_CONTRACT[step].some((row) => row.action === action), `${step} must require ${action}`);
		}
		assert.ok(!STEP_CONTRACT[step].some((row) => row.action === "real user input"), `${step} must not gate on user activity`);
		assert.ok(!STEP_CONTRACT[step].some((row) => row.action === "operator app"), `${step} must not require restore`);
	}
	assert.ok(STEP_CONTRACT.B1.some((row) => row.note instanceof RegExp), "B1 must demand the directed transport");
});

test("K3: B3-live and B3-acceptance judge different rows", () => {
	const common = [
		{ area: "gate", action: "verdict", result: "pass", note: "" },
		...backgroundRows,
	];
	// A live check with no semantic action that passed is not a live check.
	const live = [...common, { area: "act", action: "focus", result: "unknown", note: "outcome=unknown" }];
	assert.match(evaluateStep({ step: "B3-live", rows: live }).blockers.join("\n"), /a semantic action/);
	const livePass = [...live.map((row) => (row.action === "focus" ? { ...row, result: "pass" } : row))];
	assert.equal(evaluateStep({ step: "B3-live", rows: livePass }).verdict, "pass");
	// The acceptance run's evidence is its agents, so a live pass says nothing about it.
	assert.match(evaluateStep({ step: "B3-acceptance", rows: livePass }).blockers.join("\n"), /an agent click/);
	const acceptance = [...common, { area: "agent 1", action: "click", result: "pass", note: "" }];
	assert.equal(evaluateStep({ step: "B3-acceptance", rows: acceptance }).verdict, "pass");
});

test("R2: B0 is a report-only step that authorizes nothing", () => {
	const runsDir = makeDir();
	const exec = (command: string, args: string[]) => {
		if (args[0] === "rev-parse" && args[1] === "HEAD") return `${HEAD}\n`;
		if (args[0] === "status") return "";
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `/repo\n`;
		if (args[0] === "rev-parse" && args[1] === "--verify") return `${HEAD}\n`;
		throw new Error(`unexpected git ${args.join(" ")}`);
	};
	try {
		assert.ok(REPORT_ONLY_STEPS.includes("B0"));
		assert.ok(!B_STEPS.includes("B0"));
		// No predecessor is required, because it is not part of the ladder.
		const started = beginStep({ step: "B0", expectCommit: HEAD, runsDir, exec: exec as never });
		assert.equal(started.reportOnly, true);

		// Even with a failing row, a report-only archive writes no marker and no verdict.
		const written = writeRunArchive({
			runsDir,
			runName: "b0.md",
			title: "B0 attribution",
			step: "B0",
			commit: HEAD,
			rows: [{ area: "run", action: "real user input", result: "fail", note: "userEvents 0 → 72" }],
			reportOnly: true,
		});
		assert.equal(written.verdict, "report");
		assert.equal(written.blockers.length, 0);
		assert.equal(readStopMarker(runsDir), null);
		const text = readFileSync(written.path, "utf8");
		assert.match(text, /Step: B0/);
		assert.match(text, /不放行任何步骤/);
		// The note line names the token, so the check is "no line starts with it".
		assert.doesNotMatch(text, /^Verdict:/m);

		// And the report cannot open B1: B1 needs nothing, B2 needs a passing B1 archive.
		assert.equal(findPassingRun({ step: "B0", commit: HEAD, runsDir }), undefined);
		assert.equal(findPassingRun({ step: "B1", commit: HEAD, runsDir }), undefined);
	} finally {
		rmSync(runsDir, { recursive: true, force: true });
	}
});
