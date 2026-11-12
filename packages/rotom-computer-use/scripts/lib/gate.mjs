/**
 * The B-phase gate, as a library.
 *
 * Every real-machine step re-checks the operator's authorized time window inside the
 * script. User activity is deliberately not a gate: B0-B4 must prove background safety
 * while the operator continues using the Mac.
 */
/**
 * Decide the verdict from readings, with no side effects.
 *
 * Kept separate from reading so the authorization-window rules can be tested without a
 * machine.
 */
export function evaluateGate(options) {
	const { windowStartMs, windowMinutes, nowMs } = options;
	const minutesLeft = (windowStartMs + windowMinutes * 60_000 - nowMs) / 60_000;
	const insideWindow = minutesLeft > 0 && nowMs >= windowStartMs;
	return {
		at: new Date(nowMs).toISOString(),
		window_start: options.windowStart,
		window_minutes: windowMinutes,
		minutes_left: Number(minutesLeft.toFixed(1)),
		inside_window: insideWindow,
		gates: { inside_window: insideWindow },
		verdict: insideWindow ? "pass" : "hold",
	};
}

/** Read both sources, then decide. */
export async function readGate(options) {
	const nowMs = options.nowMs ?? Date.now();
	const windowStartMs = options.windowStartMs ?? Date.parse(options.windowStart);
	return evaluateGate({ ...options, windowStartMs, nowMs });
}

/** Why the authorization-window gate held, in the words an operator needs. */
export function holdReason(report) {
	return `inside_window=${report.gates?.inside_window} minutes_left=${report.minutes_left}`;
}

export class GateHold extends Error {
	constructor(report) {
		super(`gate verdict is '${report.verdict}': ${holdReason(report)}`);
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
	const report = await readGate({ ...options, windowMinutes });
	if (report.verdict !== "pass") throw new GateHold(report);
	return report;
}
