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
 *     --simulator ~/cu-v2-test/simulator \
 *     --runs-dir ~/cu-v2-runs --expect-commit <frozen sha>
 *
 * Point it at an isolated helper so a running session keeps its own daemon:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StepRefused, beginStep } from "./lib/b-window.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { createAgentRunner } from "./lib/acceptance-agents.mjs";
import { argument, createRecorder, nowMs, recordRealUserInput, requireLive, restoreOperatorApp, sessionDelta, sleep, wireRefByRole } from "./lib/live-helpers.mjs";
import { createRunAppOwnership, quitRunOwnedApp, rememberRunLaunch } from "./lib/run-owned-apps.mjs";

/** `scripts/` -> `packages/rotom-computer-use` -> `packages` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

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
/** Pids returned by a new helper launch; discovery or `alreadyRunning` never grants ownership. */
const ownedPids = createRunAppOwnership();
const runPids = new Set();
let cleanupContext;
let cleaned = false;

/** Launch a copy of the fixture under its own bundle identifier. */
// The three fixture copies, their subtasks and the cursor brackets live in
// `lib/acceptance-agents.mjs`; this script owns the window, the simulator and the
// assertions.
const { prepareInstance, findInstance, launchInstance, fixtureWindow, runAgent } = createAgentRunner({
	backend: macosBackend,
	helper: macosHelper,
	record,
	brackets,
	fixtureSource,
	signIdentity,
	workDir: WORK_DIR,
	ownedPids,
});

async function main() {
	// Review 6 P1/K3: the acceptance run is its own step (`B3-acceptance`), so a passing
	// live check cannot open B4 on its own; it also carries the same three checks and
	// cannot run in a stopped phase.
	const step = "B3-acceptance";
	try {
		frozen = beginStep({ step, expectCommit: argument("--expect-commit"), runsDir: argument("--runs-dir"), cwd: REPO_ROOT });
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
	const gate = await refuseUnlessGatePasses();
	record("gate", "verdict", "pass", `minutes_left=${gate.minutes_left} helper_idle=${gate.helper_idle_seconds ?? "-"}s`);
	// Baseline for "did the operator come back" (review 6 K2): our own posts are marked by
	// the helper, so any growth in the real-event count is a person.
	const activityAtStart = await macosHelper.command("userActivity", {}).catch(() => undefined);
	const diagnostics = await macosHelper.diagnosticsCommand();
	// Same reason as the live check: a hardcoded protocol number refuses a correct helper.
	const { HELPER_PROTOCOL_VERSION } = await import("../src/platform/macos/helper.ts");
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) throw new Error(`helper must report protocol ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}`);
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility} screenRecording=${diagnostics.screenRecording}`);

	// The operator app is whatever was frontmost before the run; the run has to
	// leave the machine on that app again.
	const operatorFrontmost = await macosBackend.getFrontmost();
	cleanupContext = { operatorFrontmost };
	record("environment", "operator app", "pass", `${operatorFrontmost.appName} pid=${operatorFrontmost.pid}`);

	mkdirSync(WORK_DIR, { recursive: true });
	const running = [];
	for (let index = 1; index <= instanceCount; index += 1) {
		const bundleId = `com.example.cu-fixture-instance${index}`;
		const preexisting = await findInstance(bundleId);
		if (preexisting) {
			record(`agent ${index}`, "launch", "fail", `refused pid=${preexisting.pid}; ${bundleId} was already running before this run`);
			throw new Error(`${bundleId} was already running before this run`);
		}
		const instance = prepareInstance(index);
		instances.push(instance);
		const app = await launchInstance(instance);
		record(`agent ${index}`, "launch", app ? "pass" : "fail", app ? `pid=${app.pid} bundle=${app.bundleId}` : `${instance.bundleId} did not register`);
		if (app) {
			running.push({ ...instance, pid: app.pid });
			runPids.add(app.pid);
		}
	}
	if (running.length === 0) throw new Error("no fixture instance started");
	for (const agent of running) {
		const deadline = nowMs() + 6000;
		while (nowMs() < deadline && !(await fixtureWindow(agent.pid))) await sleep(200);
	}
	record("environment", "fixture windows", running.length === instances.length ? "pass" : "inconclusive", `${running.length}/${instances.length} instances up`);

	const textEditLaunch = await macosBackend.manageApps({ mode: "launch", bundleId: "com.apple.TextEdit", activates: true });
	const textEditOwnedPid = rememberRunLaunch(ownedPids, textEditLaunch);
	record("environment", "TextEdit state", textEditOwnedPid ? "pass" : "fail", textEditOwnedPid ? `started pid=${textEditOwnedPid}` : `refused pid=${textEditLaunch.pid ?? "?"}; TextEdit was not newly launched by this run`);
	if (!textEditOwnedPid) throw new Error("TextEdit was already running or its launch pid was not owned by this run");
	cleanupContext = { ...cleanupContext, textEditPid: textEditOwnedPid, textEditOwnedPid };
	runPids.add(textEditOwnedPid);
	await sleep(1200);
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to make new document'], { stdio: "pipe" });
	execFileSync("osascript", ["-e", 'tell application "TextEdit" to activate'], { stdio: "pipe" });
	await sleep(900);

	const textEditFrontmost = await macosBackend.getFrontmost();
	const textEditPid = textEditFrontmost.pid;
	cleanupContext = { ...cleanupContext, textEditPid, textEditOwnedPid };
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
	// The event budget for the "did a person come back" row (review 6 K2). The simulator
	// is this run's own input; its log is what separates it from the operator.
	cleanupContext = { ...cleanupContext, expectedEvents: typedCount + moves.length * 2 + 20 };

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

async function cleanup({ textEditPid, textEditOwnedPid, operatorFrontmost }) {
	if (textEditOwnedPid) {
		// The run owns this TextEdit process and its only document.
		try {
			execFileSync("osascript", ["-e", 'tell application "TextEdit" to close document 1 saving no'], { stdio: "pipe" }).toString();
			record("cleanup", "test document closed", "pass", "saving no");
		} catch (error) {
			record("cleanup", "test document closed", "fail", error instanceof Error ? error.message : String(error));
		}
		const quit = await quitRunOwnedApp({ backend: macosBackend, ownedPids, pid: textEditOwnedPid, record, area: "cleanup", action: "TextEdit quit" });
		if (quit.stopped) record("cleanup", "TextEdit quit", "pass", `pid=${textEditOwnedPid}; force=false; terminated=true`);
	} else {
		record("cleanup", "test document closed", "skipped", "this run did not create a TextEdit process or document");
		record("cleanup", "TextEdit quit", "skipped", `pid=${textEditPid ?? "?"} was not launched by this run`);
	}
	for (const instance of instances) {
		const app = await findInstance(instance.bundleId);
		if (!app) continue;
		const quit = await quitRunOwnedApp({ backend: macosBackend, ownedPids, pid: app.pid, record, area: "cleanup", action: `fixture ${instance.index} quit` });
		if (quit.stopped) {
			rmSync(instance.directory, { recursive: true, force: true });
			record("cleanup", `fixture ${instance.index} quit`, "pass", `pid=${app.pid}; force=false; terminated=true; copy removed`);
		}
	}
	if (operatorFrontmost.appName) {
		// Same restore path as the live check (review 6 P2): `focusWindow` with a lease and
		// a readback, and a restore that does not take is a failure.
		await restoreOperatorApp({ backend: macosBackend, original: operatorFrontmost, record });
	}
	// Did the operator come back while the simulator typed? (review 6 K2) The simulator
	// itself is counted as this run's input, so it is part of the expected event budget.
	// The simulator posts real HID events from its own process, so the helper counts them
	// as user input. Its own log therefore sets the budget: a typed character and a cursor
	// move are one event each, doubled for the pairing events, plus a small allowance for
	// the window server. More than that is a person at the machine.
	const budget = cleanupContext?.expectedEvents ?? 0;
	await recordRealUserInput({
		helper: macosHelper,
		backend: macosBackend,
		record,
		activityBefore: activityAtStart,
		operatorPid: operatorFrontmost.pid,
		runPids: [...runPids],
		expectedEvents: budget,
		expectedNote: "the simulator's own log",
	});
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

const written = writeEvidence({
	runsDir: frozen?.runsDir,
	fileName: "acceptance-run",
	step: frozen?.step,
	commit: frozen?.commit,
	title: "Computer Use v2 acceptance run, PLAN §10",
	intro: [
		"Three fixture instances under distinct bundle identifiers work in the background while a",
		`user simulator types ${SIMULATED_TEXT.length} fixed characters into a new TextEdit document at ${CHARS_PER_MINUTE}/min and moves the real cursor.`,
	],
});
console.log(`[cu-v2 acceptance] ${rows.length} rows, ${rows.filter((row) => row.result === "fail").length} failing; ${frozen?.step ?? "run"} ${written.verdict}; archive ${written.path ?? "nowhere (refused before the runs directory was known)"}`);
