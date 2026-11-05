#!/usr/bin/env node
/**
 * B-phase gate check: may a real-machine step run right now?
 *
 * The operator authorized a time window and asked that every step re-check two
 * things: we are still inside the window, and no real user input happened in the
 * last N minutes. Two independent sources are reported, because neither alone is
 * enough:
 *
 *   HIDIdleTime      kernel-wide, but also reset by *our own* synthetic events, so it
 *                    is only meaningful before a step that types or clicks.
 *   helper activity  the isolated helper's event tap, which marks its own events and
 *                    therefore counts only real input (eventSourceUserData marker).
 *
 * Exit 0 = pass, 1 = hold, 2 = misconfigured. It prints one JSON object per call so a
 * run archive can keep the exact readings instead of a paraphrase.
 *
 *   node scripts/cu-v2-gate.mjs --window-start 2026-11-05T03:33:00-08:00 --window-minutes 60
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const windowStart = arg("--window-start");
const listeningSince = arg("--listening-since");
const windowMinutes = Number(arg("--window-minutes", "60"));
const requireIdleMinutes = Number(arg("--require-idle-minutes", "10"));
if (!windowStart || !Number.isFinite(windowMinutes)) {
	console.error("usage: cu-v2-gate.mjs --window-start <iso> [--window-minutes 60] [--require-idle-minutes 10]");
	process.exit(2);
}

const startMs = Date.parse(windowStart);
const nowMs = Date.now();
const minutesLeft = (startMs + windowMinutes * 60_000 - nowMs) / 60_000;

function hidIdleSeconds() {
	try {
		const out = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" });
		const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
		return match ? Number(match[1]) / 1e9 : null;
	} catch {
		return null;
	}
}

const report = {
	at: new Date(nowMs).toISOString(),
	window_start: windowStart,
	window_minutes: windowMinutes,
	minutes_left: Number(minutesLeft.toFixed(1)),
	inside_window: minutesLeft > 0 && nowMs >= startMs,
	hid_idle_seconds: null,
	helper: null,
	gates: {},
};

report.hid_idle_seconds = hidIdleSeconds();
report.gates.inside_window = report.inside_window;

// The helper reading needs the isolated socket. When no helper is up yet the probe
// starts it (that is the point: the tap has to be listening to prove anything).
if (process.env.PI_CU_SOCKET_PATH && process.env.PI_COMPUTER_USE_HELPER_APP_PATH) {
	try {
		const { macosHelper } = await import("../src/platform/macos/helper.ts");
		const activity = await macosHelper.command("userActivity", {});
		report.helper = activity;
		const last = Number(activity.lastUserInputAt ?? 0);
		const idleSeconds = last === 0 ? null : (nowMs - last) / 1000;
		report.helper_idle_seconds = idleSeconds === null ? null : Number(idleSeconds.toFixed(1));
		// A helper that has never seen input proves "no input while listening" instead,
		// but only once it has been listening for the full idle window: zero events two
		// seconds after start proves nothing. `--listening-since` is the moment the tap
		// came up, recorded when it first reported listening.
		const listeningMs = listeningSince ? Date.parse(listeningSince) : Number.NaN;
		const listenedSeconds = Number.isFinite(listeningMs) ? (nowMs - listeningMs) / 1000 : null;
		report.listened_seconds = listenedSeconds === null ? null : Number(listenedSeconds.toFixed(1));
		report.gates.no_recent_user_input =
			idleSeconds !== null
				? idleSeconds >= requireIdleMinutes * 60
				: activity.listening === true &&
					Number(activity.userEventCount ?? 0) === 0 &&
					listenedSeconds !== null &&
					listenedSeconds >= requireIdleMinutes * 60;
	} catch (error) {
		report.helper_error = error instanceof Error ? error.message : String(error);
		report.gates.no_recent_user_input = false;
	}
} else {
	report.helper_error = "PI_CU_SOCKET_PATH / PI_COMPUTER_USE_HELPER_APP_PATH not set";
	report.gates.no_recent_user_input = false;
}

report.verdict = report.gates.inside_window && report.gates.no_recent_user_input ? "pass" : "hold";
console.log(JSON.stringify(report));
process.exit(report.verdict === "pass" ? 0 : 1);
