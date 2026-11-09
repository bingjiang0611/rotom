import { describe, expect, it } from "vitest";
import {
	annotateLimitError,
	isNonRetryableLimitAssistantError,
	isRetryableAssistantError,
	serverRequestedDelayMs,
	type RetryPolicy,
	retryAssistantCall,
	retryDelayMs,
} from "../src/utils/retry.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";

// Quota and 429 handling: a 402 was retried three times before the user saw it, and a
// 429 arrived before the server's own window. Both are policy, not transport, so they
// live beside the retry suite instead of inside it.

describe("account limits and server-requested delays", () => {
	// Observed on this machine: a gateway answered 402 with a balance message, and Pi's
	// bounded retry spent three attempts on it before the user saw the failure.
	const balanceMessage = "402 Payment Required: Radius gateway account balance is insufficient: $0.00 available, $0.00 used";

	it("treats a 402 balance failure as non-retryable and says what to do", async () => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: balanceMessage }))).toBe(false);
		expect(isNonRetryableLimitAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: balanceMessage }))).toBe(true);
		const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: balanceMessage }));
		const onRetryScheduled = vi.fn();
		const result = await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(result.errorMessage).toContain(balanceMessage);
		expect(result.errorMessage).toContain("faux");
		expect(result.errorMessage).toMatch(/top up|switch models/u);
	});

	it("annotates a limit error once, even when the same message comes back", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }));
		const once = await retryAssistantCall(produce, { enabled: true, maxRetries: 3, baseDelayMs: 0 }, undefined);
		const twice = annotateLimitError(once);
		expect(twice.errorMessage).toBe(once.errorMessage);
		expect(once.errorMessage!.split("[rotom]").length).toBe(2);
	});

	it("keeps a transient failure free of account advice", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const result = await retryAssistantCall(produce, { enabled: true, maxRetries: 0, baseDelayMs: 1 }, undefined);
		expect(result.errorMessage).toBe("terminated");
	});

	it("honors retry-after-ms from the failure instead of the exponential delay", async () => {
		let n = 0;
		const policy: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 5000 };
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 too many requests (retry-after-ms: 20)` })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([20]);
	});

	it("honors Retry-After seconds and caps them at the agent-level maximum", async () => {
		const policy: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 30 };
		const requested = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests (retry-after: 277403)" }),
		);
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(requested, policy, undefined, { onRetryScheduled });
		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([30]);
	});

	it("reads the requested delay from the provider retry cap message", async () => {
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Server requested 120s retry delay (max: 60s). upstream is saturated",
		});
		expect(serverRequestedDelayMs(message)).toBe(120_000);
		const policy: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 25 };
		const produce = vi.fn(async () => message);
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([25]);
	});

	it("falls back to the exponential delay when the provider requested nothing", async () => {
		const policy: RetryPolicy = { enabled: true, maxRetries: 1, baseDelayMs: 7, maxAgentDelayMs: 1000 };
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		await retryAssistantCall(produce, policy, undefined, { onRetryScheduled });
		expect(onRetryScheduled.mock.calls.map((call) => call[2])).toEqual([7]);
	});

	it("prefers a structured retryAfterMs over the text", () => {
		expect(serverRequestedDelayMs(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 retry-after: 9", retryAfterMs: 12 }))).toBe(12);
	});
});
