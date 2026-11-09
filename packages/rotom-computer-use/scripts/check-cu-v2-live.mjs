#!/usr/bin/env node
/**
 * Computer Use v2 live check (macOS, real helper, real windows).
 *
 * Never part of `npm test`: it is gated behind `PI_CU_LIVE=1`, it drives a real
 * helper, and it types into a real application. It only touches the fixture app
 * and deliberately read-only system surfaces, never user documents.
 *
 *   PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture ~/cu-v2-test/Fixture.app \
 *     --sign-identity "Apple Development: ... (TEAMID)" \
 *     --runs-dir ~/cu-v2-runs --expect-commit <frozen sha> \
 *     --window-start 2026-11-06T19:53:21-0800 --window-minutes 60
 *
 * This is `B3-live`; with `--with-hid` it is the only script that owns B6 (review 6 K4).
 * Everything it writes goes to `--runs-dir`, outside the worktree (K1).
 *
 * Point it at an isolated helper so a running session keeps its own daemon:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock \
 *   PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture ~/cu-v2-test/Fixture.app
 *
 * What it proves when it passes:
 *   - the helper answers the current helper protocol and reports user activity
 *   - each semantic action reaches a real control and reports a verified outcome
 *   - window, clipboard and system-surface commands answer with real data
 *   - B3 background actions post no HID events, never make the run-owned fixture/helper
 *     frontmost, and use no cursor-warp path
 *
 * What it cannot prove: that no other app on this machine is affected, or that
 * L2 delivery works in apps outside the compatibility list.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
/** `--name value` on the command line, or the fallback. */
function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

import process from "node:process";

import { createBackgroundEvidence } from "./lib/background-evidence.mjs";
import { runHidClick } from "./lib/hid-click.mjs";
import { recordRealUserInput, restoreOperatorApp, runStamp, withoutHome } from "./lib/live-helpers.mjs";
import { StepRefused, beginStep, writeRunArchive } from "./lib/b-window.mjs";
import { bringUpFixture, disposeFixtureRun, ensureFixtureWindow } from "./lib/fixture.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";

/** `scripts/` -> `packages/rotom-computer-use` -> `packages` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** Set by `beginStep`: the frozen commit and the step this run is evidence about. */
let frozen;
const rows = [];
const log = [];

function record(area, action, result, note) {
	rows.push({ area, action, result, note: note ?? "" });
	log.push(`${new Date().toISOString()} ${area} ${action} ${result} ${note ?? ""}`);
}

function disabled(reason) {
	console.log(`[cu-v2 live] skipped: ${reason}`);
	console.log("[cu-v2 live] set PI_CU_LIVE=1 on a macOS machine with the helper installed and Accessibility granted");
	process.exit(0);
}

if (process.platform !== "darwin") disabled("not macOS");
if ((process.env.PI_CU_LIVE ?? "") !== "1") disabled("PI_CU_LIVE is not 1");

const { macosHelper: rawHelper } = await import("../src/platform/macos/helper.ts");
const { macosBackend: rawBackend } = await import("../src/platform/macos/backend.ts");
const runOwnedPids = new Set();
const background = createBackgroundEvidence({ backend: rawBackend, helper: rawHelper, record, ownedPids: runOwnedPids });
const macosHelper = background.helper;
const macosBackend = background.backend;

const fixturePath = argument("--fixture");
let fixtureRun;
/**
 * The gate runs here too, not in an operator loop (review G6): no declared window is a
 * refusal, and a hold stops before anything touches the desktop.
 */
async function refuseUnlessGatePasses() {
	try {
		return await requireGate({
			windowStart: argument("--window-start"),
			windowMinutes: argument("--window-minutes"),
		});
	} catch (error) {
		console.error(`[cu-v2 live] gate: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(error instanceof GateHold ? 1 : 2);
	}
}


async function main() {
	// Review 6 P1/K3/K4: `--with-hid` is B6; the plain run is `B3-live`, and the
	// acceptance script's `B3-acceptance` must pass too before B4. The step is declared
	// before anything touches the desktop, and a stopped phase never reaches the gate.
	const withHid = process.argv.includes("--with-hid");
	const step = withHid ? "B6" : "B3-live";
	try {
		frozen = beginStep({ step, expectCommit: argument("--expect-commit"), runsDir: argument("--runs-dir"), cwd: REPO_ROOT });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record("run", "constraints", "refused", message);
		await writeEvidence();
		console.error(`[cu-v2 live] ${message}`);
		process.exit(error instanceof StepRefused ? 2 : 1);
	}
	record("run", "frozen commit", "pass", `${frozen.commit} step=${frozen.step}`);
	await refuseUnlessGatePasses();
	const diagnostics = await macosHelper.diagnosticsCommand();
	// Read the constant instead of repeating the number: the A-phase bump to 9 left this
	// check refusing a correct helper, which reads exactly like a broken install.
	const { HELPER_PROTOCOL_VERSION } = await import("../src/platform/macos/helper.ts");
	record("helper", "diagnostics", diagnostics.protocolVersion === HELPER_PROTOCOL_VERSION ? "pass" : "fail", `protocol=${diagnostics.protocolVersion} expected=${HELPER_PROTOCOL_VERSION}`);
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) throw new Error(`helper must report protocol ${HELPER_PROTOCOL_VERSION}; install/restart the v2 helper in its own socket`);
	if (!diagnostics.accessibility) throw new Error("Accessibility is not granted to the helper");
	record("helper", "permissions", diagnostics.screenRecording ? "pass" : "fail", `accessibility=${diagnostics.accessibility} screenRecording=${diagnostics.screenRecording} executable=${diagnostics.executablePath}`);
	if (!withHid) {
		background.setHelperPid(diagnostics.pid, diagnostics.invariants);
		await background.start();
	}

	const activityBefore = await macosBackend.userActivity();
	record("helper", "userActivity", activityBefore.listening ? "pass" : "fail", `idle=${activityBefore.idleSeconds.toFixed(1)}s userEvents=${activityBefore.userEventCount} agentEvents=${activityBefore.agentEventCount}`);

	if (!fixturePath || !existsSync(fixturePath)) throw new Error("pass --fixture <path to the built fixture app>");
	const identity = argument("--sign-identity") ?? process.env.PI_CU_FIXTURE_SIGN_IDENTITY;
	if (!identity) throw new Error("pass --sign-identity or set PI_CU_FIXTURE_SIGN_IDENTITY so the run can create its own fixture copy");
	const beforeRun = new Set((await macosBackend.listApps()).map((app) => app.pid));
	const runRoot = mkdtempSync(path.join(tmpdir(), "cu-v2-live-fixture-"));
	const broughtUp = await bringUpFixture({
		backend: macosBackend,
		fixturePath,
		runRoot,
		sign: true,
		identity,
		startedByThisRun: (app) => !beforeRun.has(app.pid),
		record,
	});
	const fixture = broughtUp.fixture;
	fixtureRun = broughtUp.run;
	if (!fixture) throw new Error("the run-owned fixture copy did not launch");
	if (!withHid) background.own(fixture.pid);

	const frontmostBefore = await macosBackend.getFrontmost();

	// The fixture orders its window behind the user's windows without activating the application.
	const root = await ensureFixtureWindow(macosBackend, { pid: fixture.pid, bundleId: fixture.bundleId });
	if (!root) throw new Error("the fixture window is not in listRoots");
	record("root", "listRoots", root.windowId > 0 ? "pass" : "fail", `windowId=${root.windowId} frame=${JSON.stringify(root.framePoints)}`);

	const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
	record("observe", "window", look.image ? "pass" : "fail", `lookId=${look.lookId} imageWidth=${look.image?.width ?? 0} nodes=${countNodes(look.outline)}`);

	// outline refs are display refs (`@eN`); the helper only resolves wire refs.
	const controls = {
		text: wireRefByRole(look, ["AXTextField"]),
		checkbox: wireRefByRole(look, ["AXCheckBox", "AXSwitch"]),
		slider: wireRefByRole(look, ["AXSlider"]),
		row: wireRefByRole(look, ["AXRow"]),
		tree: wireRefByRole(look, ["AXDisclosureTriangle"]),
	};
	for (const [name, ref] of Object.entries(controls)) {
		record("outline", `find ${name}`, ref ? "pass" : "fail", ref ?? "not found");
	}

	await runAction("focus", () => actOn(look, fixture.pid, { action: "focus", ref: controls.text }));
	await runAction("setText", () => actOn(look, fixture.pid, { action: "setText", ref: controls.text, params: { text: "fixture text" } }));
	await runAction("clear", () => actOn(look, fixture.pid, { action: "clear", ref: controls.text }));
	await runAction("setChecked", () => actOn(look, fixture.pid, { action: "setChecked", ref: controls.checkbox, params: { checked: true } }));
	await runAction("setValue", () => actOn(look, fixture.pid, { action: "setValue", ref: controls.slider, params: { value: 0.75 } }));
	await runAction("select", () => actOn(look, fixture.pid, { action: "select", ref: controls.row }));
	await runAction("collapse", () => actOn(look, fixture.pid, { action: "collapse", ref: controls.tree }));
	await runAction("expand", () => actOn(look, fixture.pid, { action: "expand", ref: controls.tree }));

	const readFrame = async () => (await macosBackend.listRoots({ pid: fixture.pid })).find((candidate) => candidate.kind === "window")?.framePoints;
	// Move and resize to values that differ from the current frame, and judge each
	// mutation on its own: apps may clamp sizes, and a resize can re-center a window.
	const moveFrom = await readFrame();
	const moveTo = { x: Math.round(moveFrom.x) + 44, y: Math.round(moveFrom.y) + 44 };
	await runAction("manageWindow.move", () => macosBackend.manageWindow({ mode: "move", pid: fixture.pid, windowId: root.windowId, x: moveTo.x, y: moveTo.y }));
	const moveAfter = await readFrame();
	record("manageWindow", "moved", Math.abs(moveAfter.x - moveTo.x) <= 2 && Math.abs(moveAfter.y - moveTo.y) <= 2 ? "pass" : "fail", `${JSON.stringify(moveFrom)} → ${JSON.stringify(moveAfter)}`);

	const resizeFrom = await readFrame();
	// Stay away from both clamps: the fixture enforces a minimum size and the screen
	// caps the maximum, so shrink when there is room and grow when there is not.
	const resizeTo = { w: resizeFrom.w - 48 >= 440 ? Math.round(resizeFrom.w) - 48 : Math.round(resizeFrom.w) + 48, h: Math.round(resizeFrom.h) };
	await runAction("manageWindow.resize", () => macosBackend.manageWindow({ mode: "resize", pid: fixture.pid, windowId: root.windowId, w: resizeTo.w, h: resizeTo.h }));
	const resizeAfter = await readFrame();
	record("manageWindow", "resized", Math.abs(resizeAfter.w - resizeTo.w) <= 2 ? "pass" : "fail", `asked ${JSON.stringify(resizeTo)}; got ${JSON.stringify(resizeAfter)}`);

	const clipboardBefore = await macosBackend.clipboardGet();
	await macosBackend.clipboardSet("cu-v2 live clipboard probe");
	const clipboardAfter = await macosBackend.clipboardGet();
	record("clipboard", "set+get", clipboardAfter.text === "cu-v2 live clipboard probe" ? "pass" : "fail", `changeCount ${clipboardBefore.changeCount} → ${clipboardAfter.changeCount}`);
	await macosBackend.clipboardClear();
	record("clipboard", "clear", (await macosBackend.clipboardGet()).text === "" ? "pass" : "fail", "cleared after probe");

	for (const surface of ["notifications", "menu_bar_extras", "control_center", "dock"]) {
		try {
			const result = await macosBackend.systemSurfaces(surface);
			const entry = result?.[surface] ?? result?.surfaces?.[surface];
			record("systemSurfaces", surface, entry?.available ? "pass" : "fail", `roots=${entry?.roots?.length ?? 0}`);
		} catch (error) {
			record("systemSurfaces", surface, "fail", error instanceof Error ? error.message : String(error));
		}
	}

	// HID delivery posts real events through the session tap, so it can move the
	// cursor and raise the target window. Keep it opt-in, and restore the app that
	// was frontmost before the run.
	if (withHid) {
		const hid = await runHidClick({ backend: macosBackend, helper: macosHelper, look, root, fixture, record });
		if (!hid.stopped) {
			// Put the user back where they were, through `focusWindow` with a lease (review 6
			// P2). The previous version re-launched the app - which does nothing for a running
			// app - swallowed the error and called the result `inconclusive`, so B6 could pass
			// while the operator's app stayed behind the fixture.
			await restoreOperatorApp({ backend: macosBackend, original: frontmostBefore, record });
		}
	}

	if (fixtureRun) await disposeFixtureRun(fixtureRun, macosBackend, { record });
	fixtureRun = undefined;
	await recordRealUserInput({ helper: macosHelper, backend: macosBackend, record, activityBefore, operatorPid: frontmostBefore.pid, runPids: [fixture.pid], judged: withHid });
	if (!withHid) await background.finish();

	const failures = rows.filter((row) => row.result === "fail").length;
	const written = await writeEvidence();
	console.log(`[cu-v2 live] ${rows.length} rows, ${failures} failing; ${frozen.step} ${written.verdict}; archive ${written.path}`);
}

async function actOn(look, pid, action) {
	return await macosBackend.act({ lookId: look.lookId, pid, target: { ref: action.ref }, policy: "ax_only", ...action }, { timeoutMs: 20_000 });
}

async function runAction(name, run) {
	try {
		const result = await run();
		const outcome = result?.outcome ?? "unknown";
		const interfered = result?.performed?.interferedWithUser === true;
		// Operator activity may overlap a background action; its own readback decides
		// success, not whether the operator happened to use the Mac at the same time.
		const result_status = result?.ok === false || outcome !== "worked" ? "fail" : "pass";
		record("act", name, result_status, `outcome=${outcome} delivery=${result?.performed?.delivery ?? "?"} mechanism=${result?.performed?.mechanism ?? "-"}${interfered ? " user input overlapped" : ""}`);
	} catch (error) {
		record("act", name, "fail", error instanceof Error ? error.message : String(error));
	}
}

function countNodes(outline) {
	let total = 0;
	walk(outline, () => {
		total += 1;
	});
	return total;
}

// Every serialized node carries its own wire ref, so role lookups stay aligned
// with the look that produced them even when the tree changes shape.
function wireRefByRole(look, roles) {
	const node = (look.parsedOutline?.nodes ?? look.nodes ?? []).find((candidate) => candidate.wireRef && roles.includes(candidate.role));
	return node?.wireRef;
}

function refByRole(outline, roles) {
	let found;
	walk(outline, (node) => {
		if (!found && node.ref && roles.includes(node.role)) found = node.ref;
	});
	return found;
}

function walk(outline, visit) {
	if (!outline) return;
	const stack = [outline];
	while (stack.length) {
		const node = stack.pop();
		visit(node);
		for (const child of node.children ?? []) stack.push(child);
	}
}

async function writeEvidence() {
	const runName = `${runStamp()}-live-check.md`;
	// Without `beginStep` there is no runs directory, so a refusal cannot leave an archive
	// that a later step would read as permission.
	const written = frozen
		? writeRunArchive({
			runsDir: frozen.runsDir,
			runName,
			title: "Computer Use v2 live check",
			step: frozen.step,
			commit: frozen.commit,
			rows: rows.map((row) => ({ ...row, note: withoutHome(row.note) })),
			log: log.map(withoutHome),
			intro: ["One real helper, one real fixture window, only processes this run started."],
		})
		: { verdict: "refused", blockers: [], path: undefined, runName };
	if (written.verdict === "fail") {
		process.exitCode = 1;
		console.error(`[cu-v2 live] ${frozen.step} FAILED: ${written.blockers.join("; ")}`);
	}
	return written;
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	if (fixtureRun) {
		await disposeFixtureRun(fixtureRun, macosBackend, { record }).catch((cleanupError) => record("cleanup", "fixture copy", "fail", String(cleanupError)));
		fixtureRun = undefined;
	}
	const written = await writeEvidence();
	console.error(`[cu-v2 live] ${error instanceof Error ? error.message : String(error)}`);
	if (written.path) console.error(`[cu-v2 live] ${frozen?.step ?? "run"} ${written.verdict}; archive ${written.path}`);
	process.exitCode = 1;
}
