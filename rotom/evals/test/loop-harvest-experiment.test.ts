/**
 * The default-model field comparison's two added guards: how much of the window actually ran on
 * the day's default, and whether a single long session decides an arm's rate.
 */
import { describe, expect, it } from "vitest";
import { defaultModelExperiment, dimensionRatesWithoutLargestSession, modelRatesWithoutLargestSession } from "../src/loop/harvest-models.ts";
import { versionLayerTables } from "../src/loop/harvest-report-layers.ts";
import type { SessionSummary } from "../src/loop/harvest.ts";

const astra = "openai-codex/gpt-6-astra";
const sol = "openai-codex/gpt-6.1-sol";
const modelSwitched = "qoder/dfmodel";

function session(overrides: Partial<SessionSummary> & { sessionId: string; startedAt: string }): SessionSummary {
	return {
		sessionFile: `/sessions/${overrides.sessionId}.jsonl`,
		project: "/w",
		userTurns: 1,
		assistantTurns: 1,
		toolCalls: 1,
		interrupts: 0,
		qualityInterrupts: 0,
		selfRetracts: 0,
		toolErrors: 0,
		providerErrors: 0,
		recoveredProviderErrors: 0,
		northStarV2: 0,
		models: [],
		modelTurns: {},
		...overrides,
	} as SessionSummary;
}

describe("default-model compliance", () => {
	it("counts every session with a known day default, including the ones that did not open on it", () => {
		const view = defaultModelExperiment([
			session({ sessionId: "opens-on-default", startedAt: "2026-11-11T09:00:00Z", firstAssistantModel: astra, models: [astra] }),
			session({ sessionId: "opens-elsewhere", startedAt: "2026-11-11T10:00:00Z", firstAssistantModel: modelSwitched, models: [modelSwitched] }),
			// No first assistant model: it cannot show that the default applied, so it stays in the
			// denominator instead of disappearing from the ratio.
			session({ sessionId: "no-first-model", startedAt: "2026-11-12T10:00:00Z" }),
			session({ sessionId: "unreadable-day", startedAt: "", firstAssistantModel: astra, models: [astra] }),
		]);
		expect(view.compliance).toEqual({ sessions: 3, onDefault: 1, rate: 0.333 });
		// The unreadable day stays visible instead of vanishing, but it cannot enter the ratio.
		expect(view.offDefault.map((row) => row.sessionId)).toEqual(["unreadable-day", "opens-elsewhere", "no-first-model"]);
	});

	it("reports no rate rather than zero when nothing in the window has a readable day", () => {
		const view = defaultModelExperiment([session({ sessionId: "odd", startedAt: "", firstAssistantModel: astra })]);
		expect(view.compliance).toEqual({ sessions: 0, onDefault: 0, rate: null });
		expect(view.offDefault.map((row) => row.sessionId)).toEqual(["odd"]);
		expect(view.groups.every((group) => group.sessions === 0 && group.v2Per100 === null)).toBe(true);
	});
});

describe("default-model sensitivity", () => {
	it("drops the single counted session that holds the most v2 events", () => {
		const view = defaultModelExperiment([
			session({ sessionId: "astra-quiet", startedAt: "2026-11-11T09:00:00Z", firstAssistantModel: astra, models: [astra], userTurns: 4, northStarV2: 0 }),
			session({ sessionId: "sol-long", startedAt: "2026-11-12T09:00:00Z", firstAssistantModel: sol, models: [sol], userTurns: 20, northStarV2: 5 }),
			session({ sessionId: "sol-quiet", startedAt: "2026-11-14T09:00:00Z", firstAssistantModel: sol, models: [sol], userTurns: 4, northStarV2: 0 }),
			// Not counted (switched away), so its v2 events must not be the dropped ones.
			session({ sessionId: "switched", startedAt: "2026-11-13T09:00:00Z", firstAssistantModel: astra, models: [astra, sol], userTurns: 30, northStarV2: 9 }),
		]);
		expect(view.groups.map((group) => [group.model, group.turns, group.v2, group.v2Per100])).toEqual([
			[astra, 4, 0, 0],
			[sol, 24, 5, 20.8],
		]);
		expect(view.sensitivity.droppedSessionId).toBe("sol-long");
		expect(view.sensitivity.groups.map((group) => [group.model, group.turns, group.v2, group.v2Per100])).toEqual([
			[astra, 4, 0, 0],
			[sol, 4, 0, 0],
		]);
	});

	it("drops nothing when the counted sessions carry no v2 events", () => {
		const view = defaultModelExperiment([
			session({ sessionId: "astra", startedAt: "2026-11-11T09:00:00Z", firstAssistantModel: astra, models: [astra], userTurns: 4 }),
		]);
		expect(view.sensitivity.droppedSessionId).toBeNull();
		expect(view.sensitivity.groups).toEqual(view.groups);
	});
});

describe("a rate without the session that carries it", () => {
	it("removes the model's own share of one session, not the whole session", () => {
		const rates = modelRatesWithoutLargestSession([
			session({ sessionId: "carrier", startedAt: "2026-11-11T09:00:00Z", userTurns: 10, northStarV2: 6, modelTurns: { [sol]: 8, [astra]: 2 }, v2Models: { [sol]: 4, [astra]: 2 } }),
			session({ sessionId: "quiet", startedAt: "2026-11-12T09:00:00Z", userTurns: 10, northStarV2: 0, modelTurns: { [sol]: 10 }, v2Models: { [sol]: 0 } }),
		]);
		// sol: 18 turns and 4 v2 events, the carrier holds all four of them.
		expect(rates.get(sol)).toEqual({ turns: 10, v2: 0, v2Per100: 0, droppedSessionId: "carrier" });
		// astra: 2 turns and 2 events, so nothing is left once its carrier goes.
		expect(rates.get(astra)).toEqual({ turns: 0, v2: 0, v2Per100: null, droppedSessionId: "carrier" });
	});

	it("groups a whole-session dimension by its own largest session", () => {
		const rates = dimensionRatesWithoutLargestSession([
			session({ sessionId: "big", startedAt: "2026-11-11T09:00:00Z", userTurns: 20, northStarV2: 5, productVersion: "0.1.27" }),
			session({ sessionId: "small", startedAt: "2026-11-12T09:00:00Z", userTurns: 20, northStarV2: 0, productVersion: "0.1.27" }),
			session({ sessionId: "other", startedAt: "2026-11-13T09:00:00Z", userTurns: 5, northStarV2: 0, productVersion: "0.1.26" }),
		], (item) => item.productVersion);
		expect(rates.get("0.1.27")).toEqual({ turns: 20, v2: 0, v2Per100: 0, droppedSessionId: "big" });
		// A version whose sessions carry no v2 events keeps its full rate and names no session.
		expect(rates.get("0.1.26")).toEqual({ turns: 5, v2: 0, v2Per100: 0, droppedSessionId: null });
	});

	it("keeps the product-version table's sensitivity column in the table's own shape", () => {
		const tables = versionLayerTables([
			session({ sessionId: "big", startedAt: "2026-11-11T09:00:00Z", userTurns: 20, northStarV2: 5, productVersion: "0.1.27" }),
			session({ sessionId: "quiet", startedAt: "2026-11-12T09:00:00Z", userTurns: 20, northStarV2: 0, productVersion: "0.1.27" }),
		]);
		const header = tables.find((line) => line.startsWith("| Product version"));
		const row = tables.find((line) => line.startsWith("| 0.1.27 |"));
		expect(header?.split("|").length).toBe(8);
		expect(row?.split("|").length).toBe(8);
		expect(row).toContain("0 (\`big\`)");
	});
});
