#!/usr/bin/env node
/**
 * Computer Use v2 L2 single-action check (macOS, real helper).
 *
 * Records directed fixture/listed-app delivery without operating any process that
 * this run did not start. Evidence is written only to the external `--runs-dir`.
 *
 * Modes (A8):
 *
 *   --direct-l2     Ask the helper for `delivery=l2` directly, bypassing the
 *                   compatibility list, on this run's own fixture copy. Uses its own
 *                   helper socket, so a crash from a bad SkyLight signature is one
 *                   result instead of the end of the run. This is B1.
 *   --launch-twice  Report the event delta and elapsed time for two launches of the
 *                   same copied/signed bundle. Report-only: it authorizes no B step.
 *   --delivery-matrix
 *                   Report l2/pid clicks against SwiftUI and acceptsFirstMouse AppKit
 *                   buttons. Report-only: it authorizes no B step.
 *   --prewarm        Launch and quit the prepared copy before the formal quiet gate;
 *                   opt-in until the launch-twice result has been reviewed.
 *   --no-fixture-copy
 *                   Operate the given path instead of a re-identified copy. Off by
 *                   default because LaunchServices keys apps by bundle id: a copy
 *                   with the same id can attach to the operator's instance (-10825).
 *
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { inputSourceInfo, recordRealUserInput, runStamp, withoutHome } from "./lib/live-helpers.mjs";
import { REPORT_ONLY_STEPS, StepRefused, beginStep, requireNoStopMarker, requireRunsDir, writeRunArchive } from "./lib/b-window.mjs";
import { createBackgroundEvidence } from "./lib/background-evidence.mjs";
import { FIXTURE_WINDOW_TIMEOUT_MS, bringUpFixture, disposeFixtureRun, ensureFixtureWindow, explainWindowTimeout } from "./lib/fixture.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { driveListedApps } from "./lib/l2-apps.mjs";
import { writeEvidence } from "./lib/l2-evidence.mjs";
import { recordAttribution, resolveProcessNames } from "./lib/event-sources.mjs";
import { checkFixture, checkHelperSupport } from "./lib/l2-env.mjs";
import { createAlive, createProbe, fixtureRef, wireRefByRole } from "./lib/l2-probe.mjs";
import { runFixtureBaseline } from "./lib/l2-fixture-baseline.mjs";
import { runDeliveryMatrix, runDirectL2 } from "./lib/l2-modes.mjs";
import { prepareLaunchTwiceExperiment, preparePrewarmedFixture } from "./lib/l2-launch-cycle.mjs";

/** `scripts/` -> `packages/rotom-computer-use` -> `packages` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** The package this script ships in: the fixture source it was built from lives here. */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
/** Set by `beginStep`: the frozen commit this run is evidence about, and where it writes. */
let frozen;
const rows = [];
const log = [];

function record(area, action, result, note) {
	rows.push({ area, action, result, note: note ?? "" });
	log.push(`${new Date().toISOString()} ${area} ${action} ${result} ${note ?? ""}`);
}

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

/** Not the frozen environment: exit 2 and write nothing, because the step never started. */
function refuse(reason, area = "fixture", action = "signature") {
	const why = String(reason?.message ?? reason);
	record(area, action, "refused", why);
	console.error(`[cu-v2 l2] ${why}`);
	process.exit(2);
}

function disabled(reason) {
	console.log(`[cu-v2 l2] skipped: ${reason}`);
	process.exit(0);
}

// R8 T1: the dry run executes this script through a fake backend, refused together with
// `--expect-commit` so a fake run cannot pass for evidence about a frozen commit.
const fakeBackend = process.env.PI_CU_FAKE_BACKEND;
if (fakeBackend && process.argv.includes("--expect-commit")) {
	console.error("[cu-v2 l2] PI_CU_FAKE_BACKEND with --expect-commit is refused: a fake run is not evidence");
	process.exit(2);
}
if (!fakeBackend && process.platform !== "darwin") disabled("not macOS");
if (!fakeBackend && (process.env.PI_CU_LIVE ?? "") !== "1") disabled("PI_CU_LIVE is not 1");

const fixturePath = argument("--fixture");
if (!fixturePath || !existsSync(fixturePath)) disabled("pass --fixture <path to the built fixture app>");

const directL2 = process.argv.includes("--direct-l2");
const launchTwice = process.argv.includes("--launch-twice");
const deliveryMatrix = process.argv.includes("--delivery-matrix");
const prewarm = process.argv.includes("--prewarm");
if ([directL2, launchTwice, deliveryMatrix].filter(Boolean).length > 1) refuse("--direct-l2, --launch-twice and --delivery-matrix are separate modes", "run", "arguments");
if ((launchTwice || deliveryMatrix) && prewarm) refuse("report-only launch experiments cannot be combined with --prewarm", "run", "arguments");
// Review 7 R2: B0 experiments are report-only. They authorize nothing and write no marker.
const b0 = process.argv.includes("--b0-attribution") || launchTwice || deliveryMatrix;
// Review 6 P1: the step is declared, not inferred at the end. This script is B1 only -
// `check-cu-v2-live.mjs --with-hid` is the single owner of B6 (K4), and a second script
// claiming the same step made it ambiguous which run authorized the next one.
const step = b0 ? "B0" : "B1";
const fixtureCopy = !process.argv.includes("--no-fixture-copy");
if (deliveryMatrix && !fixtureCopy) refuse("--delivery-matrix requires the run-owned copied fixture", "run", "arguments");
const runRoot = path.join(homedir(), "cu-v2-test", "runs", runStamp());
mkdirSync(runRoot, { recursive: true });

// A dedicated helper socket for the direct-L2 signature check: if the private SkyLight call
// takes the helper down, that is one result and the run keeps its own helper. Done before the
// helper module loads, because it reads PI_CU_SOCKET_PATH at import time.
if ((directL2 || deliveryMatrix) && !process.env.PI_CU_L2_SOCKET) {
	process.env.PI_CU_SOCKET_PATH = path.join(runRoot, "helper-direct-delivery.sock");
	record("helper", "direct delivery socket", "pass", process.env.PI_CU_SOCKET_PATH);
}

const fake = fakeBackend ? await import(pathToFileURL(path.resolve(fakeBackend)).href) : undefined;
const { macosHelper: rawMacosHelper, HELPER_PROTOCOL_VERSION } = fake
	? { macosHelper: fake.helper, HELPER_PROTOCOL_VERSION: fake.helperProtocolVersion }
	: await import("../src/platform/macos/helper.ts");
const { macosBackend: rawMacosBackend } = fake ? { macosBackend: fake.backend } : await import("../src/platform/macos/backend.ts");
const { L2_COMPATIBLE_BUNDLE_IDS } = fake ? { L2_COMPATIBLE_BUNDLE_IDS: fake.l2CompatibleBundleIds ?? new Set() } : await import("../src/policy/l2-compat.ts");
const runOwnedPids = new Set();
const background = createBackgroundEvidence({ backend: rawMacosBackend, helper: rawMacosHelper, record, ownedPids: runOwnedPids });
const macosBackend = background.backend;
const macosHelper = background.helper;

const TYPED = "l2probe";

async function cursor() {
	const position = await macosHelper.command("getMousePosition", {});
	return { x: Number(position.x), y: Number(position.y) };
}

const probe = createProbe({ backend: macosBackend, record, cursor });
const alive = createAlive({ helper: macosHelper, expectedProtocol: HELPER_PROTOCOL_VERSION });

async function main() {
	// Review 6 P1, in this order: a stopped phase, then the frozen commit, then the
	// previous step's pass. All three are refusals (exit 2), never skips.
	try {
		// A fake run has no frozen commit to answer to: it gets an all-zero one, so the archive
		// it writes can never authorize a real step (T1).
		frozen = fake
			? {
				step,
				commit: fake.commit,
				runsDir: requireRunsDir(argument("--runs-dir"), { cwd: process.env.PI_CU_FAKE_REPO ?? REPO_ROOT }),
				reportOnly: REPORT_ONLY_STEPS.includes(step),
			}
			: beginStep({ step, expectCommit: argument("--expect-commit"), runsDir: argument("--runs-dir"), cwd: REPO_ROOT });
		if (fake) requireNoStopMarker(frozen.runsDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record("run", "constraints", "refused", message);
		console.error(`[cu-v2 l2] ${message}`);
		await writeEvidence();
		process.exit(error instanceof StepRefused ? 2 : 1);
	}
	record("run", "frozen commit", "pass", `${frozen.commit} step=${frozen.step}`);

	// A prewarm has two gates: one before it may touch the desktop, then a fresh quiet
	// interval after the launch event burst. The second gate only polls read-only state.
	async function passGate(action) {
		try {
			let report;
			if (fake) {
				if (fake.gate.verdict !== "pass") throw new GateHold(fake.gate);
				report = fake.gate;
			} else {
				report = await requireGate({
					windowStart: argument("--window-start"),
					windowMinutes: argument("--window-minutes"),
				});
			}
			writeFileSync(path.join(runRoot, `gate-${action.replaceAll(" ", "-")}-${runStamp()}.json`), `${JSON.stringify(report, null, 2)}\n`);
			record("gate", action, "pass", `minutes_left=${report.minutes_left}`);
			return report;
		} catch (error) {
			const failureAction = error instanceof GateHold ? action : "arguments";
			record("gate", failureAction, "fail", error instanceof Error ? error.message : String(error));
			console.error(`[cu-v2 l2] gate: ${error instanceof Error ? error.message : String(error)}`);
			await writeEvidence({ frozen, rows, log, b0 });
			process.exit(error instanceof GateHold ? 1 : 2);
		}
	}

	let preparedRun;
	if (prewarm) {
		if (!fixtureCopy) refuse("--prewarm requires the run-owned copied fixture", "prewarm", "arguments");
		await passGate("prewarm safety");
		const checked = checkFixture({ appPath: fixturePath, rootDir: PACKAGE_ROOT, identity: process.env.PI_CU_FIXTURE_SIGN_IDENTITY, willCopy: !fake });
		if (!checked.ok) refuse(checked.reason, "prewarm", "frozen artifacts");
		preparedRun = await preparePrewarmedFixture({ sourceApp: fixturePath, runRoot, sign: !fake, backend: macosBackend, helper: macosHelper, record });
	}
	await passGate("verdict");

	const inputSource = fake ? fake.inputSource : inputSourceInfo();
	record("environment", "input source", inputSource.ascii ? "pass" : "inconclusive", `${inputSource.description}; ASCII text typing needs a plain layout`);

	const diagnostics = await macosHelper.diagnosticsCommand();
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility}`);
	// T3: refuse before launching when the environment is not the frozen one.
	const environment = checkFixture({ appPath: fixturePath, rootDir: PACKAGE_ROOT, identity: process.env.PI_CU_FIXTURE_SIGN_IDENTITY, willCopy: fixtureCopy && !fake });
	const support = environment.ok
		? checkHelperSupport({ activity: await macosHelper.command("userActivity", {}).catch(() => undefined), diagnostics, expectedProtocol: HELPER_PROTOCOL_VERSION })
		: environment;
	if (!support.ok) refuse(support.reason, "environment", "frozen artifacts");
	record("environment", "frozen artifacts", "pass", `fixture=${environment.digest.slice(0, 12)} helper protocol=${diagnostics.protocolVersion}`);
	background.setHelperPid(diagnostics.pid, diagnostics.invariants);
	await background.start();
	const runStartedAt = Date.now();
	const activityBefore = await macosHelper.command("userActivity", {}).catch(() => undefined);
	const frontmost = await macosBackend.getFrontmost();
	record("environment", "operator app", "pass", `${frontmost.appName} pid=${frontmost.pid}`);

	// Anything already running belongs to the operator and is never a target.
	const atStartup = await macosBackend.listApps();
	const beforeRun = new Set(atStartup.map((app) => app.pid));
	record("environment", "apps at startup", "pass", `${beforeRun.size} running; only processes started by this run may be operated`);
	const startedByThisRun = (app) => !beforeRun.has(app.pid);

	// The fixture is not on the L2 list, so the product path must refuse it.
	let brought;
	let fixture;
	let fixtureRun;
	if (launchTwice) {
		await prepareLaunchTwiceExperiment({ sourceApp: fixturePath, runRoot, sign: !fake, backend: macosBackend, helper: macosHelper, record });
	} else {
		try {
			brought = await bringUpFixture({ backend: macosBackend, fixturePath, runRoot: fixtureCopy ? runRoot : undefined, preparedRun, sign: !fake, startedByThisRun, record });
		} catch (error) {
			refuse(error);
		}
			fixture = brought.fixture;
		fixtureRun = brought.run;
	}
	if (fixture) {
		background.own(fixture.pid);
		// The fixture orders its window behind the user's windows without activating; poll until AX sees it.
		const root = await ensureFixtureWindow(macosBackend, { pid: fixture.pid });
		if (!root) {
			const why = await explainWindowTimeout(macosBackend, { pid: fixture.pid });
			record("fixture", "window", "fail", `no window in listRoots within ${FIXTURE_WINDOW_TIMEOUT_MS}ms of activating the fixture; ${why}`);
		} else {
			const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
			const controls = { text: fixtureRef(look, ["AXTextField"]) ?? wireRefByRole(look, ["AXTextField"]), button: fixtureRef(look, ["AXButton"]) ?? wireRefByRole(look, ["AXButton"]) };
			record("fixture", "controls", controls.text && controls.button ? "pass" : "inconclusive", `text=${controls.text ?? "-"} button=${controls.button ?? "-"}`);

			if (!deliveryMatrix) {
				await runFixtureBaseline({ backend: macosBackend, fixture, root, look, controls, probe, record, typed: TYPED });
			}
		}
	}

	// Apps on the L2 list are a positive path only when this run owns them.
	const allowL2App = argument("--allow-l2-app");
	const onList = (await macosBackend.listApps()).filter((app) => app.bundleId && L2_COMPATIBLE_BUNDLE_IDS.has(app.bundleId));
	const installed = onList.filter((app) => allowL2App && app.bundleId === allowL2App && startedByThisRun(app));
	for (const app of installed) background.own(app.pid);
	if (!allowL2App) {
		record("L2 whitelist", "app on the list", "skipped", onList.length === 0 ? "nothing from the list is running" : `running: ${onList.map((app) => app.appName).join(", ")}; pass --allow-l2-app <bundleId> to type into it`);
	} else if (installed.length === 0) {
		const preexisting = onList.find((app) => app.bundleId === allowL2App);
		record("L2 whitelist", "app on the list", "skipped", preexisting
			? `${allowL2App} (pid=${preexisting.pid}) was already running before this run; this script only operates processes it started`
			: `${allowL2App} is not running; start it and re-run, this script does not launch user apps`);
	}
	if (!launchTwice && !deliveryMatrix) await driveListedApps({ backend: macosBackend, apps: installed, probe, typed: TYPED, record });

	if (directL2 && !launchTwice) await runDirectL2({ fixture, fixtureRun, backend: macosBackend, helper: macosHelper, record, cursor, alive, wireRefByRole, typed: TYPED, asciiInput: inputSource.ascii });
	if (deliveryMatrix && !launchTwice) {
		await runDeliveryMatrix({
			fixture,
			fixtureRun,
			backend: macosBackend,
			helper: macosHelper,
			record,
			alive,
		});
	}

	record("helper", "still alive", (await alive()) ? "pass" : "fail", "the helper answered diagnostics after every probe (no crash)");

	if (fixtureRun) {
		const cleanup = await disposeFixtureRun(fixtureRun, macosBackend, { record });
		record("cleanup", "fixture copy", cleanup.removed && cleanup.refused.length === 0 ? "pass" : "fail", `quit=${cleanup.quit.join(",") || "none"} refused=${cleanup.refused.join(",") || "none"} remaining=${cleanup.remaining.join(",") || "none"} removed=${cleanup.removed}`);
	}

	const runPids = [fixture?.pid, ...installed.map((app) => app.pid)].filter((pid) => typeof pid === "number");
	await recordRealUserInput({ helper: macosHelper, backend: macosBackend, record, activityBefore, operatorPid: frontmost.pid, runPids, judged: false });
	await background.finish();

	// R2 step 1: report where the events came from, change no rule. R8 T2: a missing ring, or a
	// ring that disagrees with the counters, is a failure and not a zero.
	const activityAfter = await macosHelper.command("userActivity", {}).catch(() => undefined);
	const windowEvents = (activityAfter?.recentEvents ?? []).filter((event) => Number(event?.at) >= runStartedAt);
	const names = resolveProcessNames(windowEvents.map((event) => Number(event?.pid)));
	recordAttribution({
		activityBefore,
		activityAfter,
		runStartedAt,
		runPids,
		helperPid: diagnostics.pid,
		processName: (pid) => names.get(pid),
		record,
	});
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	console.error(`[cu-v2 l2] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

await writeEvidence({ frozen, rows, log, b0 });
const failures = rows.filter((row) => row.result === "fail").length;
console.log(`[cu-v2 l2] ${rows.length} rows, ${failures} failing; archive written to ${frozen?.runsDir ?? "nowhere (refused before the runs directory was known)"}`);
