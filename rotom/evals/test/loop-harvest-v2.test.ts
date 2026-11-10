/**
 * The north-star v2 split (self-retract / quality / other), the model that was answering each
 * interrupt, the runtime stratification and the per-model rate.
 */
import { describe, expect, it } from "vitest";
import { analyzeSession, interruptTriage, runtimeVersionOf, type SessionSummary } from "../src/loop/harvest.ts";
import { dimensionRates, modelDimensionRates, modelSwitchTables, modelTurnShare, northStarWeeks, poissonRateInterval, triageTable } from "../src/loop/harvest-breakdown.ts";

let counter = 0;
type Line = Record<string, unknown>;
type Step = { type: string; fields?: Record<string, unknown>; message?: Record<string, unknown>; timestamp: string };

function chain(steps: Step[]): Line[] {
	let parentId: string | null = null;
	return steps.map((step) => {
		const id = `e${++counter}`;
		const entry: Line = { type: step.type, id, parentId, timestamp: step.timestamp, ...(step.message ? { message: step.message } : {}), ...(step.fields ?? {}) };
		parentId = id;
		return entry;
	});
}

const message = (body: Record<string, unknown>, timestamp: string): Step => ({ type: "message", message: body, timestamp });
const sessionHeader = { type: "session", version: 3, id: "s-1", timestamp: "2026-11-03T10:00:00.000Z", cwd: "/w" };

function analyze(header: Record<string, unknown> | undefined, lines: Line[]) {
	const head = header === undefined ? [] : [JSON.stringify(header)];
	const analyzed = analyzeSession([...head, ...lines.map((line) => JSON.stringify(line))], { sessionFile: "/s.jsonl", excerpts: false });
	if (!analyzed) throw new Error("not a session");
	return analyzed;
}

describe("north star v2", () => {
	it("separates a self-retract from a quality interrupt", () => {
		// Under two seconds of silence is the person retracting; the same wait without a byte
		// past ten seconds is a judgement, and anything with output is already quality.
		expect(interruptTriage("waiting-first-byte", 900)).toBe("self-retract");
		expect(interruptTriage("waiting-first-byte", 2_000)).toBe("other");
		expect(interruptTriage("waiting-first-byte", 12_000)).toBe("quality");
		expect(interruptTriage("streaming-thinking", 4_000)).toBe("other");
		expect(interruptTriage("streaming-thinking", 11_000)).toBe("quality");
		expect(interruptTriage("streaming-text", 300)).toBe("quality");
		expect(interruptTriage("streaming-tool-call", 300)).toBe("quality");
		expect(interruptTriage("tool-executing", 100)).toBe("quality");
		// No measured wait cannot be a self-retract, and cannot be quality by duration either.
		expect(interruptTriage("waiting-first-byte", undefined)).toBe("other");
	});

	it("counts v2 as corrections, repeats, bare continues and quality interrupts", () => {
		const { session, incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "aborted", durationMs: 900, timestamp: 0 }, "2026-11-03T10:00:00.900Z"),
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:01:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "toolUse", provider: "qoder", model: "dfmodel", timestamp: 0 }, "2026-11-03T10:01:30.000Z"),
			message({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse", provider: "qoder", model: "dfmodel", timestamp: 0 }, "2026-11-03T10:01:31.000Z"),
			message({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "Command aborted" }], isError: true, timestamp: 0 }, "2026-11-03T10:01:39.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "aborted", timestamp: 0 }, "2026-11-03T10:01:39.100Z"),
			message({ role: "user", content: "不对，你没跑测试", timestamp: 0 }, "2026-11-03T10:02:00.000Z"),
		]));
		const interrupts = incidents.filter((incident) => incident.kind === "user_interrupt");
		expect(interrupts.map((incident) => incident.detail.triage)).toEqual(["self-retract", "quality"]);
		expect(session.interruptTriage).toEqual({ "self-retract": 1, quality: 1, other: 0 });
		// v1 counts both interrupts plus the correction; v2 drops the self-retract.
		expect(session.interventions).toBe(3);
		expect(session.northStarV2).toBe(2);
		expect(session.v2Models).toEqual({ "qoder/dfmodel": 2 });
		expect(triageTable(incidents)).toEqual([{ triage: "quality", count: 1 }, { triage: "self-retract", count: 1 }]);
	});
});

describe("model attribution and runtime", () => {
	it("names the model that was running when the user interrupted, and a switch that follows", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "先看" }], stopReason: "aborted", provider: "openai-codex", model: "gpt-6.1-sol", errorMessage: "aborted", durationMs: 12_000, timestamp: 0 }, "2026-11-03T10:00:12.000Z"),
			{ type: "model_change", fields: { provider: "qoder", modelId: "dfmodel" }, timestamp: "2026-11-03T10:00:20.000Z" },
			message({ role: "user", content: "继续", timestamp: 0 }, "2026-11-03T10:00:30.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail).toMatchObject({ model: "openai-codex/gpt-6.1-sol", modelSwitchAfter: "qoder/dfmodel", triage: "quality" });
		const switches = modelSwitchTables(incidents);
		expect(switches.total).toBe(1);
		expect(switches.byModel).toEqual([{ model: "openai-codex/gpt-6.1-sol", count: 1 }]);
		expect(switches.byDuration).toEqual([{ duration: "10-30s", count: 1 }]);
	});

	it("does not call a re-written model entry a switch", () => {
		// Pi writes `model_change` after an abort even when the model is unchanged, so an entry
		// that names the same model is not evidence that the person moved.
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "aborted", durationMs: 900, timestamp: 0 }, "2026-11-03T10:00:00.900Z"),
			{ type: "model_change", fields: { provider: "qoder", modelId: "dfmodel" }, timestamp: "2026-11-03T10:00:05.000Z" },
			message({ role: "user", content: "继续", timestamp: 0 }, "2026-11-03T10:00:20.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail.modelSwitchAfter).toBeUndefined();
		expect(interrupt?.detail.modelSwitchUnattributed).toBeUndefined();
		expect(modelSwitchTables(incidents).total).toBe(0);
	});

	it("keeps a switch it can see but cannot attribute to a before-model", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "aborted", durationMs: 900 }, "2026-11-03T10:00:01.000Z"),
			{ type: "model_change", fields: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, timestamp: "2026-11-03T10:00:05.000Z" },
			message({ role: "user", content: "继续", timestamp: 0 }, "2026-11-03T10:00:20.000Z"),
		]));
		const interrupt = incidents.find((incident) => incident.kind === "user_interrupt");
		expect(interrupt?.detail.modelSwitchAfter).toBeUndefined();
		expect(interrupt?.detail.modelSwitchUnattributed).toBe("openai-codex/gpt-6.1-sol");
		expect(modelSwitchTables(incidents)).toMatchObject({ total: 0, unattributed: 1 });
	});

	it("does not count a switch the person made after sending the next message", () => {
		const { incidents } = analyze(sessionHeader, chain([
			message({ role: "user", content: "把 parser 的 bug 修了", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [], stopReason: "aborted", provider: "qoder", model: "dfmodel", errorMessage: "aborted", durationMs: 900, timestamp: 0 }, "2026-11-03T10:00:00.900Z"),
			message({ role: "user", content: "换个模型再来", timestamp: 0 }, "2026-11-03T10:00:30.000Z"),
			{ type: "model_change", fields: { provider: "openai-codex", modelId: "gpt-5.6-sol" }, timestamp: "2026-11-03T10:00:31.000Z" },
		]));
		expect(incidents.find((incident) => incident.kind === "user_interrupt")?.detail.modelSwitchAfter).toBeUndefined();
		expect(modelSwitchTables(incidents).total).toBe(0);
	});

	it("reads the runtime version out of the trace and groups sessions by it", () => {
		const span = (version: string) => JSON.stringify({ schema: "rotom-local-trace/v1", kind: "span_start", name: "pi.session.runtime", spanId: "s", timestamp: "2026-11-03T10:00:00.000Z", attributes: { "pi.runtime.version": version } });
		expect(runtimeVersionOf([span("1.4.0-rotom.3")])).toBe("1.4.0-rotom.3");
		expect(runtimeVersionOf(["not json", span("1.4.0-rotom.2")])).toBe("1.4.0-rotom.2");
		expect(runtimeVersionOf(undefined)).toBeUndefined();
		const lines = chain([
			message({ role: "user", content: "修 bug", timestamp: 0 }, "2026-11-03T10:00:00.000Z"),
			message({ role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop", provider: "qoder", model: "dfmodel", timestamp: 0 }, "2026-11-03T10:00:05.000Z"),
		]).map((line) => JSON.stringify(line));
		const analyzed = analyzeSession([JSON.stringify(sessionHeader), ...lines], { sessionFile: "/s.jsonl", excerpts: false, traceLines: [span("1.4.0-rotom.3")] });
		expect(analyzed?.session.runtimeVersion).toBe("1.4.0-rotom.3");
		const sessions = [analyzed!.session, { ...analyzed!.session, sessionId: "s-2", runtimeVersion: undefined, northStarV2: 2 }];
		expect(dimensionRates(sessions, (session) => session.runtimeVersion).map((row) => [row.key, row.turns, row.northStarV2])).toEqual([["1.4.0-rotom.3", 1, 0], ["unknown", 1, 2]]);
	});
});

describe("per-model rate and turn share", () => {
	const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
		sessionId: "s", sessionFile: "", cwd: "", startedAt: "2026-11-03T10:00:00.000Z", startedAtSource: "header",
		modelTurns: {}, interventionModels: {}, v2Models: {}, northStarV2: 0,
		interruptTriage: { "self-retract": 0, quality: 0, other: 0 }, interruptExcluded: 0,
		models: [], userTurns: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 0, failures: 0, incidentCounts: {},
		...overrides,
	});

	it("divides each model's v2 count by that model's own turns, not the session total", () => {
		const rows = modelDimensionRates([
			session({ modelTurns: { "qoder/dfmodel": 8, "openai-codex/gpt-6.1-sol": 2 }, interventionModels: { "qoder/dfmodel": 1 }, v2Models: { "qoder/dfmodel": 1 } }),
			session({ modelTurns: { "qoder/dfmodel": 2 }, v2Models: { "qoder/dfmodel": 1 } }),
		]);
		expect(rows).toEqual([
			expect.objectContaining({ key: "qoder/dfmodel", turns: 10, interventions: 1, northStarV2: 2, v2Per100: 20 }),
			expect.objectContaining({ key: "openai-codex/gpt-6.1-sol", turns: 2, northStarV2: 0, v2Per100: 0 }),
		]);
	});

	it("sums the turn share across every session", () => {
		expect(modelTurnShare([
			session({ modelTurns: { "qoder/dfmodel": 3, "cc-switch/claude-opus-5-5": 1 } }),
			session({ modelTurns: { "qoder/dfmodel": 5 }, interruptions: 0 } as Partial<SessionSummary>),
		])).toEqual([
			{ model: "qoder/dfmodel", turns: 8, share: 88.9 },
			{ model: "cc-switch/claude-opus-5-5", turns: 1, share: 11.1 },
		]);
	});
});

describe("north star v1 and v2 by week", () => {
	it("keeps both numerators and their bands", () => {
		const rows = northStarWeeks([
			{ sessionId: "a", sessionFile: "", cwd: "", startedAt: "2026-11-03T00:00:00Z", startedAtSource: "header", modelTurns: {}, interventionModels: {}, v2Models: {}, interruptTriage: { "self-retract": 0, quality: 0, other: 0 }, interruptExcluded: 0, models: [], userTurns: 20, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 4, northStarV2: 1, failures: 0, incidentCounts: {} },
		], () => "2026-W45");
		expect(rows).toEqual([expect.objectContaining({ week: "2026-W45", turns: 20, v1: 4, v1Per100: 20, v2: 1, v2Per100: 5 })]);
		expect(rows[0].v2Interval).toEqual(poissonRateInterval(1, 20));
	});
});
