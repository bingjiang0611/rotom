#!/usr/bin/env node
/**
 * Computer Use v2 acceptance run: three agents work in separate fixture instances
 * while the operator continues using the Mac normally.
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-acceptance.mjs \
 *     --fixture ~/cu-v2-test/Fixture.app \
 *     --sign-identity "Apple Development: ... (XXXXXXXXXX)" \
 *     --runs-dir ~/cu-v2-runs --expect-commit <frozen sha>
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createAgentRunner } from "./lib/acceptance-agents.mjs";
import { createBackgroundEvidence } from "./lib/background-evidence.mjs";
import { StepRefused, beginStep } from "./lib/b-window.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { argument, createRecorder, nowMs, recordRealUserInput, requireLive, sleep } from "./lib/live-helpers.mjs";
import { createRunAppOwnership, quitRunOwnedApp } from "./lib/run-owned-apps.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const WORK_DIR = path.join(homedir(), "cu-v2-test", "acceptance");
const fixtureSource = argument("--fixture");
const signIdentity = argument("--sign-identity");
const instanceCount = Number(argument("--instances", "3"));
requireLive("cu-v2 acceptance", [
	["--fixture", fixtureSource && existsSync(fixtureSource), "path to the built fixture app"],
	["--sign-identity", signIdentity, "codesign identity"],
]);

const { macosHelper: rawHelper, HELPER_PROTOCOL_VERSION } = await import("../src/platform/macos/helper.ts");
const { macosBackend: rawBackend } = await import("../src/platform/macos/backend.ts");
const { record, rows, writeEvidence } = createRecorder();
const ownedPids = createRunAppOwnership();
const background = createBackgroundEvidence({ backend: rawBackend, helper: rawHelper, record, ownedPids });
const macosBackend = background.backend;
const macosHelper = background.helper;
const instances = [];
let frozen;
let activityAtStart;
let operatorFrontmost;
let backgroundStarted = false;
let backgroundFinished = false;
let cleaned = false;

const { prepareInstance, findInstance, launchInstance, fixtureWindow, runAgent } = createAgentRunner({
	backend: macosBackend,
	record,
	fixtureSource,
	signIdentity,
	workDir: WORK_DIR,
	ownedPids,
});

async function cleanup() {
	for (const instance of instances) {
		const app = await findInstance(instance.bundleId);
		if (!app) {
			rmSync(instance.directory, { recursive: true, force: true });
			record("cleanup", `fixture ${instance.index} copy`, "pass", "no matching process remained; copy removed");
			continue;
		}
		const quit = await quitRunOwnedApp({ backend: macosBackend, ownedPids, pid: app.pid, record, area: "cleanup", action: `fixture ${instance.index} quit` });
		if (quit.stopped) {
			rmSync(instance.directory, { recursive: true, force: true });
			record("cleanup", `fixture ${instance.index} quit`, "pass", `pid=${app.pid}; force=false; terminated=true; copy removed`);
		}
	}
	cleaned = true;
}

async function finishBackgroundEvidence() {
	if (!backgroundStarted || backgroundFinished) return;
	await recordRealUserInput({
		helper: macosHelper,
		backend: macosBackend,
		record,
		activityBefore: activityAtStart,
		operatorPid: operatorFrontmost?.pid,
		runPids: [...ownedPids],
		judged: false,
	});
	await background.finish();
	backgroundFinished = true;
}

async function main() {
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

	let gate;
	try {
		gate = await requireGate({
			windowStart: argument("--window-start"),
			windowMinutes: argument("--window-minutes"),
		});
	} catch (error) {
		console.error(`[cu-v2 acceptance] gate: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(error instanceof GateHold ? 1 : 2);
	}
	record("gate", "verdict", "pass", `minutes_left=${gate.minutes_left}`);

	const diagnostics = await macosHelper.diagnosticsCommand();
	if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION) throw new Error(`helper must report protocol ${HELPER_PROTOCOL_VERSION}, got ${diagnostics.protocolVersion}`);
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility} screenRecording=${diagnostics.screenRecording}`);
	background.setHelperPid(diagnostics.pid, diagnostics.invariants);
	activityAtStart = await macosHelper.command("userActivity", {}).catch(() => undefined);
	operatorFrontmost = await macosBackend.getFrontmost();
	record("environment", "operator app", "pass", `${operatorFrontmost.appName} pid=${operatorFrontmost.pid}`);
	await background.start();
	backgroundStarted = true;

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
			background.own(app.pid);
		}
	}
	if (running.length === 0) throw new Error("no fixture instance started");
	let readyWindows = 0;
	for (const agent of running) {
		const deadline = nowMs() + 6000;
		while (nowMs() < deadline && !(await fixtureWindow(agent.pid))) await sleep(200);
		if (await fixtureWindow(agent.pid)) readyWindows += 1;
	}
	record("environment", "fixture windows", readyWindows === instances.length ? "pass" : "fail", `${readyWindows}/${instances.length} instances exposed a window`);

	await Promise.all(running.map((agent) => runAgent(String(agent.index), agent.pid)));
	const taskRows = rows.filter((row) => /^agent \d+$/.test(row.area) && !["launch", "outline", "window"].includes(row.action));
	const worked = taskRows.filter((row) => row.result === "pass").length;
	const failed = taskRows.filter((row) => row.result === "fail");
	record("assert", "background tasks completed", failed.length === 0 ? "pass" : "fail", `${worked} passed, ${failed.length} failed${failed.length ? `: ${failed.map((row) => `${row.area}:${row.action}`).join(",")}` : ""}`);

	await cleanup();
	await finishBackgroundEvidence();
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	console.error(`[cu-v2 acceptance] ${error instanceof Error ? error.message : String(error)}`);
	if (!cleaned) await cleanup().catch((cleanupError) => record("cleanup", "after abort", "fail", String(cleanupError)));
	await finishBackgroundEvidence().catch((evidenceError) => record("background", "evidence", "fail", String(evidenceError)));
}

const written = writeEvidence({
	runsDir: frozen?.runsDir,
	fileName: "acceptance-run",
	step: frozen?.step,
	commit: frozen?.commit,
	title: "Computer Use v2 acceptance run",
	intro: [
		"Three run-owned fixture instances work in the background while the operator uses the Mac normally.",
		"Operator input is recorded but never treated as a failure.",
	],
});
console.log(`[cu-v2 acceptance] ${rows.length} rows, ${rows.filter((row) => row.result === "fail").length} failing; ${frozen?.step ?? "run"} ${written.verdict}; archive ${written.path ?? "nowhere (refused before the runs directory was known)"}`);
