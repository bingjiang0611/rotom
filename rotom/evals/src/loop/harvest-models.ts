/**
 * Per-model analysis that the harvest report reads: how large the work was, what survives
 * dropping the single noisiest session, and the default-model field comparison. Aggregations
 * that only group by a dimension stay in `harvest-breakdown.ts`.
 */
import { modelDimensionRates, poissonRateInterval, type DimensionRow, type RateInterval } from "./harvest-breakdown.ts";
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

/**
 * The planned default-model comparison: odd days default to `gpt-6-astra`, even days to
 * `gpt-6.1-sol`. A session counts only when its first assistant message already used the model
 * its day defaults to; a session that started on the default and switched later is listed
 * separately, because the switch is the user reacting to the model rather than the default.
 */
export const DEFAULT_MODEL_BY_PARITY = { odd: "openai-codex/gpt-6-astra", even: "openai-codex/gpt-6.1-sol" } as const;

export function expectedDefaultModel(startedAt: string): string | undefined {
	const day = Number(startedAt.slice(8, 10));
	if (!Number.isSafeInteger(day) || day < 1 || day > 31) return undefined;
	return day % 2 === 1 ? DEFAULT_MODEL_BY_PARITY.odd : DEFAULT_MODEL_BY_PARITY.even;
}

export type ExperimentGroup = { model: string; sessions: number; turns: number; v2: number; v2Per100: number | null; v2Interval?: RateInterval };

export type DefaultModelExperiment = {
	groups: ExperimentGroup[];
	/**
	 * Whether the day's default actually applied: of the sessions with a known day default, how
	 * many opened on that model. A low rate means the comparison is about the person's habits,
	 * not the default, and the groups cannot answer the question on their own.
	 */
	compliance: { sessions: number; onDefault: number; rate: number | null };
	/** The groups recomputed without the single counted session that holds the most v2 events. */
	sensitivity: { droppedSessionId: string | null; groups: ExperimentGroup[] };
	/** Started on the day's default model, then switched: excluded from the groups. */
	switched: { sessionId: string; startedAt: string; expected: string; models: string[] }[];
	/** Never used the day's default model, or recorded no first assistant model. */
	offDefault: { sessionId: string; startedAt: string; expected: string | undefined; firstAssistantModel: string | undefined }[];
};

/** Group rows for a set of counted sessions, one row per arm even when an arm is empty. */
function experimentGroups(sessions: readonly SessionSummary[]): ExperimentGroup[] {
	const rows = new Map<string, { turns: number; v2: number; sessions: number }>();
	for (const session of sessions) {
		const model = expectedDefaultModel(session.startedAt);
		if (!model) continue;
		const row = rows.get(model) ?? { turns: 0, v2: 0, sessions: 0 };
		row.turns += session.userTurns;
		row.v2 += session.northStarV2;
		row.sessions += 1;
		rows.set(model, row);
	}
	return [DEFAULT_MODEL_BY_PARITY.odd, DEFAULT_MODEL_BY_PARITY.even].map((model) => {
		const row = rows.get(model) ?? { turns: 0, v2: 0, sessions: 0 };
		return {
			model,
			...row,
			v2Per100: row.turns > 0 ? Math.round((row.v2 / row.turns) * 1000) / 10 : null,
			v2Interval: poissonRateInterval(row.v2, row.turns),
		};
	});
}

export function defaultModelExperiment(sessions: readonly SessionSummary[]): DefaultModelExperiment {
	const counted: SessionSummary[] = [];
	const switched: DefaultModelExperiment["switched"] = [];
	const offDefault: DefaultModelExperiment["offDefault"] = [];
	// The ratio counts every session whose day default is known, including the ones that opened on
	// another model and the ones that recorded no first assistant model: a session that did not
	// demonstrably open on the default is not evidence that the default applied.
	let measured = 0;
	let onDefault = 0;
	for (const session of sessions) {
		const expected = expectedDefaultModel(session.startedAt);
		if (!expected) {
			// Listed for visibility, but not in the ratio: there is no day default to compare to.
			offDefault.push({ sessionId: session.sessionId, startedAt: session.startedAt, expected, firstAssistantModel: session.firstAssistantModel });
			continue;
		}
		measured += 1;
		if (!session.firstAssistantModel || session.firstAssistantModel !== expected) {
			offDefault.push({ sessionId: session.sessionId, startedAt: session.startedAt, expected, firstAssistantModel: session.firstAssistantModel });
			continue;
		}
		onDefault += 1;
		if (session.models.length > 1) {
			switched.push({ sessionId: session.sessionId, startedAt: session.startedAt, expected, models: [...session.models] });
			continue;
		}
		counted.push(session);
	}
	let peak: SessionSummary | undefined;
	for (const session of counted) {
		if (!peak || session.northStarV2 > peak.northStarV2) peak = session;
	}
	const dropped = peak && peak.northStarV2 > 0 ? peak : undefined;
	return {
		groups: experimentGroups(counted),
		compliance: { sessions: measured, onDefault, rate: measured > 0 ? Math.round((onDefault / measured) * 1000) / 1000 : null },
		sensitivity: {
			droppedSessionId: dropped?.sessionId ?? null,
			groups: experimentGroups(dropped ? counted.filter((session) => session !== dropped) : counted),
		},
		switched: switched.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
		offDefault: offDefault.sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
	};
}
