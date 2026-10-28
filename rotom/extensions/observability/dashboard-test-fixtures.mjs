import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCHEMA = "rotom-local-trace/v1";

export function span(kind, overrides = {}) {
	return {
		schema: SCHEMA,
		kind,
		timestamp: "2026-08-28T12:00:00.000Z",
		traceId: "a".repeat(32),
		spanId: (overrides.spanId ?? "b".repeat(16)),
		name: "pi.ai.request",
		...(kind === "span_end" ? { status: "ok", durationMs: 125 } : {}),
		...overrides,
	};
}

export async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-trace-dashboard-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sessionDirectory = join(root, "project/session");
	const traceDirectory = join(sessionDirectory, "observability");
	await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
	await writeFile(join(sessionDirectory, "session.jsonl"), "{\"type\":\"session\"}\n", { mode: 0o600 });
	const tracePath = join(traceDirectory, "session.trace.jsonl");
	const records = [
		span("span_start"),
		span("span_end", { attributes: {
			"pi.usage.input_tokens": 20,
			"pi.usage.output_tokens": 10,
			"pi.usage.reasoning_tokens": 4,
			"pi.usage.cache_read_tokens": 291,
			"pi.usage.cache_write_tokens": 0,
			"pi.usage.total_tokens": 321,
			"pi.usage.cost": 0.012,
			"pi.ai.stream.time_to_first_content_ms": 100,
			"pi.context.tokens": 96_000,
			"pi.context.window_tokens": 128_000,
			"pi.context.percent": 75,
			"unsafe.object": { secret: "must-drop" },
		} }),
		span("span_start", { spanId: "c".repeat(16), name: "pi.tool.execute", attributes: { "pi.tool.name": "bash" } }),
		span("span_end", { spanId: "c".repeat(16), name: "pi.tool.execute", status: "error", durationMs: 50, attributes: { "pi.tool.name": "bash", "pi.tool.result_estimated_tokens": 25 } }),
		span("span_start", { spanId: "d".repeat(16), name: "pi.ai.startup" }),
		span("span_end", { spanId: "d".repeat(16), name: "pi.ai.startup", durationMs: 40 }),
		span("span_start", { spanId: "e".repeat(16), name: "pi.ai.prefill" }),
		span("span_end", { spanId: "e".repeat(16), name: "pi.ai.prefill", durationMs: 60 }),
		span("span_start", { spanId: "f".repeat(16), name: "pi.ai.reasoning" }),
		span("span_end", { spanId: "f".repeat(16), name: "pi.ai.reasoning", durationMs: 100 }),
		span("span_start", { spanId: "0".repeat(16), name: "pi.ai.generation" }),
		span("span_end", { spanId: "0".repeat(16), name: "pi.ai.generation", durationMs: 100 }),
	];
	await writeFile(tracePath, `${records.map(JSON.stringify).join("\n")}\nnot-json\n${"x".repeat(70 * 1024)}\n`, { mode: 0o600 });
	return { root, tracePath };
}
