/**
 * Per-model analysis that the harvest report reads: how large the work was, and what survives
 * dropping the single noisiest session. Aggregations that only group by a dimension stay in
 * `harvest-breakdown.ts`.
 */
import { modelDimensionRates, type DimensionRow } from "./harvest-breakdown.ts";
import type { SessionSummary } from "./harvest.ts";

/** Median of the given values, or `null` for an empty set; even counts average the middle pair. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

export type ModelSizeRow = { model: string; sessions: number; turns: number; medianTurnsPerSession: number | null; medianToolCallsPerTurn: number | null };

/**
 * Task-size proxy per model, so a high v2 rate can be read against what the model was asked to
 * do. Sessions are attributed to the model that answered most of their turns; a session that
 * switched models is not split, because "how big was the task" is a property of the session.
 * Both numbers are medians: one huge session must not decide the size.
 */
export function modelTaskSize(sessions: readonly SessionSummary[]): ModelSizeRow[] {
	const rows = new Map<string, { turns: number[]; toolCallsPerTurn: number[] }>();
	for (const session of sessions) {
		const model = dominantModel(session);
		const row = rows.get(model) ?? { turns: [], toolCallsPerTurn: [] };
		row.turns.push(session.userTurns);
		if (session.userTurns > 0) row.toolCallsPerTurn.push(Math.round((session.toolCalls / session.userTurns) * 100) / 100);
		rows.set(model, row);
	}
	return [...rows]
		.map(([model, row]) => ({
			model,
			sessions: row.turns.length,
			turns: row.turns.reduce((sum, value) => sum + value, 0),
			medianTurnsPerSession: median(row.turns),
			medianToolCallsPerTurn: median(row.toolCallsPerTurn),
		}))
		.sort((left, right) => right.turns - left.turns || left.model.localeCompare(right.model));
}

/**
 * A rate for one dimension key with that key's single largest v2 session removed, so a row that
 * only survives because of one long conversation is visible next to the row itself.
 */
export type PeakAdjustedRate = { turns: number; v2: number; v2Per100: number | null; droppedSessionId: string | null };

function adjustedRate(turns: number, v2: number, dropped: string | null): PeakAdjustedRate {
	return { turns, v2, v2Per100: turns > 0 ? Math.round((v2 / turns) * 1000) / 10 : null, droppedSessionId: dropped };
}

/** Per key of `keyOf`: whole-session attribution, matching `dimensionRates`. */
export function dimensionRatesWithoutLargestSession(
	sessions: readonly SessionSummary[],
	keyOf: (session: SessionSummary) => string | undefined,
): Map<string, PeakAdjustedRate> {
	const rows = new Map<string, { turns: number; v2: number; peak: SessionSummary }>();
	for (const session of sessions) {
		const key = keyOf(session) ?? "unknown";
		const row = rows.get(key) ?? { turns: 0, v2: 0, peak: session };
		row.turns += session.userTurns;
		row.v2 += session.northStarV2;
		if (row.peak !== session && session.northStarV2 > row.peak.northStarV2) row.peak = session;
		rows.set(key, row);
	}
	const result = new Map<string, PeakAdjustedRate>();
	for (const [key, row] of rows) {
		if (row.peak.northStarV2 === 0) result.set(key, adjustedRate(row.turns, row.v2, null));
		else result.set(key, adjustedRate(row.turns - row.peak.userTurns, row.v2 - row.peak.northStarV2, row.peak.sessionId));
	}
	return result;
}

/** Per model: a session contributes only the v2 events attributed to that model. */
export function modelRatesWithoutLargestSession(sessions: readonly SessionSummary[]): Map<string, PeakAdjustedRate> {
	const rows = new Map<string, { turns: number; v2: number; peak: { sessionId: string; turns: number; v2: number } }>();
	for (const session of sessions) {
		const models = new Set([...Object.keys(session.modelTurns), ...Object.keys(session.v2Models)]);
		for (const model of models) {
			const turns = session.modelTurns[model] ?? 0;
			const v2 = session.v2Models[model] ?? 0;
			const row = rows.get(model) ?? { turns: 0, v2: 0, peak: { sessionId: session.sessionId, turns: 0, v2: 0 } };
			row.turns += turns;
			row.v2 += v2;
			if (v2 > row.peak.v2) row.peak = { sessionId: session.sessionId, turns, v2 };
			rows.set(model, row);
		}
	}
	const result = new Map<string, PeakAdjustedRate>();
	for (const [model, row] of rows) {
		if (row.peak.v2 === 0) result.set(model, adjustedRate(row.turns, row.v2, null));
		else result.set(model, adjustedRate(row.turns - row.peak.turns, row.v2 - row.peak.v2, row.peak.sessionId));
	}
	return result;
}

/** The model that answered most turns of a session, ties broken by name so the row is stable. */
export function dominantModel(session: SessionSummary): string {
	let best = "unknown";
	let bestTurns = 0;
	for (const [model, turns] of [...Object.entries(session.modelTurns)].sort((left, right) => left[0].localeCompare(right[0]))) {
		if (turns > bestTurns) {
			best = model;
			bestTurns = turns;
		}
	}
	return best;
}

/**
 * Per-model rates with the single session that contributed the most v2 events removed. If one
 * session drives a model's rate, that rate describes one conversation, not the model.
 */
export function modelDimensionRatesWithoutPeak(sessions: readonly SessionSummary[]): { dropped: SessionSummary | undefined; rows: DimensionRow[] } {
	let dropped: SessionSummary | undefined;
	for (const session of sessions) {
		if (!dropped || session.northStarV2 > dropped.northStarV2) dropped = session;
	}
	if (dropped && dropped.northStarV2 === 0) dropped = undefined;
	const kept = dropped ? sessions.filter((session) => session !== dropped) : sessions;
	return { dropped, rows: modelDimensionRates(kept) };
}
