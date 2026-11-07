#!/usr/bin/env node
/**
 * Computer Use v2 acceptance run (macOS, PLAN §10): three agents work in three
 * separate fixture instances while a user simulator types into TextEdit and
 * moves the real cursor.
 *
 * Never part of `npm test`: gated behind `PI_CU_LIVE=1`, it types into a real
 * app, moves the real cursor, and needs the operator to be away from the
 * machine. It only opens its own TextEdit document and its own fixture copies.
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-acceptance.mjs \
 *     --fixture ~/cu-v2-test/Fixture.app \
 *     --sign-identity "Apple Development: ... (XXXXXXXXXX)" \
 *     --simulator ~/cu-v2-test/simulator
 *
 * Point it at an isolated helper so a running session keeps its own daemon:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { RUNS_DIR, StepRefused, beginStep } from "./lib/b-window.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { argument, createRecorder, nowMs, requireLive, restoreOperatorApp, sessionDelta, sessionProbe, sleep, wireRefByRole, wireRefsByRole } from "./lib/live-helpers.mjs";

const WORK_DIR = path.join(homedir(), "cu-v2-test", "acceptance");
const SIMULATED_TEXT = "The quick brown fox jumps over the lazy dog 0123456789 while three agents work.";
const CHARS_PER_MINUTE = 300;

const fixtureSource = argument("--fixture");
const signIdentity = argument("--sign-identity");
const simulatorPath = argument("--simulator");
const instanceCount = Number(argument("--instances", "3"));
requireLive("cu-v2 acceptance", [
	["--fixture", fixtureSource && existsSync(fixtureSource), "path to the built fixture app"],
	["--sign-identity", signIdentity, "codesign identity"],
	["--simulator", simulatorPath && existsSync(simulatorPath), "path to the built user simulator"],
]);

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { record, rows, writeEvidence } = createRecorder();
/** Set by `beginStep`: the frozen commit this run is evidence about. */
let frozen;

const brackets = [];
const instances = [];
let cleanupContext;
let cleaned = false;

/** Launch a copy of the fixture under its own bundle identifier. */
function prepareInstance(index) {
	const directory = path.join(WORK_DIR, `Fixture-${index}.app`);
	rmSync(directory, { recursive: true, force: true });
	cpSync(fixtureSource, directory, { recursive: true });
	const plist = path.join(directory, "Contents", "Info.plist");
	execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier com.example.cu-fixture-instance${index}`, plist]);
	execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleName CUFixture${index}`, plist]);
	// Editing Info.plist invalidates the signature and this machine refuses ad-hoc
	// signed binaries, so sign the copy again.
	execFileSync("codesign", ["--force", "--deep", "--sign", signIdentity, directory], { stdio: "pipe" });
	return { index, bundleId: `com.example.cu-fixture-instance${index}`, directory };
}

async function findInstance(bundleId) {
	return (await macosBackend.listApps()).find((app) => app.bundleId === bundleId);
}

async function launchInstance(instance) {
	try {
		execFileSync("open", ["-n", instance.directory], { stdio: "pipe" });
	} catch {
		const executable = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", path.join(instance.directory, "Contents", "Info.plist")]).toString().trim();
		spawn(path.join(instance.directory, "Contents", "MacOS", executable), [], { detached: true, stdio: "ignore" }).unref();
	}
	const deadline = nowMs() + 8000;
	while (nowMs() < deadline) {
		const app = await findInstance(instance.bundleId);
		if (app) return app;
		await sleep(250);
	}
	return undefined;
}

async function fixtureWindow(pid) {
	return (await macosBackend.listRoots({ pid })).find((candidate) => candidate.kind === "window");
}

/** One subtask, bracketed so a cursor move can be attributed to the simulator. */
async function actWithBracket(agent, look, pid, action, options = {}) {
	const policy = action.policy ?? "ax_only";
	const before = await sessionProbe(macosHelper, macosBackend);
	const result = await macosBackend.act({ lookId: look.lookId, pid, target: { ref: action.ref }, policy, ...action }, { timeoutMs: 20_000 })
		.catch((error) => ({ ok: false, outcome: "error", error: error instanceof Error ? error.message : String(error) }));
	const after = await sessionProbe(macosHelper, macosBackend);
	const { cursorMoved } = sessionDelta(before, after);
	brackets.push({ agent, action: action.action, moved: cursorMoved, before, after });
	const outcome = result?.outcome ?? "unknown";
	// `unknown` means the helper could not confirm delivery; when the caller checks
	// the effect itself that is not a failure.
	const judged = outcome === "worked" || outcome === "foreground_required" ? "pass" : outcome === "unknown" && options.verifiedByReadback ? "inconclusive" : "fail";
	record(`agent ${agent}`, action.action, judged, `outcome=${outcome} delivery=${result?.performed?.delivery ?? "?"}${result?.error ? ` error=${result.error}` : ""}`);
	return outcome;
}

async function tabStates(root) {
	const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
	return wireRefsByRole(look, "AXRadioButton").join(",");
}

/** The five fixed subtasks of PLAN §10: fill a form, switch tab, pick a row, toggle, move a slider. */
async function runAgent(agent, pid) {
	const root = await fixtureWindow(pid);
	if (!root) return record(`agent ${agent}`, "window", "fail", "the fixture window never appeared");
	const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
	const controls = {
		text: wireRefByRole(look, ["AXTextField"]),
		checkbox: wireRefByRole(look, ["AXCheckBox", "AXSwitch"]),
		slider: wireRefByRole(look, ["AXSlider"]),
		row: wireRefByRole(look, ["AXRow"]),
		disclosure: wireRefByRole(look, ["AXDisclosureTriangle"]),
		tabs: wireRefsByRole(look, "AXRadioButton"),
	};
	const missing = Object.entries(controls).filter(([, ref]) => (Array.isArray(ref) ? ref.length === 0 : !ref)).map(([name]) => name);
	record(`agent ${agent}`, "outline", missing.length === 0 ? "pass" : "inconclusive", `windowId=${root.windowId} missing=${missing.join(",") || "none"}`);

	if (controls.text) await actWithBracket(agent, look, pid, { action: "setText", ref: controls.text, params: { text: `agent ${agent} text` } });
	if (controls.checkbox) await actWithBracket(agent, look, pid, { action: "setChecked", ref: controls.checkbox, params: { checked: true } });
	if (controls.slider) await actWithBracket(agent, look, pid, { action: "setValue", ref: controls.slider, params: { value: 0.4 + Number(agent.replace(/\D/g, "")) * 0.1 } });
	if (controls.row) await actWithBracket(agent, look, pid, { action: "select", ref: controls.row });

	// A SwiftUI tab has no AXPress that lands, so the click needs pid delivery. It
	// still keeps the cursor and the frontmost app untouched, which is what this
	// run measures, but pid delivery cannot confirm itself: read the tabs back.
	if (controls.tabs.length > 1) {
		const before = await tabStates(root);
		await actWithBracket(agent, look, pid, { action: "click", ref: controls.tabs[1], policy: "background" }, { verifiedByReadback: true });
		const after = await tabStates(root);
		record(`agent ${agent}`, "tab switched (readback)", after !== before ? "pass" : "fail", `${before} → ${after}`);
	}

	// Switching tabs rebuilds the tree, so the refs above are stale now.
	const refreshed = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
	const disclosure = wireRefByRole(refreshed, ["AXDisclosureTriangle"]);
	if (disclosure) await actWithBracket(agent, refreshed, pid, { action: "expand", ref: disclosure });
	else record(`agent ${agent}`, "expand", "inconclusive", "no disclosure triangle after the tab switch");
}

async function main() {
	// Review 6 P1: the acceptance run is part of B3, so it carries the same three checks
	// as the live check and cannot run in a stopped phase.
	const step = "B3";
	try {
		frozen = beginStep({ step, expectCommit: argument("--expect-commit"), dir: RUNS_DIR });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record("run", "constraints", "refused", message);
		console.error(`[cu-v2 acceptance] ${message}`);
		process.exit(error instanceof StepRefused ? 2 : 1);
	}
	record("run", "frozen commit", "pass", `${frozen.commit} step=${frozen.step}`);
/**
 * The gate runs here too, not in an operator loop (review G6): no declared window is a
 * refusal, and a hold stops before anything touches the desktop.
 */
async function refuseUnlessGatePasses() {
	try {
		return await requireGate({
			windowStart: argument("--window-start"),
			windowMinutes: argument("--window-minutes"),
			requireIdleMinutes: argument("--require-idle-minutes") ?? "10",
			listeningSince: argument("--listening-since"),
		});
	} catch (error) {
		console.error(`[cu-v2 acceptance] gate: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(error instanceof GateHold ? 1 : 2);
	}
}
	await refuseUnlessGatePasses();
	const diagnostics = await macosHelper.diagnosticsCommand();
	// Same reason as the live check: a hardcoded protocol number refuses a correct helper.
	const { HELPER_PROTOCOL_VERSION } = await import("../src/platform/macos/helper.ts");
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) throw new Error(`helper must report protocol ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}`);
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility} screenRecording=${diagnostics.screenRecording}`);

	// The operator app is whatever was frontmost before the run; the run has to
	// leave the machine on that app again.
	const operatorFrontmost = await macosBackend.getFrontmost();
	const textEditRunning = spawnSync("pgrep", ["-x", "TextEdit"]).status === 0;
	cleanupContext = { operatorFrontmost, textEditRunning };
	record("environment", "operator app", "pass", `${operatorFrontmost.appName} pid=${operatorFrontmost.pid}`);
	record("environment", "TextEdit state", "pass", textEditRunning ? "already running" : "not running");

	mkdirSync(WORK_DIR, { recursive: true });
	const running = [];
	for (let index = 1; index <= instanceCount; index += 1) {
		const instance = prepareInstance(index);
		instances.push(instance);
		const app = await launchInstance(instance);
		record(`agent ${index}`, "launch", app ? "pass" : "fail", app ? `pid=${app.pid} bundle=${app.bundleId}` : `${instance.bundleId} did not register`);
		if (app) running.push({ ...instance, pid: app.pid });
	}
	if (running.length === 0) throw new Error("no fixture instance started");
	for (const agent of running) {
		const deadline = nowMs() + 6000;
		while (nowMs() < deadline && !(await fixtureWindow(agent.pid))) await sleep(200);
	}
	record("environment", "fixture windows", running.length === instances.length ? "pass" : "inconclusive", `${running.length}/${instances.length} instances up`);

	execFileSync("open", ["-a", "TextEdit"], { stdio: "pipe" });
	await sleep(1200);
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to make new document'], { stdio: "pipe" });
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to activate'], { stdio: "pipe" });
	await sleep(900);

	const textEditFrontmost = await macosBackend.getFrontmost();
	const textEditPid = textEditFrontmost.pid;
	cleanupContext = { ...cleanupContext, textEditPid };
	record("simulator", "TextEdit frontmost", textEditFrontmost.appName?.includes("TextEdit") ? "pass" : "fail", `${textEditFrontmost.appName} pid=${textEditPid}`);
	const baselineRoots = await macosBackend.listRoots({ pid: textEditPid });
	const windowIds = (roots) => roots.map((root) => `${root.kind}:${root.windowId}`).join(",");
	record("simulator", "baseline windows", baselineRoots.length > 0 ? "pass" : "fail", windowIds(baselineRoots));

	const simulatorLog = path.join(WORK_DIR, "simulator.jsonl");
	const durationSeconds = Math.ceil((SIMULATED_TEXT.length / CHARS_PER_MINUTE) * 60) + 6;
	const simulator = spawn(simulatorPath, ["--text", SIMULATED_TEXT, "--chars-per-minute", String(CHARS_PER_MINUTE), "--duration", String(durationSeconds), "--log", simulatorLog], { stdio: "inherit" });
	record("simulator", "started", "pass", `${SIMULATED_TEXT.length} chars at ${CHARS_PER_MINUTE}/min for up to ${durationSeconds}s`);

	const activityBefore = await macosBackend.userActivity();
	await Promise.all(running.map((agent) => runAgent(String(agent.index), agent.pid)));

	const simulatorExit = await new Promise((resolve) => simulator.on("exit", (code) => resolve(code ?? -1)));
	const activityAfter = await macosBackend.userActivity();
	record("simulator", "typed all characters", simulatorExit === 0 ? "pass" : "fail", `exit=${simulatorExit} userEvents ${activityBefore.userEventCount} → ${activityAfter.userEventCount} agentEvents ${activityBefore.agentEventCount} → ${activityAfter.agentEventCount}`);

	const simulated = readFileSync(simulatorLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const moves = simulated.filter((entry) => entry.kind === "move");
	const typedCount = simulated.filter((entry) => entry.kind === "char").length;
	record("simulator", "log", typedCount === SIMULATED_TEXT.length ? "pass" : "fail", `chars=${typedCount} moves=${moves.length}`);

	// Assertion 1: the document holds exactly what the simulator typed.
	const documentText = execFileSync("osascript", ["-e", 'tell application "TextEdit" to get text of document 1'], { stdio: "pipe" }).toString().replace(/\n$/, "");
	const textMatches = documentText === SIMULATED_TEXT;
	record("assert", "1 typed text matches document", textMatches ? "pass" : "fail", textMatches ? `${documentText.length} chars` : `expected ${SIMULATED_TEXT.length}, got ${documentText.length}: "${documentText.slice(0, 80)}"`);

	// Assertion 2: the frontmost app and TextEdit's focused windows never changed.
	const finalFrontmost = await macosBackend.getFrontmost();
	const finalRoots = await macosBackend.listRoots({ pid: textEditPid });
	record("assert", "2 frontmost app unchanged", finalFrontmost.pid === textEditPid ? "pass" : "fail", `${textEditFrontmost.appName} → ${finalFrontmost.appName}`);
	record("assert", "2 focused windows unchanged", windowIds(baselineRoots) === windowIds(finalRoots) ? "pass" : "fail", `${windowIds(baselineRoots)} → ${windowIds(finalRoots)}`);

	// Assertion 3: the cursor moved only for the simulator. A movement observed
	// around an agent action must line up with a logged simulator move.
	const unexplained = brackets.filter((bracket) => bracket.moved).filter((bracket) => !moves.some((move) =>
		move.t >= bracket.before.t - 250 && move.t <= bracket.after.t + 250 &&
		[bracket.before.cursor, bracket.after.cursor].some((position) => Math.hypot(move.x - position.x, move.y - position.y) < 2.5)))
		.map((bracket) => `${bracket.agent}:${bracket.action} ${JSON.stringify(bracket.before.cursor)} → ${JSON.stringify(bracket.after.cursor)}`);
	const movedCount = brackets.filter((bracket) => bracket.moved).length;
	record("assert", "3 cursor only moved by simulator", unexplained.length === 0 ? "pass" : "fail", unexplained.length === 0 ? `${movedCount} movements observed, all matched a simulator move` : unexplained.join("; "));

	// Assertion 4: every task finished, and nothing failed silently.
	const taskRows = rows.filter((row) => /^agent \d+$/.test(row.area) && !["launch", "outline", "window"].includes(row.action));
	const worked = taskRows.filter((row) => row.result === "pass" && row.note.includes("outcome=worked")).length;
	const foreground = taskRows.filter((row) => row.note.includes("outcome=foreground_required")).length;
	const failed = taskRows.filter((row) => row.result === "fail");
	record("assert", "4 tasks completed or explicit", failed.length === 0 ? "pass" : "fail", `${worked} worked, ${foreground} foreground_required, ${failed.length} failed${failed.length ? `: ${failed.map((row) => `${row.area}:${row.action}`).join(",")}` : ""}`);

	await cleanup(cleanupContext);
	cleaned = true;
}

async function cleanup({ textEditPid, textEditRunning, operatorFrontmost }) {
	// Close only the document this run created, and never save it.
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to close document 1 saving no'], { stdio: "pipe" }).toString();
	record("cleanup", "test document closed", "pass", "saving no");
	if (!textEditRunning) {
		execFileSync("osascript", ["-e", 'tell application "TextEdit" to quit saving no'], { stdio: "pipe" }).toString();
		record("cleanup", "TextEdit quit", "pass", "it was not running before the run");
	}
	for (const instance of instances) {
		const app = await findInstance(instance.bundleId);
		if (!app) continue;
		await macosBackend.manageApps({ mode: "quit", pid: app.pid, activates: false }).catch(() => undefined);
		record("cleanup", `fixture ${instance.index} quit`, "pass", `pid=${app.pid}`);
	}
	await sleep(600);
	for (const instance of instances) {
		const app = await findInstance(instance.bundleId);
		if (app) execFileSync("kill", ["-TERM", String(app.pid)], { stdio: "pipe" });
	}
	if (operatorFrontmost.appName) {
		// Same restore path as the live check (review 6 P2): `focusWindow` with a lease and
		// a readback, and a restore that does not take is a failure.
		await restoreOperatorApp({ backend: macosBackend, original: operatorFrontmost, record });
	}
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	console.error(`[cu-v2 acceptance] ${error instanceof Error ? error.message : String(error)}`);
	if (!cleaned && cleanupContext) {
		// Leaving a document open or three fixtures running is worse than the failure.
		await cleanup(cleanupContext).catch((cleanupError) => record("cleanup", "after abort", "fail", String(cleanupError)));
	}
}

writeEvidence({
	fileName: "acceptance-run",
	step: frozen?.step,
	commit: frozen?.commit,
	title: "Computer Use v2 acceptance run, PLAN §10",
	intro: [
		"Three fixture instances under distinct bundle identifiers work in the background while a",
		`user simulator types ${SIMULATED_TEXT.length} fixed characters into a new TextEdit document at ${CHARS_PER_MINUTE}/min and moves the real cursor.`,
	],
});
console.log(`[cu-v2 acceptance] ${rows.length} rows, ${rows.filter((row) => row.result === "fail").length} failing; log written to evidence/`);
