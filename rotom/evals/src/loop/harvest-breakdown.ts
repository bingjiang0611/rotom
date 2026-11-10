/**
 * Harvest aggregation: the tables in `report.md` that need more than a per-session count.
 * Pure functions over `SessionSummary` and `Incident`, so the numbers can be tested without
 * touching a real sessions directory. Categories only; no message text leaves the caller.
 */
import type { Incident, SessionSummary } from "./harvest.ts";

export type RateInterval = { low: number; high: number };

/**
 * 95% interval for a rate per 100 turns, using the Poisson normal approximation
 * `k ± 1.96√k`. Interventions are not independent draws, so this is a rough band
 * on sampling noise, not a confidence statement about product quality.
 */
export function poissonRateInterval(count: number, turns: number): RateInterval | undefined {
	if (turns <= 0) return undefined;
	const spread = (1.96 * Math.sqrt(count)) / turns;
	const rate = count / turns;
	return {
		low: Math.max(0, Math.round((rate - spread) * 1000) / 10),
		high: Math.round((rate + spread) * 1000) / 10,
	};
}

export type ModelShareRow = { week: string; model: string; turns: number; share: number };

/** Per-week share of user turns by the model that answered them. */
export function modelShareWeeks(sessions: readonly SessionSummary[], weekOf: (session: SessionSummary) => string): ModelShareRow[] {
	const totals = new Map<string, { total: number; models: Map<string, number> }>();
	for (const session of sessions) {
		const week = weekOf(session);
		const bucket = totals.get(week) ?? { total: 0, models: new Map<string, number>() };
		for (const [model, turns] of Object.entries(session.modelTurns)) {
			bucket.total += turns;
			bucket.models.set(model, (bucket.models.get(model) ?? 0) + turns);
		}
		totals.set(week, bucket);
	}
	const rows: ModelShareRow[] = [];
	for (const [week, bucket] of totals) {
		for (const [model, turns] of bucket.models) {
			rows.push({ week, model, turns, share: bucket.total > 0 ? Math.round((turns / bucket.total) * 1000) / 10 : 0 });
		}
	}
	return rows.sort((left, right) => left.week.localeCompare(right.week) || right.turns - left.turns || left.model.localeCompare(right.model));
}

/** The provider a session is attributed to: the one that answered most of its turns. */
export function dominantProvider(session: SessionSummary): string {
	const byProvider = new Map<string, number>();
	for (const [model, turns] of Object.entries(session.modelTurns)) {
		const provider = model.split("/")[0] ?? "unknown";
		byProvider.set(provider, (byProvider.get(provider) ?? 0) + turns);
	}
	let best = "unknown";
	let bestTurns = 0;
	for (const [provider, turns] of [...byProvider].sort((left, right) => left[0].localeCompare(right[0]))) {
		if (turns > bestTurns) {
			best = provider;
			bestTurns = turns;
		}
	}
	return best;
}

export type DayRow = { day: string; provider: string; sessions: number; turns: number; interventions: number; per100: number | null; failures: number };

/**
 * One week split by day and by the session's dominant provider. Interventions carry the
 * session they happened in, so a session's interventions all count toward its provider.
 */
export function dayBreakdown(sessions: readonly SessionSummary[], week: string, weekOf: (session: SessionSummary) => string): DayRow[] {
	const rows = new Map<string, DayRow>();
	for (const session of sessions) {
		if (weekOf(session) !== week) continue;
		const day = session.startedAt.slice(0, 10) || "unknown";
		const provider = dominantProvider(session);
		const key = `${day}\u0000${provider}`;
		const row = rows.get(key) ?? { day, provider, sessions: 0, turns: 0, interventions: 0, per100: null, failures: 0 };
		row.sessions++;
		row.turns += session.userTurns;
		row.interventions += session.interventions;
		row.failures += session.failures;
		rows.set(key, row);
	}
	return [...rows.values()]
		.map((row) => ({ ...row, per100: row.turns > 0 ? Math.round((row.interventions / row.turns) * 1000) / 10 : null }))
		.sort((left, right) => left.day.localeCompare(right.day) || (right.per100 ?? -1) - (left.per100 ?? -1) || left.provider.localeCompare(right.provider));
}

export type CountRow = { key: string; count: number };

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): CountRow[] {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
	return [...counts].map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export type InterruptDurationBucket = "<2s" | "2-10s" | "10-30s" | "30-60s" | ">=60s" | "unknown";

const DURATION_BUCKETS: readonly InterruptDurationBucket[] = ["<2s", "2-10s", "10-30s", "30-60s", ">=60s", "unknown"];

export function durationBucket(elapsedMs: unknown): InterruptDurationBucket {
	if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return "unknown";
	if (elapsedMs < 2000) return "<2s";
	if (elapsedMs < 10_000) return "2-10s";
	if (elapsedMs < 30_000) return "10-30s";
	if (elapsedMs < 60_000) return "30-60s";
	return ">=60s";
}

export type InterruptTables = {
	/** Who moved the session on after the abort; only `human` proves a person stopped it. */
	byCause: CountRow[];
	byActivity: CountRow[];
	byDuration: CountRow[];
	byFollowUp: CountRow[];
	/** cause × activity, so a `human` abort can be read against what was running. */
	causeActivity: { cause: string; activity: string; count: number }[];
	/** Human-caused interrupts over all interrupts, in percent. */
	humanShare: number;
};

export function interruptTables(incidents: readonly Incident[]): InterruptTables {
	const interrupts = incidents.filter((incident) => incident.kind === "user_interrupt");
	const human = interrupts.filter((incident) => incident.detail.cause === "human").length;
	const matrix = new Map<string, number>();
	for (const incident of interrupts) {
		const key = `${String(incident.detail.cause)}\u0000${String(incident.detail.activity)}`;
		matrix.set(key, (matrix.get(key) ?? 0) + 1);
	}
	return {
		byCause: countBy(interrupts, (incident) => String(incident.detail.cause ?? "unknown")),
		byActivity: countBy(interrupts, (incident) => String(incident.detail.activity ?? "unknown")),
		// A bucket scale reads in order, so keep the scale instead of sorting by count.
		byDuration: DURATION_BUCKETS.map((bucket) => ({ key: bucket, count: interrupts.filter((incident) => durationBucket(incident.detail.elapsedMs) === bucket).length })).filter((row) => row.count > 0),
		byFollowUp: countBy(interrupts, (incident) => String(incident.detail.nextUser ?? "none")),
		causeActivity: [...matrix]
			.map(([key, count]) => {
				const [cause, activity] = key.split("\u0000");
				return { cause, activity, count };
			})
			.sort((left, right) => left.cause.localeCompare(right.cause) || right.count - left.count),
		humanShare: interrupts.length > 0 ? Math.round((human / interrupts.length) * 1000) / 10 : 0,
	};
}

export type ToolErrorTables = { byTool: CountRow[]; byCategory: CountRow[]; toolCategory: { tool: string; category: string; count: number }[] };

export function toolErrorTables(incidents: readonly Incident[]): ToolErrorTables {
	const streaks = incidents.filter((incident) => incident.kind === "tool_error_streak");
	const matrix = new Map<string, number>();
	for (const incident of streaks) {
		const key = `${String(incident.detail.tool ?? "unknown")}\u0000${String(incident.detail.category ?? "other")}`;
		matrix.set(key, (matrix.get(key) ?? 0) + 1);
	}
	return {
		byTool: countBy(streaks, (incident) => String(incident.detail.tool ?? "unknown")),
		byCategory: countBy(streaks, (incident) => String(incident.detail.category ?? "other")),
		toolCategory: [...matrix]
			.map(([key, count]) => {
				const [tool, category] = key.split("\u0000");
				return { tool, category, count };
			})
			.sort((left, right) => left.tool.localeCompare(right.tool) || right.count - left.count),
	};
}

/** v1 counts every intervention; v2 drops interrupts that are a self-retract or otherwise unjudged. */
export type NorthStarRow = { week: string; turns: number; v1: number; v1Per100: number | null; v1Interval?: RateInterval; v2: number; v2Per100: number | null; v2Interval?: RateInterval };

/**
 * Both north stars per week, in one table. v1 is unchanged so the history stays comparable;
 * v2 replaces every counted interrupt with only the quality ones.
 */
export function northStarWeeks(sessions: readonly SessionSummary[], weekOf: (session: SessionSummary) => string): NorthStarRow[] {
	const rows = new Map<string, { week: string; turns: number; v1: number; v2: number }>();
	for (const session of sessions) {
		const week = weekOf(session);
		const row = rows.get(week) ?? { week, turns: 0, v1: 0, v2: 0 };
		row.turns += session.userTurns;
		row.v1 += session.interventions;
		row.v2 += session.northStarV2;
		rows.set(week, row);
	}
	return [...rows.values()]
		.map((row) => ({
			...row,
			v1Per100: row.turns > 0 ? Math.round((row.v1 / row.turns) * 1000) / 10 : null,
			v1Interval: poissonRateInterval(row.v1, row.turns),
			v2Per100: row.turns > 0 ? Math.round((row.v2 / row.turns) * 1000) / 10 : null,
			v2Interval: poissonRateInterval(row.v2, row.turns),
		}))
		.sort((left, right) => left.week.localeCompare(right.week));
}

export type DimensionRow = { key: string; turns: number; interventions: number; northStarV2: number; v2Per100: number | null; v2Interval?: RateInterval };

/** Same rate per model, because the model mix changes faster than any week-to-week comparison. */
export function dimensionRates(sessions: readonly SessionSummary[], keyOf: (session: SessionSummary) => string | undefined): DimensionRow[] {
	const rows = new Map<string, { key: string; turns: number; interventions: number; northStarV2: number }>();
	for (const session of sessions) {
		const key = keyOf(session) ?? "unknown";
		const row = rows.get(key) ?? { key, turns: 0, interventions: 0, northStarV2: 0 };
		row.turns += session.userTurns;
		row.interventions += session.interventions;
		row.northStarV2 += session.northStarV2;
		rows.set(key, row);
	}
	return [...rows.values()]
		.map((row) => ({ ...row, v2Per100: row.turns > 0 ? Math.round((row.northStarV2 / row.turns) * 1000) / 10 : null, v2Interval: poissonRateInterval(row.northStarV2, row.turns) }))
		.sort((left, right) => right.turns - left.turns || left.key.localeCompare(right.key));
}

/** Turn share per model over the whole window, so a per-model rate has a denominator weight. */
export function modelTurnShare(sessions: readonly SessionSummary[]): { model: string; turns: number; share: number }[] {
	const turns = new Map<string, number>();
	let total = 0;
	for (const session of sessions) {
		for (const [model, count] of Object.entries(session.modelTurns)) {
			turns.set(model, (turns.get(model) ?? 0) + count);
			total += count;
		}
	}
	return [...turns]
		.map(([model, count]) => ({ model, turns: count, share: total > 0 ? Math.round((count / total) * 1000) / 10 : 0 }))
		.sort((left, right) => right.turns - left.turns || left.model.localeCompare(right.model));
}

/** Interrupts that ended with a different model selected before the next user message. */
export type ModelSwitchTables = {
	total: number;
	byModel: { model: string; count: number }[];
	byDuration: { duration: string; count: number }[];
	byModelDuration: { model: string; duration: string; count: number }[];
};

export function modelSwitchTables(incidents: readonly Incident[]): ModelSwitchTables {
	const switches = incidents.filter((incident) => incident.kind === "user_interrupt" && typeof incident.detail.modelSwitchAfter === "string");
	const matrix = new Map<string, number>();
	for (const incident of switches) {
		const key = `${String(incident.detail.model ?? "unknown")}\u0000${durationBucket(incident.detail.elapsedMs)}`;
		matrix.set(key, (matrix.get(key) ?? 0) + 1);
	}
	return {
		total: switches.length,
		byModel: countBy(switches, (incident) => String(incident.detail.model ?? "unknown")).map((row) => ({ model: row.key, count: row.count })),
		byDuration: DURATION_BUCKETS.filter((bucket) => switches.some((incident) => durationBucket(incident.detail.elapsedMs) === bucket)).map((bucket) => ({
			duration: bucket,
			count: switches.filter((incident) => durationBucket(incident.detail.elapsedMs) === bucket).length,
		})),
		byModelDuration: [...matrix]
			.map(([key, count]) => {
				const [model, duration] = key.split("\u0000");
				return { model, duration, count };
			})
			.sort((left, right) => right.count - left.count || left.model.localeCompare(right.model)),
	};
}

/** Interrupts by triage class, counted the same way v1 counts them. */
export function triageTable(incidents: readonly Incident[]): { triage: string; count: number }[] {
	const counted = incidents.filter((incident) => incident.kind === "user_interrupt" && incident.detail.cause !== "injected" && incident.detail.cause !== "compaction");
	return countBy(counted, (incident) => String(incident.detail.triage ?? "other")).map((row) => ({ triage: row.key, count: row.count }));
}

/**
 * Per-model rate from the model that answered each turn, not the session's dominant model: a
 * session that switched models in the middle would otherwise attribute everything to one.
 */
export function modelDimensionRates(sessions: readonly SessionSummary[]): DimensionRow[] {
	const rows = new Map<string, { key: string; turns: number; interventions: number; northStarV2: number }>();
	for (const session of sessions) {
		const models = new Set([...Object.keys(session.modelTurns), ...Object.keys(session.interventionModels), ...Object.keys(session.v2Models)]);
		for (const model of models) {
			const row = rows.get(model) ?? { key: model, turns: 0, interventions: 0, northStarV2: 0 };
			row.turns += session.modelTurns[model] ?? 0;
			row.interventions += session.interventionModels[model] ?? 0;
			row.northStarV2 += session.v2Models[model] ?? 0;
			rows.set(model, row);
		}
	}
	return [...rows.values()]
		.map((row) => ({ ...row, v2Per100: row.turns > 0 ? Math.round((row.northStarV2 / row.turns) * 1000) / 10 : null, v2Interval: poissonRateInterval(row.northStarV2, row.turns) }))
		.sort((left, right) => right.turns - left.turns || left.key.localeCompare(right.key));
}
