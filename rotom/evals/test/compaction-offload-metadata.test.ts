import { expect, it } from "vitest";
import { createReplayMetrics } from "../src/compaction-offload-metrics.ts";

it("counts successful phase-one reads once per manifest file, partial calls separately, without exporting paths", () => {
	const handlers = new Map<string, Function>();
	const metrics = createReplayMetrics(() => 0, { "alpha.txt": "one\ntwo\nthree\n", "beta.txt": "beta", "gamma.txt": "gamma" });
	(metrics.extension as Function)({ on: (name: string, handler: Function) => handlers.set(name, handler) });
	handlers.get("session_start")!({}, { cwd: "/synthetic" });
	const call = (id: string, path: string, extra = {}) => ({ type: "toolCall", id, name: "read", arguments: { path, ...extra } });
	const message = (message: object) => ({ type: "message", message });
	const assistant = (content: object[], input: number, cacheRead: number, cacheWrite: number, stopReason = "toolUse") => message({
		role: "assistant", content, stopReason, usage: { input, output: 1, cacheRead, cacheWrite, cost: { total: 0 } },
	});
	const result = (id: string, extra = {}) => message({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "PRIVATE_BODY" }], ...extra });
	const entries = [
		message({ role: "user", content: "First phase" }),
		assistant([call("a", "alpha.txt", { limit: 1 }), call("b", "./alpha.txt", { offset: 2 }),
			call("c", "@/synthetic/alpha.txt", { offset: 1, limit: 100 }), call("d", "gamma.txt"),
			call("e", "/outside/PRIVATE_PATH"), call("f", "alpha.txt")], 7, 3, 2),
		result("a"), result("b"), result("c"), result("d", { isError: true }), result("e"),
		result("f", { details: { truncation: { truncated: true } } }),
		assistant([{ type: "text", text: "READY" }], 20, 5, 4, "stop"),
		// Even before a second user message, the final reply closes phase one.
		assistant([call("g", "beta.txt")], 30, 6, 4), result("g"),
		message({ role: "user", content: "Second phase" }),
		assistant([call("h", "gamma.txt")], 8, 1, 1), result("h"),
	];
	const output = metrics.output(entries as any, true, false);
	expect(output).toMatchObject({ toolNames: { read: 8 }, toolCalls: 8,
		phase1Coverage: { readFiles: 1, totalFiles: 3, partialReads: 3 },
		contextByTurn: [12, 29, 40, 10], contextPeak: 40 });
	for (const text of ["alpha.txt", "beta.txt", "gamma.txt", "PRIVATE_PATH", "PRIVATE_BODY", "/synthetic"]) {
		expect(JSON.stringify(output)).not.toContain(text);
	}
});
