import { describe, expect, it } from "vitest";
import { buildWeekly, blindedExperiment, parseWeeklyConfig, providerSegments, renderWeekly, acceptanceRows } from "../src/loop/weekly.ts";
import { parseLedger, type LedgerEntry } from "../src/loop/ledger.ts";
import type { Incident, SessionSummary } from "../src/loop/harvest.ts";

const CONFIG = { switchAt: "2026-11-10T13:30:07Z", experiment: { start: "2026-11-11", end: "2026-12-08" } };
const ASTRA = "openai-codex/gpt-6-astra";
const SOL = "openai-codex/gpt-6.1-sol";

function session(overrides: Partial<SessionSummary> & { startedAt: string }): SessionSummary {
	return {
		sessionId: overrides.sessionId ?? `s-${overrides.startedAt}`,
		sessionFile: `/sessions/${overrides.startedAt}.jsonl`,
		cwd: "/repo",
		startedAtSource: "header",
		modelTurns: {},
		models: [],
		userTurns: 10,
		assistantMessages: 10,
		toolCalls: 10,
		toolErrors: 0,
		interventions: 0,
		interruptExcluded: 0,
		interventionModels: {},
		northStarV2: 0,
		v2Models: {},
		interruptTriage: { "self-retract": 0, quality: 0, other: 0 },
		failures: 0,
		incidentCounts: {},
		...overrides,
	};
}

const ledgerEntry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
	schema: "rotom-loop-ledger/v1",
	id: "L-2026-11-10-x",
	date: "2026-11-10",
	title: "x",
	hypothesis: "x",
	change: "mechanism",
	measurement: "x",
	result: "x",
	evidence: "unmeasured",
	decision: "shipped",
	source: "rotom/evals/src/loop/weekly.ts",
	...overrides,
});

describe("weekly report", () => {
	it("keeps outcome metrics out of an in-window report", () => {
		// Each arm carries a distinctive v2 count; neither may appear in the blinded section.
		const sessions = [
			session({ startedAt: "2026-11-12T09:00:00+08:00", firstAssistantModel: SOL, models: [SOL], modelTurns: { [SOL]: 10 }, userTurns: 10, northStarV2: 7 }),
			session({ startedAt: "2026-11-13T09:00:00+08:00", firstAssistantModel: ASTRA, models: [ASTRA], modelTurns: { [ASTRA]: 10 }, userTurns: 10, northStarV2: 3 }),
		];
		const report = buildWeekly({ sessions, incidents: [], ledger: [], config: CONFIG, since: "2026-10-13T00:00:00Z", now: new Date("2026-11-14T00:00:00Z") });
		expect(report.experiment.state).toBe("open");
		const text = renderWeekly(report);
		const blinded = text.slice(text.indexOf("## Field comparison"), text.indexOf("## Shipped records"));
		expect(blinded).toContain(SOL);
		expect(blinded).toContain(ASTRA);
		expect(blinded).not.toContain("v2");
		expect(blinded).not.toMatch(/per 100/u);
		// The counts are the only numbers per arm: one session each, adherence 100% and 100%.
		expect(report.experiment.arms.map((arm) => [arm.arm, arm.sessions, arm.adherence])).toEqual([[ASTRA, 1, 1], [SOL, 1, 1]]);
	});

	it("counts adherence against the sessions whose day default is known, not against all sessions", () => {
		const sessions = [
			session({ startedAt: "2026-11-12T09:00:00+08:00", firstAssistantModel: SOL, models: [SOL] }),
			session({ startedAt: "2026-11-13T09:00:00+08:00", firstAssistantModel: SOL, models: [SOL] }),
			session({ startedAt: "2026-11-14T09:00:00+08:00" }),
		];
		const experiment = blindedExperiment(sessions, CONFIG.experiment, new Date("2026-11-15T00:00:00Z"));
		expect(experiment.arms.find((arm) => arm.arm === ASTRA)).toMatchObject({ sessions: 0, adherence: 0 });
		// The third session fell on an even day but recorded no first model, so it counts as eligible and off-default.
		expect(experiment.arms.find((arm) => arm.arm === SOL)).toMatchObject({ sessions: 1, adherence: 0.5 });
		expect(experiment.excluded.offDefault).toBe(2);
	});

	it("closes the window after its last day and says the verdict comes from the ledger", () => {
		const report = buildWeekly({ sessions: [], incidents: [], ledger: [], config: CONFIG, since: "2026-10-13T00:00:00Z", now: new Date("2026-12-09T00:00:00Z") });
		expect(report.experiment.state).toBe("closed");
		expect(renderWeekly(report)).toContain("The window closed");
	});

	it("reports a record's own metric only from sessions after its acceptance start", () => {
		const entry = ledgerEntry({
			acceptance: { startedAt: "2026-11-10T13:30:07Z", metric: "provider_error where category=429", incident: "provider_error", detail: ["category", "429"], baselinePer100: 0.14, minimumTurns: 300, expect: "lower" },
		});
		const before = [session({ startedAt: "2026-11-09T09:00:00+08:00", userTurns: 1000 })];
		const incidentsBefore = [{ kind: "provider_error", timestamp: "2026-11-09T10:00:00+08:00", detail: { category: "429" } }] as unknown as Incident[];
		expect(acceptanceRows([entry], before, incidentsBefore, new Date("2026-11-12T00:00:00Z"))[0]).toMatchObject({ status: "not-yet-due", turns: 0 });

		const after = [session({ startedAt: "2026-11-12T09:00:00+08:00", userTurns: 400 })];
		const failed = Array.from({ length: 12 }, (_, index) => ({ kind: "provider_error", timestamp: `2026-11-12T1${index % 10}:00:00+08:00`, detail: { category: "429" } })) as unknown as Incident[];
		// 12 failures over 400 turns = 3.0 per 100, far above the 0.14 baseline.
		expect(acceptanceRows([entry], after, failed, new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "worse", turns: 400, observedPer100: 3 });
		const clean = after.map((item) => ({ ...item }));
		expect(acceptanceRows([entry], clean, [], new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "improved", observedPer100: 0 });
	});

	it("says so when a shipped record has no harvest-measurable metric", () => {
		const rows = acceptanceRows([ledgerEntry({ id: "L-2026-11-10-y" })], [], [], new Date("2026-11-12T00:00:00Z"));
		expect(rows[0]).toMatchObject({ status: "no-metric", metric: null });
	});

	it("splits provider failures by the switch instant and counts only user-visible ones", () => {
		const sessions = [
			session({ sessionId: "old", startedAt: "2026-11-09T09:00:00+08:00", userTurns: 100, modelTurns: { "qoder/dfmodel": 100 } }),
			session({ sessionId: "new", startedAt: "2026-11-11T09:00:00+08:00", userTurns: 100, modelTurns: { "qoder/dfmodel": 100 } }),
		];
		// A failure in a session that started before the switch stays in the before segment, even
		// when its own timestamp is later.
		const incidents = [
			{ kind: "provider_error", sessionId: "old", timestamp: "2026-11-11T10:00:00+08:00", detail: { provider: "qoder", final: true } },
			{ kind: "provider_error", sessionId: "old", timestamp: "2026-11-09T11:00:00+08:00", detail: { provider: "qoder", final: false } },
			{ kind: "provider_error", sessionId: "new", timestamp: "2026-11-11T10:00:00+08:00", detail: { provider: "qoder", final: true } },
		] as unknown as Incident[];
		const rows = providerSegments(sessions, incidents, CONFIG.switchAt);
		expect(rows.find((row) => row.segment === "before")).toMatchObject({ provider: "qoder", turns: 100, failures: 1, per100: 1 });
		expect(rows.find((row) => row.segment === "after")).toMatchObject({ provider: "qoder", turns: 100, failures: 1, per100: 1 });
	});

	it("prints the sensitivity column next to every north-star row", () => {
		// One long session carries most of the overall rate; dropping it must change the number.
		const sessions = [
			session({ startedAt: "2026-10-30T09:00:00+08:00", userTurns: 300, northStarV2: 30, productVersion: "0.1.27-main.a", models: [SOL], modelTurns: { [SOL]: 300 }, interventionModels: { [SOL]: 30 }, v2Models: { [SOL]: 30 }, interventions: 30 }),
			session({ startedAt: "2026-11-01T09:00:00+08:00", userTurns: 10, northStarV2: 0, productVersion: "0.1.27-main.a", models: [ASTRA], modelTurns: { [ASTRA]: 10 } }),
		];
		const report = buildWeekly({ sessions, incidents: [], ledger: [], config: CONFIG, since: "2026-10-01T00:00:00Z", now: new Date("2026-11-12T00:00:00Z") });
		expect(report.northStar.overall[0]).toMatchObject({ turns: 310, v2: 30, v2Per100: 9.7 });
		expect(report.northStar.overall[0]?.sensitivity).toMatchObject({ v2Per100: 0 });
		const text = renderWeekly(report);
		expect(text).toContain("without its largest session");
		expect(text).toContain("| 0.1.27-main.a |");
	});

	it("validates the committed window config", () => {
		expect(() => parseWeeklyConfig("{}")).toThrow(/switchAt/u);
		expect(() => parseWeeklyConfig(JSON.stringify({ switchAt: "x", experiment: CONFIG.experiment }))).toThrow(/switchAt/u);
		expect(() => parseWeeklyConfig(JSON.stringify({ switchAt: CONFIG.switchAt, experiment: { start: "2026-12-09", end: "2026-12-08" } }))).toThrow(/before/u);
		expect(parseWeeklyConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
	});

	it("rejects an acceptance spec the weekly report could not read", () => {
		const base = { startedAt: CONFIG.switchAt, metric: "m", incident: "provider_error", baselinePer100: 1, minimumTurns: 10, expect: "lower" };
		const round = (acceptance: unknown) => JSON.stringify([ledgerEntry({ acceptance: acceptance as LedgerEntry["acceptance"] })]);
		expect(() => parseLedger(round({ ...base, incident: "not-a-kind" }))).toThrow(/acceptance.incident/u);
		expect(() => parseLedger(round({ ...base, minimumTurns: 0 }))).toThrow(/minimumTurns/u);
		expect(() => parseLedger(round({ ...base, expect: "sideways" }))).toThrow(/expect/u);
		expect(() => parseLedger(round({ ...base, detail: ["category"] }))).toThrow(/detail/u);
		expect(parseLedger(round(base))[0]?.acceptance?.metric).toBe("m");
	});
});
