/**
 * The B-phase gate, as a library.
 *
 * The operator authorized a time window and asked that every real-machine step
 * re-check two things: we are still inside the window, and no real user input
 * happened in the last N minutes. A gate that only exists in an operator-side shell
 * loop is not a gate - `cu-v2-l2-check.mjs` was run once that way - so the decision
 * lives here and run scripts call `requireGate` themselves.
 *
 * Two independent sources are reported, because neither alone is enough:
 *
 *   HIDIdleTime      kernel-wide, but also reset by *our own* synthetic events and by
 *                    launching an app, so it is only meaningful before a step runs.
 *   helper activity  the isolated helper's event tap, which marks its own events and so
 *                    counts real input (eventSourceUserData marker).
 */
import { execFileSync } from "node:child_process";

export function hidIdleSeconds(exec = execFileSync) {
	try {
		const out = exec("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" });
		const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
		return match ? Number(match[1]) / 1e9 : null;
	} catch {
		return null;
	}
}

/**
 * Decide the verdict from readings, with no side effects.
 *
 * Kept separate from reading so the rules can be tested without a machine: the
 * interesting cases are "the helper has never seen input and has been listening long
 * enough" and "we have no reading at all", which must hold rather than pass.
 */
export function evaluateGate(options) {
	const { windowStartMs, windowMinutes, requireIdleMinutes, nowMs, listeningSinceMs, hidIdle, helper, helperError } = options;
	const minutesLeft = (windowStartMs + windowMinutes * 60_000 - nowMs) / 60_000;
	const report = {
		at: new Date(nowMs).toISOString(),
		window_start: options.windowStart,
		window_minutes: windowMinutes,
		minutes_left: Number(minutesLeft.toFixed(1)),
		inside_window: minutesLeft > 0 && nowMs >= windowStartMs,
		hid_idle_seconds: hidIdle === null ? null : Number(hidIdle.toFixed(1)),
		helper: helper ?? null,
		gates: {},
	};
	report.gates.inside_window = report.inside_window;
	if (helperError) report.helper_error = helperError;
	if (helper) {
		const last = Number(helper.lastUserInputAt ?? 0);
		const idleSeconds = last === 0 ? null : (nowMs - last) / 1000;
		report.helper_idle_seconds = idleSeconds === null ? null : Number(idleSeconds.toFixed(1));
		const listenedSeconds = Number.isFinite(listeningSinceMs) ? (nowMs - listeningSinceMs) / 1000 : null;
		report.listened_seconds = listenedSeconds === null ? null : Number(listenedSeconds.toFixed(1));
		// A helper that has never seen input proves "no input while listening" instead,
		// but only once it has been listening for the full idle window: zero events two
		// seconds after start proves nothing.
		report.gates.no_recent_user_input =
			idleSeconds !== null
				? idleSeconds >= requireIdleMinutes * 60
				: helper.listening === true && Number(helper.userEventCount ?? 0) === 0 && listenedSeconds !== null && listenedSeconds >= requireIdleMinutes * 60;
	} else {
		report.gates.no_recent_user_input = false;
	}
	report.verdict = report.gates.inside_window && report.gates.no_recent_user_input ? "pass" : "hold";
	return report;
}

/** Read both sources, then decide. */
export async function readGate(options) {
	const nowMs = options.nowMs ?? Date.now();
	const listeningSinceMs = options.listeningSince ? Date.parse(options.listeningSince) : Number.NaN;
	let helper = null;
	let helperError;
	if (process.env.PI_CU_SOCKET_PATH && process.env.PI_COMPUTER_USE_HELPER_APP_PATH) {
		try {
			const { macosHelper } = await import("../../src/platform/macos/helper.ts");
			helper = await macosHelper.command("userActivity", {});
		} catch (error) {
			helperError = error instanceof Error ? error.message : String(error);
		}
	} else {
		helperError = "PI_CU_SOCKET_PATH / PI_COMPUTER_USE_HELPER_APP_PATH not set";
	}
	return evaluateGate({ ...options, nowMs, listeningSinceMs, hidIdle: hidIdleSeconds(options.exec ?? execFileSync), helper, helperError });
}

/** A refusal carries the readings so the caller can archive them. */
export class GateHold extends Error {
	constructor(report) {
		super(`gate verdict is '${report.verdict}': inside_window=${report.gates.inside_window} no_recent_user_input=${report.gates.no_recent_user_input}`);
		this.name = "GateHold";
		this.report = report;
	}
}

/**
 * Refuse to run unless the window was declared and the gate passes.
 *
 * No window arguments is a refusal, not an implicit "run anyway": the window is the
 * operator's authorization, and a script cannot invent it.
 */
export async function requireGate(options) {
	const windowMinutes = Number(options.windowMinutes);
	if (!options.windowStart || !Number.isFinite(windowMinutes)) {
		throw new Error("--window-start and --window-minutes are required: the gate cannot be evaluated without the authorized window");
	}
	const requireIdleMinutes = Number(options.requireIdleMinutes ?? 10);
	const report = await readGate({ ...options, windowMinutes, requireIdleMinutes });
	if (report.verdict !== "pass") throw new GateHold(report);
	return report;
}
