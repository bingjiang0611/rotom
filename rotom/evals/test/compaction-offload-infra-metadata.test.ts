import { expect, it, vi } from "vitest";
import { createReplayHarness, REPLAY_TASKS } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import { createReplayMetrics, OFFLOAD_ENTRY } from "../src/compaction-offload-metrics.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const message = (message: object) => ({ type: "message", message });
const recall = (id: string, observation: string) => message({ role: "assistant", stopReason: "toolUse", usage,
	content: [{ type: "toolCall", id, name: "obs_recall", arguments: { id: observation, privateArgument: "PRIVATE_ARGUMENT" } }] });
const result = (id: string, isError: boolean) => message({ role: "toolResult", toolName: "obs_recall", toolCallId: id, isError,
	content: [{ type: "text", text: "PRIVATE_RESULT" }] });
const offload = (id: string) => ({ type: "custom", customType: OFFLOAD_ENTRY, data: { observationIds: [id], toolCallIds: ["PRIVATE_TOOL_ID"] } });

it("attributes recalls to their preceding offload records and matches result errors without retaining IDs or bodies", () => {
	const entries = [recall("before", "PRIVATE_SECOND"), result("before", false),
		offload("PRIVATE_FIRST"), offload("PRIVATE_SECOND"),
		recall("first", "PRIVATE_FIRST"), result("first", false),
		recall("second", "PRIVATE_SECOND"), result("second", true),
		recall("unknown", "PRIVATE_UNKNOWN"), result("unknown", false),
		recall("interrupted", "PRIVATE_FIRST")];
	const metrics = createReplayMetrics().output(entries as any, true, false);
	expect(metrics.recalls).toEqual([
		{ turn: 1, offloaded: false, offloadIndex: null, resultError: false },
		{ turn: 2, offloaded: true, offloadIndex: 1, resultError: false },
		{ turn: 3, offloaded: true, offloadIndex: 2, resultError: true },
		{ turn: 4, offloaded: false, offloadIndex: null, resultError: false },
		{ turn: 5, offloaded: true, offloadIndex: 1, resultError: null },
	]);
	expect(metrics).toMatchObject({ obsRecallCalls: 5, recalledOffloaded: 3, offloadedResults: 2 });
	expect(JSON.stringify(metrics)).not.toContain("PRIVATE_");
});

it("real product faux recalls each of two offload batches and records an unknown-ID error", async () => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in faux"); }));
	try {
		const task = REPLAY_TASKS[0]!;
		const observed: FauxObservation = { requests: [], config: null, agentDirMatches: false, summaryCalls: 0 };
		const result = await createReplayHarness(task, true, { model: FAUX_MODEL,
			modelRuntimeFactory: replayFaux(task, observed, false, undefined, { batchSize: 10, recallBatches: true }) }).run(task.scenario, { artifacts: {}, setArtifact() {} });
		expect(result.output).toMatchObject({ correct: true, deferred: 2, coverageNudges: 0 });
		expect(result.output.recalls.map(({ turn, ...recall }) => recall)).toEqual([
			{ offloaded: true, offloadIndex: 1, resultError: false },
			{ offloaded: true, offloadIndex: 2, resultError: false },
			{ offloaded: false, offloadIndex: null, resultError: true },
		]);
		expect(fetch).not.toHaveBeenCalled();
	} finally { vi.unstubAllGlobals(); }
}, 90_000);

it.each([
	["request timed out PRIVATE_ERROR", "timeout"],
	["fetch failed ECONNRESET PRIVATE_ERROR", "connection"],
	["HTTP 429 PRIVATE_ERROR", "rate_limit"],
	["HTTP 401 PRIVATE_ERROR", "http_4xx"],
	["status: 503 PRIVATE_ERROR", "http_5xx"],
	["403 Forbidden PRIVATE_ERROR", "http_4xx"],
	["502 Bad Gateway PRIVATE_ERROR", "http_5xx"],
	["Replay stream failed; usage is unknown PRIVATE_ERROR", "stream_terminated"],
	["terminated PRIVATE_ERROR", "stream_terminated"],
	["unrecognized PRIVATE_ERROR", "other"],
])("classifies %s without exporting the text", (errorMessage, category) => {
	const metrics = createReplayMetrics().output([
		message({ role: "assistant", stopReason: "error", content: [], usage, errorMessage }),
		message({ role: "assistant", stopReason: "aborted", content: [], usage, errorMessage }),
	] as any, false, false);
	expect(metrics.errors).toEqual([{ turn: 1, stopReason: "error", category }, { turn: 2, stopReason: "aborted", category }]);
	expect(metrics.usageComplete).toBe(false);
	expect(JSON.stringify(metrics)).not.toContain("PRIVATE_ERROR");
	expect(JSON.stringify(metrics)).not.toContain(errorMessage);
});
