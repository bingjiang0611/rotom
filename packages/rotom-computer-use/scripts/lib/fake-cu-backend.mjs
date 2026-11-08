/**
 * A fake Computer Use backend, used only by the dry run (review 8, T1).
 *
 * The live scripts were never executed before a window; three of the four wasted windows
 * failed on something a Linux run of the main path would have caught. `cu-v2-l2-check.mjs`
 * therefore accepts `PI_CU_FAKE_BACKEND=<path to this module>` and refuses that injection
 * together with `--expect-commit`, so a fake run can never be mistaken for evidence about a
 * frozen commit. This module supplies a backend, a helper and gate readings that need no
 * desktop, and the commit it reports is all zeros so no archive it writes can authorize a
 * real step.
 *
 * `PI_CU_FAKE_SCENARIO` selects the case the dry run wants:
 *   pass         - both clicks land, events are marked, ring matches the counters
 *   fail         - the directed L2 click does not land
 *   ring-lost    - the ring is gone on the second read (T2, missing ring)
 *   lost-events  - the ring drops a record the counters counted (T2, reconciliation)
 *   activate-only - the directed post activates the window but presses nothing (R9)
 *   no-support   - the helper reports no ring at all, so T3 refuses the run
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const scenario = process.env.PI_CU_FAKE_SCENARIO ?? "pass";

/** Never a real commit: an archive from a fake run must not authorize anything. */
export const commit = "0".repeat(40);
export const helperProtocolVersion = 9;
export const l2CompatibleBundleIds = new Set();

/**
 * A held gate, so the refusal path is executed rather than read: `gate-hold` reproduces the
 * reading that cost a window - a hold whose reason was only in the gate JSON.
 */
export const gate =
	scenario === "gate-hold"
		? {
			at: new Date().toISOString(),
			window_start: "2026-01-01T00:00:00+0000",
			window_minutes: 60,
			minutes_left: 49.5,
			inside_window: true,
			hid_idle_seconds: 641.9,
			helper: null,
			gates: { inside_window: true, no_recent_user_input: false },
			helper_error: "pi-computer-use helper app daemon is unavailable at ~/cu-v2-test/pi-computer-use.app.",
			verdict: "hold",
		}
		: {
	at: new Date().toISOString(),
	window_start: "2026-01-01T00:00:00+0000",
	window_minutes: 60,
	minutes_left: 49.5,
	inside_window: true,
	hid_idle_seconds: 640,
	helper_idle_seconds: -1,
	gates: { inside_window: true, no_recent_user_input: true },
	helper: { listening: true, userEventCount: 0, agentEventCount: 0, lastUserInputAt: 0 },
			verdict: "pass",
		};

const operator = { pid: 4242, appName: "FakeOperator", bundleId: "com.example.operator" };
let fixtureApp;
let clicks = 0;
let firstMouseClicks = 0;
let text = "";
let lookSeq = 0;
let activityCalls = 0;
let activatedByPost = false;
// The counters are the helper's own tally, not a count of the ring: a ring that overflows or
// loses a record must disagree with them, which is what T2 asks the script to notice.
const events = [];
const counters = { userEventCount: 0, agentEventCount: 0 };

function pushEvent(agent) {
	events.push({ at: Date.now(), type: 1, pid: 0, stateId: 1, agent });
	if (agent) counters.agentEventCount += 1;
	else counters.userEventCount += 1;
	if (events.length > 512) events.shift();
}

function bundleIdOf(bundlePath) {
	try {
		const plist = readFileSync(path.join(bundlePath, "Contents", "Info.plist"), "utf8");
		return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
	} catch {
		return undefined;
	}
}

function outlineNodes() {
	return [
		{ role: "AXTextField", identifier: "cu-fixture-text", wireRef: "@e1", value: text },
		{ role: "AXButton", identifier: "cu-fixture-button", wireRef: "@e2", value: `clicks: ${clicks}` },
		{ role: "AXStaticText", identifier: "cu-fixture-button-result", wireRef: "@e3", value: `clicks: ${clicks}` },
		{ role: "AXButton", identifier: "operator-close", wireRef: "@e4", value: "" },
		{ role: "AXButton", identifier: "cu-fixture-first-mouse-button", wireRef: "@e5", value: `appkit-clicks: ${firstMouseClicks}` },
	];
}

const look = () => ({ lookId: `fake-look-${++lookSeq}`, parsedOutline: { nodes: outlineNodes() } });

export const backend = {
	async listApps() {
		const apps = [{ ...operator }];
		if (fixtureApp) apps.push({ pid: fixtureApp.pid, appName: "Fixture", bundleId: fixtureApp.bundleId });
		return apps;
	},
	async listRoots({ pid } = {}) {
		if (fixtureApp && pid !== undefined && pid !== fixtureApp.pid && pid !== operator.pid) return [];
		return [{ kind: "window", windowId: 7, pid: pid ?? operator.pid, rootRef: "@r7" }];
	},
	async getFrontmost() {
		if (activatedByPost && fixtureApp) return { pid: fixtureApp.pid, appName: "Fixture", windowId: 7 };
		return { ...operator, windowId: 7 };
	},
	async focusWindow() {
		activatedByPost = false;
		return { focused: true, alreadyFocused: true, windowId: 7, reason: null };
	},
	async manageApps(request) {
		if (request.mode === "launch") {
			fixtureApp = { pid: 5150, bundleId: bundleIdOf(request.path) ?? "com.example.cu-fixture.fake" };
			return { launched: true, pid: fixtureApp.pid, bundleId: fixtureApp.bundleId };
		}
		if (request.mode === "quit") {
			fixtureApp = undefined;
			return { quitRequested: true, terminated: true, forced: false, unsavedChangesMayBlock: false };
		}
		return {};
	},
	async observe() {
		return look();
	},
	async act(request) {
		const action = request.action;
		if (action === "click") {
			// The AX path always lands: the directed click is what the scenarios vary.
			if (request.target?.ref === "@e5") firstMouseClicks += 1;
			else clicks += 1;
			pushEvent(true);
			return { outcome: "unknown", performed: { delivery: "ax" } };
		}
		if (action === "typeText") {
			text = String(request.params?.text ?? "");
			pushEvent(true);
			return { outcome: "worked", performed: { delivery: "ax" } };
		}
		if (action === "clear") {
			text = "";
			return { outcome: "worked", performed: { delivery: "ax" } };
		}
		return { outcome: "unknown", performed: { delivery: "ax" } };
	},
};

export const helper = {
	async command(name, args) {
		if (name === "getMousePosition") return { x: 10, y: 10 };
		if (name === "userActivity") return activity();
		if (name === "calibrateHidEventSource") {
			pushEvent(true);
			events.at(-1).at -= 1000; // calibration precedes the formal action window
			return { found: true, pid: 4242, stateId: 1, type: 5, agentDelta: 1 };
		}
		if (name === "act") {
			if (scenario === "activate-only") activatedByPost = true;
			if (scenario !== "fail" && scenario !== "activate-only") {
				if (args?.target?.ref === "@e5") firstMouseClicks += 1;
				else clicks += 1;
			}
			pushEvent(true);
			if (scenario === "lost-events") events.pop();
			return { outcome: "unknown", performed: { delivery: args?.params?.delivery ?? args?.delivery ?? "l2" }, supported: true };
		}
		throw new Error(`fake helper does not implement ${name}`);
	},
	async diagnosticsCommand() {
		return { protocolVersion: helperProtocolVersion, accessibility: true, pid: 4242 };
	},
};

function activity() {
	activityCalls += 1;
	const payload = { listening: true, lastUserInputAt: 0, idleSeconds: -1, ...counters };
	// An older helper: no ring and no declared limit, which T3 refuses.
	if (scenario === "no-support") return payload;
	// A helper that answered at the start and can no longer list its ring.
	if (scenario === "ring-lost" && activityCalls > 1) return { ...payload, recentEventLimit: 512 };
	return { ...payload, recentEvents: events.map((event) => ({ ...event })), recentEventLimit: 512 };
}
