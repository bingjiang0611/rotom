#!/usr/bin/env node
/**
 * Compatibility matrix runner for Computer Use v2.
 *
 * The matrix answers one question per cell: with this delivery level, does this
 * app accept this action without touching the user's foreground? It only reports
 * what it observed; an action that returns `didnt` or `unknown` stays a failure
 * cell, and a cell that was never run stays `not-run` — the matrix never infers
 * success from a neighbouring app.
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-compat-matrix.mjs --apps /tmp/cu-fixture.app \
 *     --runs-dir ~/cu-v2-runs --expect-commit <frozen sha> \
 *     --window-start 2026-11-06T19:53:21-0800 --window-minutes 60
 *
 * This is B2. Everything it writes goes to `--runs-dir`, outside the worktree (review 6
 * K1): an archive inside it would either dirty the tree or have to be committed, and a
 * commit moves HEAD off the frozen commit, so no later step could ever start.
 *
 * Apps: only disposable fixture copies or equally isolated test applications. Never
 * drives user documents.
 */
import path from "node:path";
import process from "node:process";
import { createBackgroundEvidence } from "./lib/background-evidence.mjs";
import { StepRefused, beginStep, writeRunArchive } from "./lib/b-window.mjs";
import { ensureFixtureWindow, launchFixture } from "./lib/fixture.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { classifyActFailure, recordRealUserInput, withoutHome } from "./lib/live-helpers.mjs";
import { createRunAppOwnership, quitRunOwnedApp } from "./lib/run-owned-apps.mjs";

/** `scripts/` -> `packages/rotom-computer-use` -> `packages` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ACTIONS = ["observe", "focus", "setText", "typeText", "press", "setChecked", "expand", "scrollTo", "select", "setValue"];
// `argument()` is declared below and hoisted. Indexing `process.argv` directly made an
// absent `--delivery` resolve to `process.argv[0]` (the node path), so the first B2 run
// labelled every cell with a policy that does not exist and ran one policy, not three.
const requestedDelivery = argument("--delivery");
const DELIVERY = (requestedDelivery ? requestedDelivery.split(",").map((value) => value.trim()).filter(Boolean) : ["ax_only", "background"]);
if (DELIVERY.includes("foreground")) {
	console.error("[cu-v2 matrix] B2 is background-only; foreground delivery belongs to B5/B6");
	process.exit(2);
}

if (process.platform !== "darwin" || (process.env.PI_CU_LIVE ?? "") !== "1") {
	console.log("[cu-v2 matrix] not run: needs macOS and PI_CU_LIVE=1 with a real helper");
	process.exit(0);
}

/** The authorization-window gate runs before any application is touched. */
function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

// Review 6 P1: stopped phase, frozen commit, previous step. Any of the three is a
// refusal (exit 2) and nothing on the desktop is touched.
const STEP = "B2";
let frozen;
try {
	frozen = beginStep({ step: STEP, expectCommit: argument("--expect-commit"), runsDir: argument("--runs-dir"), cwd: REPO_ROOT });
} catch (error) {
	console.error(`[cu-v2 matrix] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(error instanceof StepRefused ? 2 : 1);
}

let gate;
try {
	gate = await requireGate({
		windowStart: argument("--window-start"),
		windowMinutes: argument("--window-minutes"),
	});
} catch (error) {
	console.error(`[cu-v2 matrix] gate: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(error instanceof GateHold ? 1 : 2);
}

const apps = (argument("--apps", "") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (apps.length === 0) {
	console.error("[cu-v2 matrix] pass --apps with bundle ids or app paths");
	process.exit(2);
}

const { macosBackend: rawBackend } = await import("../src/platform/macos/backend.ts");
const { macosHelper: rawHelper } = await import("../src/platform/macos/helper.ts");
const { disposeFixtureRun, prepareFixtureRun } = await import("./lib/fixture.mjs");
const { homedir } = await import("node:os");
const { runStamp } = await import("./lib/live-helpers.mjs");

const rows = [];
const record = (area, action, result, note) => rows.push({ area, action, delivery: "-", result, note });
const runOwnedPids = new Set();
const background = createBackgroundEvidence({ backend: rawBackend, helper: rawHelper, record, ownedPids: runOwnedPids });
const macosBackend = background.backend;
const macosHelper = background.helper;
rows.push({ area: "gate", action: "verdict", delivery: "-", result: "pass", note: `minutes_left=${gate.minutes_left}` });
const diagnostics = await macosHelper.diagnosticsCommand();
background.setHelperPid(diagnostics.pid, diagnostics.invariants);
const activityBefore = await macosHelper.command("userActivity", {}).catch(() => undefined);
const operatorFrontBefore = await macosBackend.getFrontmost().catch(() => undefined);
await background.start();
const runPids = [];

/**
 * A path argument may be a plain .app or a fixture the operator built. Each run gets
 * a fresh copy with its own bundle id, so LaunchServices cannot attach the matrix to
 * a copy that is already running (-10825) and the operator's instance is never the
 * target.
 */
const runRoot = path.join(homedir(), "cu-v2-test", "runs", runStamp());
const prepared = [];
function targetFor(app) {
	if (!app.startsWith("/")) return app;
	const handle = prepareFixtureRun({ sourceApp: app, runRoot });
	prepared.push(handle);
	rows.push({ area: app, action: "fixture copy", delivery: "-", result: "prepared", note: `${handle.bundleId} at ${handle.bundlePath}` });
	return handle.bundlePath;
}

const launchedApps = [];
for (const requested of apps) {
	const app = targetFor(requested);
	const preparedHandle = prepared.find((handle) => handle.bundlePath === app);
	const launchHandle = preparedHandle ?? { bundleId: app, startedPids: createRunAppOwnership() };
	// Every target must have exact launch ownership. A pre-existing bundle-id process is
	// reported as not-run and is never operated.
	await launchFixture(macosBackend, launchHandle).catch((error) => rows.push({ area: app, action: "launch", delivery: "-", result: "fail", note: message(error) }));
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const installed = (await macosBackend.listApps()).find((candidate) => candidate.bundleId === launchHandle.bundleId && launchHandle.startedPids.has(candidate.pid));
	if (!installed) {
		for (const action of ACTIONS) rows.push({ area: app, action, delivery: "-", result: "not-run", note: "app not running" });
		continue;
	}
	background.own(installed.pid);
	if (!preparedHandle) launchedApps.push({ app, pid: installed.pid, startedPids: launchHandle.startedPids });
	let root;
	try {
		root = await ensureFixtureWindow(macosBackend, { pid: installed.pid });
	} catch (error) {
		for (const action of ACTIONS) rows.push({ area: app, action, delivery: "-", result: "not-run", note: `listRoots failed: ${message(error)}` });
		continue;
	}
	if (!root) {
		for (const action of ACTIONS) rows.push({ area: app, action, delivery: "-", result: "not-run", note: "no window" });
		continue;
	}
	let look;
	try {
		look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
		rows.push({ area: app, action: "observe", delivery: "-", result: "pass", note: `${look.parsedOutline?.nodes?.length ?? 0} nodes, ${look.image ? "image" : "no image"}` });
	} catch (error) {
		rows.push({ area: app, action: "observe", delivery: "-", result: "fail", note: message(error) });
		continue;
	}
	runPids.push(installed.pid);
	for (const policy of DELIVERY) {
		for (const action of ACTIONS.filter((name) => name !== "observe")) {
			const cell = { area: app, action, delivery: policy, result: "not-run", note: "" };
			rows.push(cell);
			look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true }).catch(() => look);
			const ref = wireRefForAction(look, action);
			if (!ref) {
				cell.result = "skip";
				cell.note = "no matching control";
				continue;
			}
			try {
				const result = await macosBackend.act({ lookId: look.lookId, pid: installed.pid, target: { ref }, action: actionFor(action), policy, params: paramsFor(action) }, { timeoutMs: 15_000 });
				cell.result = result?.outcome === "worked" ? "pass" : result?.outcome === "didnt" ? "fail" : "unknown";
				cell.note = `outcome=${result?.outcome ?? "?"} delivery=${result?.performed?.delivery ?? "?"}${result?.performed?.interferedWithUser ? " interfered" : ""}`;
			} catch (error) {
				// Classified by the helper's error code (review 6 P4): matching the message
				// turned `ax_only` correctly refusing `typeText` into a failed cell.
				const classified = classifyActFailure(error);
				cell.result = classified.result;
				cell.note = `code=${classified.code} ${message(error)}`;
			}
		}
	}
	look = undefined;
}

function actionFor(name) {
	return name;
}

function paramsFor(name) {
	if (name === "setText" || name === "typeText") return { text: "cu-matrix" };
	if (name === "setChecked") return { checked: true };
	if (name === "setValue") return { value: 0.5 };
	return {};
}

// The helper only resolves wire refs, and each action needs a control whose role
// actually supports it. A generic "first interactive node" made every cell report
// unsupported_action instead of the app's real behaviour.
function wireRefForAction(look, action) {
	const roles = {
		focus: ["AXTextField", "AXTextArea", "AXSearchField"],
		setText: ["AXTextField", "AXTextArea", "AXSearchField"],
		typeText: ["AXTextField", "AXTextArea", "AXSearchField"],
		press: ["AXButton"],
		setChecked: ["AXCheckBox", "AXSwitch"],
		expand: ["AXDisclosureTriangle"],
		collapse: ["AXDisclosureTriangle"],
		scrollTo: ["AXRow", "AXStaticText"],
		select: ["AXRow"],
		setValue: ["AXSlider"],
	}[action] ?? [];
	const nodes = look?.parsedOutline?.nodes ?? [];
	// Never press a window control: pressing the close button ends the matrix run
	// with "no window" and looks like an app defect.
	const windowControls = new Set(["AXCloseButton", "AXMinimizeButton", "AXFullScreenButton", "AXZoomButton"]);
	const node = nodes.find((candidate) => candidate.wireRef && roles.includes(candidate.role) && !windowControls.has(candidate.subrole));
	return node?.wireRef;
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

const cleanupRecord = (area, action, result, note) => rows.push({ area, action, delivery: "-", result, note });
for (const handle of prepared) {
	const cleanup = await disposeFixtureRun(handle, macosBackend, { record: cleanupRecord }).catch((error) => ({ quit: [], refused: [], remaining: [], removed: false, error: message(error) }));
	rows.push({ area: "cleanup", action: path.basename(handle.bundlePath), delivery: "-", result: cleanup.removed && cleanup.refused.length === 0 ? "removed" : "fail", note: cleanup.error ?? `quit=${cleanup.quit.join(",") || "none"} refused=${cleanup.refused.join(",") || "none"} remaining=${cleanup.remaining.join(",") || "none"}` });
}
for (const launched of launchedApps) {
	const cleanup = await quitRunOwnedApp({ backend: macosBackend, ownedPids: launched.startedPids, pid: launched.pid });
	rows.push({ area: "cleanup", action: launched.app, delivery: "-", result: cleanup.stopped ? "pass" : "fail", note: cleanup.stopped ? `pid=${launched.pid} terminated; force=false` : `pid=${launched.pid} did not confirm termination` });
}

await recordRealUserInput({ helper: macosHelper, backend: macosBackend, record, activityBefore, operatorPid: operatorFrontBefore?.pid, runPids, judged: false });
await background.finish();

const counts = rows.reduce((accumulator, row) => ({ ...accumulator, [row.result]: (accumulator[row.result] ?? 0) + 1 }), {});
const failures = rows.filter((row) => row.result === "fail").length;
const runName = `${runStamp()}-compat-matrix.md`;
const written = writeRunArchive({
	runsDir: frozen.runsDir,
	runName,
	title: "Computer Use v2 compatibility matrix",
	step: frozen.step,
	commit: frozen.commit,
	rows: rows.map((row) => ({ area: row.area, action: row.action, result: row.result, note: withoutHome(row.note) })),
	table: [
		"| App | Action | Delivery policy | Result | Note |",
		"| --- | --- | --- | --- | --- |",
		...rows.map((row) => `| ${row.area} | ${row.action} | ${row.delivery} | ${row.result} | ${withoutHome(row.note).replace(/\|/g, "\\|")} |`),
		"",
		`Cells: ${rows.length} · ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" · ")}`,
		"",
		"`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.",
		"",
		"`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.",
	],
});
if (written.verdict === "fail") process.exitCode = 1;
console.log(`[cu-v2 matrix] wrote ${rows.length} cells (verdict ${written.verdict}) to ${written.path}`);
