import { describe, expect, it } from "vitest";
import { classifyProviderMessage, providerDetail, providerUserVisible, spanCategoryFor, summarizeProviderErrors, traceErrorSpans } from "../src/loop/harvest-provider.ts";

describe("provider error categories", () => {
	it("buckets messages without keeping the text", () => {
		expect(classifyProviderMessage("Qoder: stream_failed")).toBe("qoder:stream_failed");
		expect(classifyProviderMessage("Qoder: connection_failed")).toBe("connect");
		expect(classifyProviderMessage("connect ECONNREFUSED 127.0.0.1:443")).toBe("connect");
		expect(classifyProviderMessage("fetch failed")).toBe("connect");
		expect(classifyProviderMessage("429 Too Many Requests")).toBe("429");
		expect(classifyProviderMessage("503 Service Unavailable")).toBe("5xx");
		expect(classifyProviderMessage("Qoder: request_timeout")).toBe("timeout");
		expect(classifyProviderMessage("The operation timed out")).toBe("timeout");
		expect(classifyProviderMessage("Qoder: http_429")).toBe("429");
		expect(classifyProviderMessage("Qoder: http_503")).toBe("5xx");
		expect(classifyProviderMessage("Qoder: http_403")).toBe("qoder:http_403");
		expect(classifyProviderMessage("something odd happened")).toBe("other");
		expect(classifyProviderMessage("")).toBe("other");
	});

	it("pairs a failed request span with the nearest incident and consumes it", () => {
		const spans = traceErrorSpans([
			JSON.stringify({ kind: "span_end", name: "pi.ai.request", status: "error", timestamp: "2026-11-03T10:00:10.000Z", attributes: { "pi.ai.error.category": "timeout" } }),
			JSON.stringify({ kind: "span_end", name: "pi.ai.request", status: "error", timestamp: "2026-11-03T10:05:10.000Z", attributes: { "pi.ai.error.category": "http" } }),
			JSON.stringify({ kind: "span_end", name: "pi.ai.request", status: "ok", timestamp: "2026-11-03T10:06:10.000Z", attributes: {} }),
			JSON.stringify({ kind: "span_end", name: "pi.session.compaction", status: "error", timestamp: "2026-11-03T10:07:10.000Z" }),
		]);
		expect(spans).toHaveLength(2);
		expect(spanCategoryFor(spans, "2026-11-03T10:05:12.000Z")).toBe("http");
		expect(spanCategoryFor(spans, "2026-11-03T10:00:11.000Z")).toBe("timeout");
		expect(spanCategoryFor(spans, "2026-11-03T10:05:12.000Z")).toBeUndefined();
		// Outside the tolerance the nearest span is not a match at all.
		expect(spanCategoryFor([{ timestamp: Date.parse("2026-11-03T10:00:00.000Z"), category: "network" }], "2026-11-03T10:10:00.000Z")).toBeUndefined();

		const detail = providerDetail({ provider: "qoder", model: "dfmodel", errorMessage: "Qoder: stream_failed", spans: [{ timestamp: Date.parse("2026-11-03T10:00:10.000Z"), category: "websocket" }], timestamp: "2026-11-03T10:00:11.000Z" });
		// The bucket comes from the trace, the provider's own code is kept from the message.
		expect(detail).toEqual({ provider: "qoder", model: "dfmodel", category: "websocket", categorySource: "trace", code: "qoder:stream_failed" });
	});

	it("summarizes incidents into provider x category x recovered rows", () => {
		// `recovered: true` means a later usable answer closed the retry run: the failure did not
		// reach the user. The field was called `final` and read backwards once; the name is now the
		// fact it records.
		const summary = summarizeProviderErrors([
			{ detail: { provider: "qoder", model: "dfmodel", category: "timeout", recovered: false, attempts: 3 } },
			{ detail: { provider: "qoder", model: "dfmodel", category: "timeout", recovered: false, attempts: 1 } },
			{ detail: { provider: "qoder", model: "dfmodel", category: "timeout", recovered: true, attempts: 1 } },
			{ detail: { provider: "qoder", model: "dfmodel", category: "network", recovered: true, attempts: 2 } },
		]);
		expect(summary.total).toBe(4);
		expect(summary.recovered).toBe(2);
		expect(summary.userVisible).toBe(2);
		expect(providerUserVisible(summary.rows)).toBe(2);
		expect(summary.rows.map((row) => [row.category, row.recovered, row.count, row.attempts])).toEqual([
			["timeout", false, 2, 4],
			["network", true, 1, 2],
			["timeout", true, 1, 1],
		]);
	});
});
