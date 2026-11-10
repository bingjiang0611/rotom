/**
 * Gate history and pooling: one line per case per run in a private append-only file, so a
 * re-run adds samples instead of replacing an earlier failure. Running a gate lives in
 * `gate.ts`; this module only reads and writes what a run recorded.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GateCase, GateCaseResult, GateCaseVerdict, GateManifest } from "./gate.ts";

/**
 * Append-only gate history. One gate run records one line per case, so a re-run adds samples
 * instead of replacing an earlier failure, and `gate-pool` can merge them.
 */
export const GATE_HISTORY_SCHEMA = "rotom-loop-gate-history/v1";

export type GateHistoryRecord = {
	schema: typeof GATE_HISTORY_SCHEMA;
	recordedAt: string;
	/** Gate run directory basename, so a pooled sample can be traced back to its artifacts. */
	runId: string;
	model: GateManifest["model"];
	repeats: number;
	candidateCommit: string;
	baselineProduct: string;
	candidateProduct: string;
	caseId: string;
	role: GateCase["role"];
	verdict: GateCaseVerdict;
	/** Scorable pairs in this run; `unknown` runs contribute their scored pairs only. */
	pairs: number;
	baselinePass: number;
	candidatePass: number;
	artifacts: string;
};

function passCount(rate: number | null, pairs: number): number {
	if (rate === null || pairs <= 0) return 0;
	return Math.round(rate * pairs);
}

export function gateHistoryRecords(input: {
	recordedAt: string;
	runId: string;
	repeats: number;
	candidateCommit: string;
	baselineProduct: string;
	candidateProduct: string;
	results: readonly GateCaseResult[];
}): GateHistoryRecord[] {
	return input.results.map((result) => ({
		schema: GATE_HISTORY_SCHEMA,
		recordedAt: input.recordedAt,
		runId: input.runId,
		// The model that actually ran, so a per-case override is not recorded as the default.
		model: result.model,
		repeats: input.repeats,
		candidateCommit: input.candidateCommit,
		baselineProduct: input.baselineProduct,
		candidateProduct: input.candidateProduct,
		caseId: result.caseId,
		role: result.role,
		verdict: result.verdict,
		pairs: result.pairs,
		baselinePass: passCount(result.baselinePassRate, result.pairs),
		candidatePass: passCount(result.candidatePassRate, result.pairs),
		artifacts: result.artifacts,
	}));
}

/** Append samples under a private directory with a 0600 file; re-runs never rewrite earlier lines. */
export function appendGateHistory(historyPath: string, records: readonly GateHistoryRecord[]): void {
	if (records.length === 0) return;
	mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
	appendFileSync(historyPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

export function parseGateHistory(text: string): GateHistoryRecord[] {
	const records: GateHistoryRecord[] = [];
	text.split("\n").forEach((line, index) => {
		if (!line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(`gate history line ${index + 1} is not JSON`);
		}
		const record = value as Partial<GateHistoryRecord>;
		if (record.schema !== GATE_HISTORY_SCHEMA) throw new Error(`gate history line ${index + 1} schema must be ${GATE_HISTORY_SCHEMA}`);
		for (const field of ["recordedAt", "runId", "candidateCommit", "baselineProduct", "candidateProduct", "caseId", "artifacts"] as const) {
			if (typeof record[field] !== "string" || !(record[field] as string)) throw new Error(`gate history line ${index + 1} needs ${field}`);
		}
		if (!record.model || typeof record.model.provider !== "string" || typeof record.model.model !== "string") throw new Error(`gate history line ${index + 1} needs model.provider and model.model`);
		if (!Number.isSafeInteger(record.pairs) || (record.pairs as number) < 0) throw new Error(`gate history line ${index + 1} needs pairs`);
		if (!Number.isSafeInteger(record.baselinePass) || !Number.isSafeInteger(record.candidatePass)) throw new Error(`gate history line ${index + 1} needs pass counts`);
		records.push(value as GateHistoryRecord);
	});
	return records;
}

export type GatePoolResult = {
	candidateCommit: string;
	baselineProduct: string;
	candidateProduct: string;
	model: GateManifest["model"];
	caseId: string;
	role: GateCase["role"] | undefined;
	/** Samples merged, scorable pairs, and runs that could not score every repetition. */
	runs: number;
	pairs: number;
	baselinePass: number;
	candidatePass: number;
	unknownRuns: number;
	verdict: GateCaseVerdict;
	runIds: string[];
};

/**
 * Merge every recorded run of the same candidate commit, baseline product, model and case.
 * Failures accumulate: a later passing run never cancels an earlier failed pair.
 */
export function poolGateHistory(records: readonly GateHistoryRecord[], options: { since?: Date; caseId?: string } = {}): GatePoolResult[] {
	const groups = new Map<string, GatePoolResult>();
	for (const record of records) {
		if (options.since && new Date(record.recordedAt).getTime() < options.since.getTime()) continue;
		if (options.caseId && record.caseId !== options.caseId) continue;
		const key = [record.candidateCommit, record.baselineProduct, record.model.provider, record.model.model, record.caseId].join("\u0000");
		const group = groups.get(key) ?? {
			candidateCommit: record.candidateCommit,
			baselineProduct: record.baselineProduct,
			candidateProduct: record.candidateProduct,
			model: record.model,
			caseId: record.caseId,
			role: record.role,
			runs: 0,
			pairs: 0,
			baselinePass: 0,
			candidatePass: 0,
			unknownRuns: 0,
			verdict: "unknown",
			runIds: [],
		};
		group.runs++;
		group.pairs += record.pairs;
		group.baselinePass += record.baselinePass;
		group.candidatePass += record.candidatePass;
		if (record.verdict === "unknown") group.unknownRuns++;
		if (!group.runIds.includes(record.runId)) group.runIds.push(record.runId);
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			verdict: (group.candidatePass < group.pairs ? "regressed" : group.pairs === 0 ? "unknown" : "held") as GateCaseVerdict,
		}))
		.sort((left, right) => left.caseId.localeCompare(right.caseId));
}
