import { describe, expect, it } from "vitest";
import { buildWeekly, parseWeeklyConfig, providerSegments, renderWeekly, acceptanceRows as productionAcceptanceRows } from "../src/loop/weekly.ts";
import { providerCode, summarizeProviderErrors } from "../src/loop/harvest-provider.ts";
import { parseLedger, type LedgerEntry } from "../src/loop/ledger.ts";
import type { Incident, SessionSummary } from "../src/loop/harvest.ts";

const CONFIG = { switchAt: "2026-11-10T13:30:07Z" };
const ASTRA = "openai-codex/gpt-6-astra";
// These rate-test fixtures all run the same known build; ancestry boundaries have their own tests.
const acceptanceRows: typeof productionAcceptanceRows = (ledger, sessions, incidents, now) =>
	productionAcceptanceRows(ledger, sessions, incidents, now, (session, firstCommit) => session.buildCommit === firstCommit);

function fakeReport(overrides: Partial<ReturnType<typeof buildWeekly>>) {
	return {
		generatedAt: "2026-11-13T00:00:00Z",
		window: { since: "2026-10-13T00:00:00Z" },
		config: CONFIG,
		northStar: { overall: [], models: [], products: [], entries: [] },
		records: [],
		providerFailures: [],
		...overrides,
	} as ReturnType<typeof buildWeekly>;
}

it("renders the entry dimension next to the product version", () => {
	const report = fakeReport({
		northStar: {
			overall: [],
			models: [],
			products: [],
			entries: [{ key: "dev-checkout", turns: 40, v2: 2, v2Per100: 5, interval: { low: 0.6, high: 18 }, sensitivity: { v2Per100: 5, droppedSessionId: null } }],
		} as ReturnType<typeof buildWeekly>["northStar"],
	});
	const text = renderWeekly(report);
	expect(text).toContain("### Entry");
	expect(text).toContain("dev-checkout");
});

it("labels the per-model split as observed data, not a comparison", () => {
	const report = fakeReport({
		northStar: {
			overall: [],
			models: [{ key: ASTRA, turns: 40, v2: 2, v2Per100: 5, sensitivity: { v2Per100: null, droppedSessionId: null } }],
			products: [],
			entries: [],
		} as ReturnType<typeof buildWeekly>["northStar"],
	});
	const text = renderWeekly(report);
	const section = text.slice(text.indexOf("### Per model"), text.indexOf("### Per product version"));
	expect(section).toContain("Selection bias is not excluded");
	expect(section).toContain(`| ${ASTRA} |`);
	// The field comparison is cancelled: no section may claim a default-model verdict.
	expect(text).not.toContain("Field comparison");
});
const SOL = "openai-codex/gpt-6.1-sol";

function session(overrides: Partial<SessionSummary> & { startedAt: string }): SessionSummary {
	return {
		sessionId: overrides.sessionId ?? `s-${overrides.startedAt}`,
		sessionFile: `/sessions/${overrides.startedAt}.jsonl`,
		cwd: "/repo",
		startedAtSource: "header",
		buildCommit: "a".repeat(40),
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
	...(overrides.acceptance ? { acceptance: { firstCommit: "a".repeat(40), ...overrides.acceptance } } : {}),
});

describe("weekly report", () => {
	it("reports a record's own metric only from sessions after its acceptance start", () => {
		// 1.0 per 100 → exposure 1,000 turns (the rate predicts ten events there).
		const entry = ledgerEntry({
			acceptance: { startedAt: "2026-11-10T13:30:07Z", metric: "provider_error where category=429", incident: "provider_error", detail: ["category", "429"], baselinePer100: 1, minimumTurns: 1000, expect: "lower" },
		});
		const before = [session({ startedAt: "2026-11-09T09:00:00+08:00", userTurns: 1000 })];
		const incidentsBefore = [{ kind: "provider_error", timestamp: "2026-11-09T10:00:00+08:00", detail: { category: "429" } }] as unknown as Incident[];
		expect(acceptanceRows([entry], before, incidentsBefore, new Date("2026-11-12T00:00:00Z"))[0]).toMatchObject({ status: "insufficient-exposure", turns: 0 });

		const after = [session({ startedAt: "2026-11-12T09:00:00+08:00", userTurns: 2000 })];
		const failed = Array.from({ length: 40 }, (_, index) => ({ kind: "provider_error", sessionId: after[0].sessionId, timestamp: `2026-11-12T1${index % 10}:00:00+08:00`, detail: { category: "429" } })) as unknown as Incident[];
		// 40 failures over 2,000 turns = 2.0 per 100, above the 1.0 baseline with 20 expected.
		expect(acceptanceRows([entry], after, failed, new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "worse", turns: 2000, observedPer100: 2 });
		expect(acceptanceRows([entry], after, [], new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "improved", observedPer100: 0 });
	});

	it("refuses a verdict below exposure even when the period has zero events", () => {
		// The round-7 trap: a 0.19 baseline over 300 turns predicts 0.6 events, so zero events is
		// what the baseline itself predicts. It must not read as "improved" or "no change".
		const entry = ledgerEntry({
			acceptance: { startedAt: "2026-11-10T13:30:07Z", metric: "compaction_failed", incident: "compaction_failed", baselinePer100: 0.19, minimumTurns: 5236, expect: "lower" },
		});
		const after = [session({ startedAt: "2026-11-12T09:00:00+08:00", userTurns: 300 })];
		const rows = acceptanceRows([entry], after, [], new Date("2026-11-13T00:00:00Z"));
		expect(rows[0]).toMatchObject({ status: "insufficient-exposure", turns: 300, minimumTurns: 5236 });
		// 300 turns in the last week is 42.9 turns/day, so the missing 4,936 turns is 116 days.
		expect(rows[0]?.daysToExposure).toBe(116);
		expect(renderWeekly(fakeReport({ records: rows }))).toContain("insufficient-exposure");
		expect(renderWeekly(fakeReport({ records: rows }))).not.toContain("| improved |");
	});

	it("calls a change only when the exact rate test clears alpha", () => {
		const entry = ledgerEntry({
			acceptance: { startedAt: "2026-11-10T13:30:07Z", metric: "m", incident: "compaction_failed", baselinePer100: 1, minimumTurns: 1000, expect: "lower" },
		});
		const after = [session({ startedAt: "2026-11-12T09:00:00+08:00", userTurns: 3000 })];
		const events = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: "compaction_failed", sessionId: after[0].sessionId, timestamp: `2026-11-12T1${index % 10}:00:00+08:00`, detail: {} })) as unknown as Incident[];
		// 30 events against 30 expected: no difference shown, and the note says only that.
		const flat = acceptanceRows([entry], after, events(30), new Date("2026-11-13T00:00:00Z"))[0];
		expect(flat).toMatchObject({ status: "no-change" });
		expect(flat?.note).toContain("one-sided exact Poisson");
		// 15 against 30 expected → p ≈ 0.0026, improved.
		expect(acceptanceRows([entry], after, events(15), new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "improved" });
		// 50 against 30 expected → p ≈ 0.0005 on the other tail, worse.
		expect(acceptanceRows([entry], after, events(50), new Date("2026-11-13T00:00:00Z"))[0]).toMatchObject({ status: "worse" });
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
			{ kind: "provider_error", sessionId: "old", timestamp: "2026-11-11T10:00:00+08:00", detail: { provider: "qoder" } },
			{ kind: "provider_error", sessionId: "old", timestamp: "2026-11-09T11:00:00+08:00", detail: { provider: "qoder", recovered: true } },
			{ kind: "provider_error", sessionId: "new", timestamp: "2026-11-11T10:00:00+08:00", detail: { provider: "qoder" } },
		] as unknown as Incident[];
		const rows = providerSegments(sessions, incidents, CONFIG.switchAt);
		expect(rows.find((row) => row.segment === "before")).toMatchObject({ provider: "qoder", turns: 100, failures: 1, per100: 1 });
		expect(rows.find((row) => row.segment === "after")).toMatchObject({ provider: "qoder", turns: 100, failures: 1, per100: 1 });
	});

	it("counts the same user-visible failures as the harvest provider table", () => {
		// One fixture, two readers: whatever the harvest calls "reached the user", the weekly
		// provider segment must count too. This is the round-7 bug: the flag means recovered.
		const sessions = [
			session({ sessionId: "a", startedAt: "2026-11-09T09:00:00+08:00", userTurns: 100, modelTurns: { "openai-codex/gpt-6.1-sol": 60, "qoder/dfmodel": 40 } }),
			session({ sessionId: "b", startedAt: "2026-11-09T10:00:00+08:00", userTurns: 50, modelTurns: { "openai-codex/gpt-6.1-sol": 50 } }),
		];
		const detail = (provider: string, category: string, recovered?: boolean) => ({ provider, model: "m", category, attempts: 1, ...(recovered ? { recovered: true } : {}) });
		const incidents = [
			{ kind: "provider_error", sessionId: "a", timestamp: "2026-11-09T09:10:00+08:00", detail: detail("openai-codex", "network", true) },
			{ kind: "provider_error", sessionId: "a", timestamp: "2026-11-09T09:11:00+08:00", detail: detail("openai-codex", "network", true) },
			{ kind: "provider_error", sessionId: "b", timestamp: "2026-11-09T09:12:00+08:00", detail: detail("openai-codex", "http") },
			{ kind: "provider_error", sessionId: "a", timestamp: "2026-11-09T09:13:00+08:00", detail: detail("qoder", "timeout") },
		] as unknown as Incident[];
		const harvest = summarizeProviderErrors(incidents);
		const weekly = providerSegments(sessions, incidents, CONFIG.switchAt);
		const weeklyVisible = weekly.reduce((sum, row) => sum + row.failures, 0);
		expect(harvest.userVisible).toBe(2);
		expect(harvest.total - harvest.recovered).toBe(2);
		expect(weeklyVisible).toBe(harvest.userVisible);
		expect(weekly.filter((row) => row.provider === "openai-codex").reduce((sum, row) => sum + row.failures, 0)).toBe(1);
	});

	it("keeps the provider's own code even when a trace supplied the bucket", () => {
		// The catalog metric filters on the code: the bucket alone would miss every such failure.
		expect(providerCode("Qoder: catalog_refresh_failed")).toBe("qoder:catalog_refresh_failed");
		expect(providerCode("connection refused")).toBeUndefined();
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
		expect(() => parseWeeklyConfig(JSON.stringify({ switchAt: "x" }))).toThrow(/switchAt/u);
		expect(parseWeeklyConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
	});

	it("rejects an acceptance spec the weekly report could not read", () => {
		// baselinePer100 1 implies minimumTurns 1000, so each case below varies one field at a time.
		const base = { startedAt: CONFIG.switchAt, metric: "m", incident: "provider_error", baselinePer100: 1, minimumTurns: 1000, expect: "lower" };
		const round = (acceptance: unknown) => JSON.stringify([ledgerEntry({ acceptance: acceptance as LedgerEntry["acceptance"] })]);
		expect(() => parseLedger(round({ ...base, incident: "not-a-kind" }))).toThrow(/acceptance.incident/u);
		expect(() => parseLedger(round({ ...base, minimumTurns: 0 }))).toThrow(/minimumTurns/u);
		// Exposure is pre-registered: a record must declare exactly the turns its baseline implies.
		expect(() => parseLedger(round({ ...base, minimumTurns: 300 }))).toThrow(/implied by baselinePer100/u);
		expect(() => parseLedger(round({ ...base, baselinePer100: 0, minimumTurns: 300 }))).toThrow(/positive number/u);
		expect(() => parseLedger(round({ ...base, expect: "sideways" }))).toThrow(/expect/u);
		expect(() => parseLedger(round({ ...base, detail: ["category"] }))).toThrow(/detail/u);
		expect(parseLedger(round(base))[0]?.acceptance?.metric).toBe("m");
	});
});
