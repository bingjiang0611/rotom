#!/usr/bin/env node
/**
 * Computer Use v2 L2 single-action check (macOS, real helper).
 *
 * Runs one directed click and one directed text input against the fixture app and
 * against an app on the L2 compatibility list, and records what actually happened:
 * did the cursor move, did the app receive the event, did the helper survive. A
 * crash is a result, not a failure of the harness.
 *
 * Only processes this run started are ever operated: anything already running
 * belongs to the operator. A white-listed app must therefore be launched by this
 * run (start it yourself, or pass --allow-l2-app after a run that launched it).
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-l2-check.mjs --fixture ~/cu-v2-test/Fixture.app \
 *     --runs-dir ~/cu-v2-runs --expect-commit <frozen sha> \
 *     --window-start 2026-11-06T19:53:21-0800 --window-minutes 60
 *
 * Every file this script writes goes to `--runs-dir`, which must be outside the
 * worktree (review 6 K1). The script never writes into the repository.
 *
 * Modes (A8):
 *
 *   --direct-l2     Ask the helper for `delivery=l2` directly, bypassing the
 *                   compatibility list, on this run's own fixture copy. Uses its own
 *                   helper socket, so a crash from a bad SkyLight signature is one
 *                   result instead of the end of the run. This is B1.
 *   --no-fixture-copy
 *                   Operate the given path instead of a re-identified copy. Off by
 *                   default because LaunchServices keys apps by bundle id: a copy
 *                   with the same id can attach to the operator's instance (-10825).
 *
 * Isolated helper, same as the other live scripts:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { inputSourceInfo, recordRealUserInput, restoreOperatorApp, runStamp, withoutHome } from "./lib/live-helpers.mjs";
import { StepRefused, beginStep, writeRunArchive } from "./lib/b-window.mjs";
import { ensureFixtureWindow, launchFixture } from "./lib/fixture.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";
import { disposeFixtureRun, isFixtureBundleId, prepareFixtureRun } from "./lib/fixture.mjs";
import { attributionRows, resolveProcessNames } from "./lib/event-sources.mjs";
import { createAlive, createProbe, fixtureRef, wireRefByRole } from "./lib/l2-probe.mjs";
import { fixtureClickCount, runDirectL2 } from "./lib/l2-modes.mjs";

/** `scripts/` -> `packages/rotom-computer-use` -> `packages` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
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

function disabled(reason) {
	console.log(`[cu-v2 l2] skipped: ${reason}`);
	process.exit(0);
}

if (process.platform !== "darwin") disabled("not macOS");
if ((process.env.PI_CU_LIVE ?? "") !== "1") disabled("PI_CU_LIVE is not 1");

const fixturePath = argument("--fixture");
if (!fixturePath || !existsSync(fixturePath)) disabled("pass --fixture <path to the built fixture app>");

const directL2 = process.argv.includes("--direct-l2");
// Review 7 R2: B0 is the attribution run. Same gate, same commit, same actions as B1, but
// its archive carries no `Verdict:` line, so it authorizes nothing and writes no marker.
const b0 = process.argv.includes("--b0-attribution");
// Review 6 P1: the step is declared, not inferred at the end. This script is B1 only -
// `check-cu-v2-live.mjs --with-hid` is the single owner of B6 (K4), and a second script
// claiming the same step made it ambiguous which run authorized the next one.
const step = b0 ? "B0" : "B1";
const fixtureCopy = !process.argv.includes("--no-fixture-copy");
const runRoot = path.join(homedir(), "cu-v2-test", "runs", runStamp());
mkdirSync(runRoot, { recursive: true });

// A dedicated helper socket for the direct-L2 signature check: if the private
// SkyLight call takes the helper down, that is one recorded result and the rest of
// the run still has its own helper. Must happen before the helper module is loaded,
// because it reads PI_CU_SOCKET_PATH at import time.
if (directL2 && !process.env.PI_CU_L2_SOCKET) {
	process.env.PI_CU_SOCKET_PATH = path.join(runRoot, "helper-direct-l2.sock");
	record("helper", "direct L2 socket", "pass", process.env.PI_CU_SOCKET_PATH);
}

const { macosHelper, HELPER_PROTOCOL_VERSION } = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { L2_COMPATIBLE_BUNDLE_IDS } = await import("../src/policy/l2-compat.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
		frozen = beginStep({ step, expectCommit: argument("--expect-commit"), runsDir: argument("--runs-dir"), cwd: REPO_ROOT });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record("run", "constraints", "refused", message);
		console.error(`[cu-v2 l2] ${message}`);
		await writeEvidence();
		process.exit(error instanceof StepRefused ? 2 : 1);
	}
	record("run", "frozen commit", "pass", `${frozen.commit} step=${frozen.step}`);

	// The gate runs inside the script, not in an operator shell loop: on 2026-11-06 the
	// loop ran the check unconditionally and B1 started while the user was typing.
	// No declared window is a refusal, and a hold writes its readings and exits.
	const gate = await (async () => {
		try {
			return await requireGate({
				windowStart: argument("--window-start"),
				windowMinutes: argument("--window-minutes"),
				requireIdleMinutes: argument("--require-idle-minutes") ?? "10",
				listeningSince: argument("--listening-since"),
			});
		} catch (error) {
			if (error instanceof GateHold) {
				writeFileSync(path.join(runRoot, `gate-${runStamp()}.json`), `${JSON.stringify(error.report, null, 2)}\n`);
				record("gate", "verdict", "fail", error.message);
				console.error(`[cu-v2 l2] gate hold: ${error.message}`);
				await writeEvidence();
				process.exit(1);
			}
			record("gate", "arguments", "fail", error instanceof Error ? error.message : String(error));
			console.error(`[cu-v2 l2] ${error instanceof Error ? error.message : String(error)}`);
			await writeEvidence();
			process.exit(2);
		}
	})();
	writeFileSync(path.join(runRoot, `gate-${runStamp()}.json`), `${JSON.stringify(gate, null, 2)}\n`);
	record("gate", "verdict", "pass", `minutes_left=${gate.minutes_left} hid_idle=${gate.hid_idle_seconds}s helper_idle=${gate.helper_idle_seconds ?? "-"}s`);

	const inputSource = inputSourceInfo();
	record("environment", "input source", inputSource.ascii ? "pass" : "inconclusive", `${inputSource.description}; ASCII text typing needs a plain layout`);

	const diagnostics = await macosHelper.diagnosticsCommand();
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility}`);
	// The baseline for "did the operator come back" (review 6 K2). Our own synthetic
	// posts are marked by the helper and do not count, so any growth is a person.
	const runStartedAt = Date.now();
	const activityBefore = await macosHelper.command("userActivity", {}).catch(() => undefined);
	const frontmost = await macosBackend.getFrontmost();
	record("environment", "operator app", "pass", `${frontmost.appName} pid=${frontmost.pid}`);

	// Anything already running belongs to the operator. This run may only act on
	// processes it started itself, so an app that was here before is never a target -
	// not even the fixture, and not an app the operator named with --allow-l2-app.
	const atStartup = await macosBackend.listApps();
	const beforeRun = new Set(atStartup.map((app) => app.pid));
	record("environment", "apps at startup", "pass", `${beforeRun.size} running; only processes started by this run may be operated`);
	const startedByThisRun = (app) => !beforeRun.has(app.pid);

	// ---- fixture: not on the L2 list, so the product path must refuse it ----
	let launchPath = fixturePath;
	let fixtureRun;
	if (fixtureCopy) {
		fixtureRun = prepareFixtureRun({ sourceApp: fixturePath, runRoot });
		launchPath = fixtureRun.bundlePath;
		record("fixture", "fresh copy", "pass", `bundle=${fixtureRun.bundleId} path=${launchPath}`);
	}
	// The run's own copy is the only app this phase may raise: a background launch never
	// builds a SwiftUI window, so the launch itself activates it (review 6 P3). There is
	// no `open -n` fallback any more - an ad-hoc launch command is not part of a frozen
	// script, and a window that never appears is a result.
	await launchFixture(macosBackend, fixtureRun ?? { bundlePath: launchPath }).catch((error) => record("fixture", "launch", "fail", error instanceof Error ? error.message : String(error)));
	await sleep(1500);
	const apps = await macosBackend.listApps();
	let fixture = apps.find((app) => isFixtureBundleId(app.bundleId) && startedByThisRun(app))
		?? apps.find((app) => app.bundleId === "com.example.cu-fixture")
		?? apps.find((app) => /fixture/i.test(app.appName ?? ""));
	if (fixture && !startedByThisRun(fixture)) {
		record("fixture", "present", "skipped", `pid=${fixture.pid} was already running before this run; quit it so the check can launch its own copy`);
		fixture = undefined;
	}
	if (!fixture) {
		if (!rows.some((row) => row.area === "fixture" && row.action === "present")) {
			record("fixture", "present", "fail", "the fixture app is not running and could not be launched");
		}
	} else {
		record("fixture", "present", "pass", `pid=${fixture.pid} bundle=${fixture.bundleId}`);
		// `launchFixture` activated the copy, so the window is being built now; poll for it
		// instead of guessing a fixed sleep (the 1.2 s wait sat exactly on the edge).
		const root = await ensureFixtureWindow(macosBackend, { pid: fixture.pid });
		if (!root) {
			record("fixture", "window", "fail", "no window in listRoots even after activating the fixture");
		} else {
			const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
			const controls = { text: fixtureRef(look, ["AXTextField"]) ?? wireRefByRole(look, ["AXTextField"]), button: fixtureRef(look, ["AXButton"]) ?? wireRefByRole(look, ["AXButton"]) };
			record("fixture", "controls", controls.text && controls.button ? "pass" : "inconclusive", `text=${controls.text ?? "-"} button=${controls.button ?? "-"}`);

			if (controls.button) {
				// Review 7 R1: the same counter judges both clicks, so this row is no longer
				// stuck at `inconclusive` while the app really did change.
				const target = { windowId: root.windowId, rootRef: root.rootRef };
				const countBefore = await fixtureClickCount(macosBackend, target).catch(() => undefined);
				await probe("fixture (not on the L2 list)", look, fixture.pid, { action: "click", ref: controls.button }, controls);
				const countAfter = await fixtureClickCount(macosBackend, target).catch(() => undefined);
				const readable = typeof countBefore === "number" && typeof countAfter === "number";
				record("fixture (not on the L2 list)", "click effect", !readable ? "skipped" : countAfter === countBefore + 1 ? "pass" : countAfter === countBefore ? "fail" : "unknown", `before=clicks:${countBefore ?? "?"} after=clicks:${countAfter ?? "?"}`);
			}
			if (controls.text) {
				// Point the field at a known value first so "did the input arrive" is a
				// value change, not a guess.
				// The successful click above changed the tree, so its refs are stale:
				// observe again instead of reusing an evicted look.
				const fresh = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
				const textRef = wireRefByRole(fresh, ["AXTextField"]);
				if (!textRef) {
					record("fixture (not on the L2 list)", "typeText", "skipped", "the text field disappeared after the click");
				} else {
					await macosBackend.act({ lookId: fresh.lookId, pid: fixture.pid, target: { ref: textRef }, action: "clear", policy: "ax_only" }, { timeoutMs: 20_000 }).catch(() => undefined);
					const typed = await probe("fixture (not on the L2 list)", fresh, fixture.pid, { action: "typeText", ref: textRef, params: { text: TYPED } });
					const after = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
					const received = String((after.parsedOutline?.nodes ?? []).find((node) => node.role === "AXTextField")?.value ?? "");
					record("fixture (not on the L2 list)", "input received", received === TYPED ? "pass" : typed.outcome === "worked" ? "fail" : "pass", `field="${received}" expected="${TYPED}" outcome=${typed.outcome}`);
				}
			}
		}
	}

	// ---- apps on the L2 list: the positive path ----
	// Never drive an app the operator already had open unless they name it: the
	// point of the check is to type into something this run owns.
	const allowL2App = argument("--allow-l2-app");
	const onList = (await macosBackend.listApps()).filter((app) => app.bundleId && L2_COMPATIBLE_BUNDLE_IDS.has(app.bundleId));
	const installed = onList.filter((app) => allowL2App && app.bundleId === allowL2App && startedByThisRun(app));
	if (!allowL2App) {
		record("L2 whitelist", "app on the list", "skipped", onList.length === 0 ? "nothing from the list is running" : `running: ${onList.map((app) => app.appName).join(", ")}; pass --allow-l2-app <bundleId> to type into it`);
	} else if (installed.length === 0) {
		const preexisting = onList.find((app) => app.bundleId === allowL2App);
		record("L2 whitelist", "app on the list", "skipped", preexisting
			? `${allowL2App} (pid=${preexisting.pid}) was already running before this run; this script only operates processes it started`
			: `${allowL2App} is not running; start it and re-run, this script does not launch user apps`);
	}
	for (const app of installed) {
		const roots = await macosBackend.listRoots({ pid: app.pid });
		const root = roots.find((candidate) => candidate.kind === "window");
		if (!root) {
			record(app.appName ?? app.bundleId, "window", "fail", "no window in listRoots");
			continue;
		}
		const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
		const text = wireRefByRole(look, ["AXTextField", "AXTextArea"]);
		if (text) await probe(app.appName ?? app.bundleId, look, app.pid, { action: "typeText", ref: text, params: { text: TYPED } }, {});
		else record(app.appName ?? app.bundleId, "typeText", "skipped", "no text input element in the window; not typing blind into a user app");
		// A directed click only where the window exposes a button: never click blind.
		const button = wireRefByRole(look, ["AXButton"]);
		if (button) await probe(app.appName ?? app.bundleId, look, app.pid, { action: "click", ref: button }, {});
		else record(app.appName ?? app.bundleId, "click", "skipped", "no button in the window");
	}

	if (directL2) await runDirectL2({ fixture, fixtureRun, backend: macosBackend, helper: macosHelper, record, cursor, alive, wireRefByRole, typed: TYPED, asciiInput: inputSource.ascii });

	record("helper", "still alive", (await alive()) ? "pass" : "fail", "the helper answered diagnostics after every probe (no crash)");

	if (fixtureRun) {
		const cleanup = await disposeFixtureRun(fixtureRun, macosBackend);
		record("cleanup", "fixture copy", cleanup.quit.length ? "pass" : "inconclusive", `quit=${cleanup.quit.join(",") || "none"} removed=${fixtureRun.dir}`);
	}

	// Leave the operator's app in front again, and read it back (review 6 P2).
	await restoreOperatorApp({ backend: macosBackend, original: frontmost, record });

	// Anything that appeared in front of the operator during the run - or a real event
	// the helper counted - means the window was not exclusively ours (K2).
	const runPids = [fixture?.pid, ...installed.map((app) => app.pid)].filter((pid) => typeof pid === "number");
	await recordRealUserInput({ helper: macosHelper, backend: macosBackend, record, activityBefore, operatorPid: frontmost.pid, runPids });

	// Review 7 R2 step 1: report where the events came from, change no rule. The helper's
	// ring holds only the last few hundred events, so this covers the run and not the hour.
	const activityAfter = await macosHelper.command("userActivity", {}).catch(() => undefined);
	const recent = Array.isArray(activityAfter?.recentEvents) ? activityAfter.recentEvents : [];
	const windowEvents = recent.filter((event) => Number(event?.at) >= runStartedAt);
	const names = resolveProcessNames(windowEvents.map((event) => Number(event?.pid)));
	for (const row of attributionRows(windowEvents, { processName: (pid) => names.get(pid), runPids, helperPid: diagnostics.pid })) {
		record(row.area, row.action, row.result, row.note);
	}
}

async function writeEvidence() {
	const runName = `${runStamp()}-l2-check.md`;
	// Without `beginStep` there is no runs directory and no commit, so a refusal cannot
	// write an archive that a later step would mistake for permission.
	const written = frozen
		? writeRunArchive({
			reportOnly: frozen.reportOnly === true,
			runsDir: frozen.runsDir,
			runName,
			title: "Computer Use v2 L2 single-action check",
			step: frozen.step,
			commit: frozen.commit,
			rows: rows.map((row) => ({ ...row, note: withoutHome(row.note) })),
			log: log.map(withoutHome),
			intro: [
				`One directed click and one directed text input per target, delivered with \`background\` policy.${b0 ? " This is the B0 attribution run: it reports, it authorizes nothing." : ""}`,
				"`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.",
				"`attribution` rows group the events the helper counted as real input by source process and event type (review 7, R2).",
			],
		})
		: { verdict: "refused", blockers: [], path: undefined };
	if (written.verdict === "fail") {
		process.exitCode = 1;
		console.error(`[cu-v2 l2] FAILED: ${written.blockers.join("; ")}`);
	}
	if (written.verdict === "report") {
		console.error("[cu-v2 l2] attribution report only: no Verdict line, no step authorized, no B-STOPPED");
	}
	return written;
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	console.error(`[cu-v2 l2] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

await writeEvidence();
const failures = rows.filter((row) => row.result === "fail").length;
console.log(`[cu-v2 l2] ${rows.length} rows, ${failures} failing; archive written to ${frozen?.runsDir ?? "nowhere (refused before the runs directory was known)"}`);
