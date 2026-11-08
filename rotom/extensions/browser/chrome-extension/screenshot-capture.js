// Screenshot capture with per-command bounds.
//
// `Page.captureScreenshot` and `Page.getLayoutMetrics` have both been seen to never resolve
// on a hidden tab (Linux), and a pending CDP command holds the tab lock until the whole
// operation deadline: `hello`, `tabs` and `close` all queue behind it, so the session looks
// dead. Capturing with focus emulation enabled is the renderer state that answers, and each
// command is bounded here as well, so a hang becomes a timeout that releases the lock
// instead of a stuck tab.

import { valueWithinRelayDeadline } from "./relay-deadline.js";

export const SCREENSHOT_METRICS_WAIT_MS = 3_000;
export const SCREENSHOT_CAPTURE_WAIT_MS = 5_000;

/**
 * @param {{
 *   sendCommand: (method: string, parameters: unknown) => Promise<unknown>,
 *   assertOperation?: () => void,
 *   metricsWaitMs?: number,
 *   captureWaitMs?: number,
 * }} input
 *   `sendCommand` issues one CDP command on the already-attached target.
 * @returns {Promise<{ metricsBefore: unknown, captured: unknown, metricsAfter: unknown }>}
 *   never resolves while a command is still pending: a command that misses its bound throws
 *   `browser relay <method> timeout`, so the caller's operation fails as a timeout (unknown)
 *   instead of succeeding with a partial capture.
 */
export async function captureScreenshotWithin(input) {
	const metricsWaitMs = input.metricsWaitMs ?? SCREENSHOT_METRICS_WAIT_MS;
	const captureWaitMs = input.captureWaitMs ?? SCREENSHOT_CAPTURE_WAIT_MS;
	const command = async (method, parameters, timeoutMs) => {
		const bounded = await valueWithinRelayDeadline(input.sendCommand(method, parameters), timeoutMs);
		if (!bounded.ok) throw new Error(`browser relay ${method} timeout`);
		input.assertOperation?.();
		return bounded.value;
	};
	await command("Emulation.setFocusEmulationEnabled", { enabled: true }, metricsWaitMs);
	try {
		const metricsBefore = await command("Page.getLayoutMetrics", undefined, metricsWaitMs);
		const captured = await command("Page.captureScreenshot", { format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false }, captureWaitMs);
		const metricsAfter = await command("Page.getLayoutMetrics", undefined, metricsWaitMs);
		return { metricsBefore, captured, metricsAfter };
	} finally {
		// Best effort: a hanging disable must not extend the timeout we already report, and
		// the capture already failed.
		await command("Emulation.setFocusEmulationEnabled", { enabled: false }, metricsWaitMs).catch(() => undefined);
	}
}
