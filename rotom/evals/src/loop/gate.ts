/**
 * Regression gate: re-runs only cases whose failure was reproduced on a frozen
 * baseline (plus their controls) and turns `comparisons.json` into a verdict.
 *
 * The verdict depends on the candidate arm only. The baseline arm is reported
 * for drift: against the pre-fix product it shows the case still discriminates,
 * against the last release it is expected to pass as well.
 *
 * The vitest exit code is never the verdict: the baseline arm has no threshold
 * and a failing candidate exits non-zero by design. Missing or partial
 * observations are `unknown`, never `held`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const GATE_SCHEMA = "rotom-loop-gate/v1";

export type GateCase = {
	/** Suite file relative to the evals package. */
	suite: string;
	caseId: string;
	/** `reproduced`: failed on a frozen baseline; `control`: guards against over-correction. */
	role: "reproduced" | "control";
	enableEnv: string;
	caseEnv: string;
	repeatsEnv: string;
	/** Ledger entry that admitted this case. */
	ledger: string;
	/**
	 * Last recorded reproduction evidence. `not-reproduced` means the frozen baseline no longer
	 * fails the case on that model, so it cannot show improvement there and needs a new case;
	 * `flaky-candidate` is a case that fails on the frozen baseline, but below the 2-of-3
	 * admission rule, so it may only be pooled with more samples before it decides anything.
	 */
	reproduction?: { model: string; verdict: ReproductionVerdict; detail: string };
};

export const REPRODUCTION_VERDICTS = ["reproduced", "not-reproduced", "flaky-candidate"] as const;
export type ReproductionVerdict = (typeof REPRODUCTION_VERDICTS)[number];

export type GateManifest = {
	schema: typeof GATE_SCHEMA;
	model: { provider: string; model: string };
	repeats: number;
	cases: GateCase[];
};

const ENV_NAME = /^ROTOM_EVAL_[A-Z0-9_]+$/u;

export function parseGateManifest(text: string): GateManifest {
	const value = JSON.parse(text) as Partial<GateManifest>;
	if (value.schema !== GATE_SCHEMA) throw new Error(`gate manifest schema must be ${GATE_SCHEMA}`);
	if (!value.model || typeof value.model.provider !== "string" || typeof value.model.model !== "string") throw new Error("gate manifest needs model.provider and model.model");
	if (!Number.isSafeInteger(value.repeats) || (value.repeats as number) < 1 || (value.repeats as number) > 5) throw new Error("gate repeats must be an integer from 1 to 5");
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error("gate manifest needs at least one case");
	const seen = new Set<string>();
	for (const item of value.cases) {
		if (!item || typeof item.suite !== "string" || !/^cases\/[\w.-]+\.eval\.ts$/u.test(item.suite)) throw new Error("gate case suite must be cases/<name>.eval.ts");
		if (typeof item.caseId !== "string" || !item.caseId) throw new Error("gate case needs caseId");
		if (item.role !== "reproduced" && item.role !== "control") throw new Error(`gate case ${item.caseId} role must be reproduced or control`);
		for (const name of [item.enableEnv, item.caseEnv, item.repeatsEnv]) if (typeof name !== "string" || !ENV_NAME.test(name)) throw new Error(`gate case ${item.caseId} has an invalid env name`);
		if (typeof item.ledger !== "string" || !item.ledger) throw new Error(`gate case ${item.caseId} must cite a ledger entry`);
		if (item.reproduction !== undefined) {
			const reproduction = item.reproduction as Partial<GateCase["reproduction"]> | null;
			if (typeof reproduction !== "object" || reproduction === null) throw new Error(`gate case ${item.caseId} reproduction must be an object`);
			for (const field of ["model", "detail"] as const) {
				if (typeof reproduction[field] !== "string" || !(reproduction[field] as string).trim()) throw new Error(`gate case ${item.caseId} reproduction.${field} is required`);
			}
			if (!REPRODUCTION_VERDICTS.includes(reproduction.verdict as ReproductionVerdict)) throw new Error(`gate case ${item.caseId} reproduction.verdict must be ${REPRODUCTION_VERDICTS.join(", ")}`);
		}
		const key = `${item.suite}#${item.caseId}`;
		if (seen.has(key)) throw new Error(`duplicate gate case ${key}`);
		seen.add(key);
	}
	if (!value.cases.some((item) => item.role === "reproduced")) throw new Error("gate manifest needs at least one reproduced case");
	return value as GateManifest;
}

type Correctness = { eligiblePairs: number; baselinePassRate: number | null; candidatePassRate: number | null };
type MetricSummary = { baselineMean: number | null; candidateMean: number | null };
type ComparisonsReport = {
	evalSets?: { evalSet: string; comparisons: { correctness: Correctness; totalTokens?: MetricSummary; totalMs?: MetricSummary; estimatedCostUsd?: MetricSummary }[] }[];
	diagnostics?: unknown[];
};

export type GateCaseVerdict = "held" | "regressed" | "unknown";

export type GateCaseResult = {
	caseId: string;
	role: GateCase["role"];
	/** Recorded reproduction evidence carried into the summary, if any. */
	reproduction?: GateCase["reproduction"];
	verdict: GateCaseVerdict;
	pairs: number;
	expectedPairs: number;
	baselinePassRate: number | null;
	candidatePassRate: number | null;
	candidateMeanTokens: number | null;
	baselineMeanTokens: number | null;
	diagnostics: number;
	artifacts: string;
	reason?: string;
};

export function judgeGateCase(item: GateCase, repeats: number, artifacts: string, report: ComparisonsReport | undefined): GateCaseResult {
	const base = { caseId: item.caseId, role: item.role, reproduction: item.reproduction, expectedPairs: repeats, artifacts };
	const comparisons = report?.evalSets?.flatMap((set) => set.comparisons) ?? [];
	if (!report || comparisons.length !== 1) {
		return { ...base, verdict: "unknown", pairs: 0, baselinePassRate: null, candidatePassRate: null, candidateMeanTokens: null, baselineMeanTokens: null, diagnostics: report?.diagnostics?.length ?? 0, reason: report ? "expected exactly one baseline/candidate comparison" : "comparisons.json missing" };
	}
	const [comparison] = comparisons;
	const { eligiblePairs, baselinePassRate, candidatePassRate } = comparison.correctness;
	const diagnostics = report.diagnostics?.length ?? 0;
	const metrics = {
		pairs: eligiblePairs,
		baselinePassRate,
		candidatePassRate,
		candidateMeanTokens: comparison.totalTokens?.candidateMean ?? null,
		baselineMeanTokens: comparison.totalTokens?.baselineMean ?? null,
		diagnostics,
	};
	if (eligiblePairs < repeats || candidatePassRate === null) {
		return { ...base, ...metrics, verdict: "unknown", reason: `only ${eligiblePairs}/${repeats} scorable pairs (provider error, timeout or missing score)` };
	}
	const verdict: GateCaseVerdict = candidatePassRate === 1 ? "held" : "regressed";
	return { ...base, ...metrics, verdict };
}

export function gateVerdict(results: readonly GateCaseResult[]): GateCaseVerdict {
	if (results.some((result) => result.verdict === "regressed")) return "regressed";
	if (results.some((result) => result.verdict === "unknown")) return "unknown";
	return "held";
}

export type RunGateOptions = {
	evalsRoot: string;
	manifest: GateManifest;
	baselineProduct: string;
	candidateProduct: string;
	outDir: string;
	only?: string;
	env?: NodeJS.ProcessEnv;
	/** One pair per case plus a judge audit; not a sample, so it is never recorded as one. */
	smoke?: boolean;
};

/** One scored run as the artifact side records it. */
export type SmokeScore = { checks?: Record<string, unknown>; missingObservation?: unknown };

/**
 * A smoke run proves the recorded output can be scored before spending a full run on it:
 * every arm produced a score, every check resolved to a boolean, and no check read a file
 * the fixture never observed. The last one is the failure this audit exists for: a judge
 * reading an unobserved path silently scored `false` and voided a whole batch.
 */
export function auditSmokeScores(scores: readonly SmokeScore[]): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	if (scores.length === 0) problems.push("no score was recorded for this case");
	for (const [index, score] of scores.entries()) {
		const checks = score.checks;
		if (!checks || typeof checks !== "object") {
			problems.push(`score ${index + 1} has no checks`);
			continue;
		}
		for (const [name, value] of Object.entries(checks)) if (typeof value !== "boolean") problems.push(`check ${name} is ${value === undefined ? "missing" : typeof value}, not a boolean`);
		const missing = score.missingObservation;
		if (Array.isArray(missing) && missing.length > 0) problems.push(`checks read unobserved path(s): ${missing.map(String).join(", ")}`);
		if (missing !== undefined && !Array.isArray(missing)) problems.push("missingObservation is not a list");
	}
	return { ok: problems.length === 0, problems };
}

/** Reads the judge verdicts the eval artifacts recorded for one case. */
export function smokeScoresFromResults(report: unknown): SmokeScore[] {
	const results = (report as { testResults?: { assertionResults?: unknown[] }[] } | undefined)?.testResults ?? [];
	const scores: SmokeScore[] = [];
	for (const file of results) {
		for (const assertion of file.assertionResults ?? []) {
			const item = assertion as { meta?: { eval?: { scores?: { metadata?: { output?: unknown } }[] } } };
			for (const score of item.meta?.eval?.scores ?? []) {
				const output = score.metadata?.output as { checks?: Record<string, unknown>; missingObservation?: unknown } | undefined;
				if (output) scores.push({ checks: output.checks, missingObservation: output.missingObservation });
			}
		}
	}
	return scores;
}

export function runGate(options: RunGateOptions): { verdict: GateCaseVerdict; results: GateCaseResult[]; summaryPath: string; smokeProblems: string[] } {
	for (const [label, path] of [["baseline", options.baselineProduct], ["candidate", options.candidateProduct]] as const) {
		if (!isAbsolute(path) || !existsSync(join(path, "runtime", "resolve-installed-pi.mjs"))) throw new Error(`${label} product must be an absolute rotom product directory: ${path}`);
	}
	if (resolve(options.baselineProduct) === resolve(options.candidateProduct)) throw new Error("baseline and candidate are the same directory; that is an A/A runner smoke, not a gate");
	const cases = options.manifest.cases.filter((item) => !options.only || item.caseId === options.only);
	if (cases.length === 0) throw new Error(`no gate case matches ${options.only}`);
	const repeats = options.smoke ? 1 : options.manifest.repeats;
	mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
	const results: GateCaseResult[] = [];
	const smokeProblems: string[] = [];
	for (const item of cases) {
		const artifacts = join(options.outDir, item.caseId);
		const env: NodeJS.ProcessEnv = {
			...(options.env ?? process.env),
			[item.enableEnv]: "1",
			[item.caseEnv]: item.caseId,
			[item.repeatsEnv]: String(repeats),
			ROTOM_EVAL_BASELINE_PRODUCT: options.baselineProduct,
			ROTOM_EVAL_CANDIDATE_PRODUCT: options.candidateProduct,
			ROTOM_EVAL_ARTIFACT_DIR: artifacts,
		};
		console.error(`[gate] ${item.caseId} (${item.role}) × ${repeats}${options.smoke ? " (smoke)" : ""} → ${artifacts}`);
		const run = spawnSync(join(options.evalsRoot, "bin", "eval"), ["--provider", options.manifest.model.provider, "--model", options.manifest.model.model, item.suite], {
			cwd: options.evalsRoot,
			env,
			stdio: "inherit",
		});
		if (run.error) console.error(`[gate] ${item.caseId}: ${run.error.message}`);
		const reportPath = join(artifacts, "comparisons.json");
		let report: ComparisonsReport | undefined;
		try {
			report = JSON.parse(readFileSync(reportPath, "utf8")) as ComparisonsReport;
		} catch {
			report = undefined;
		}
		results.push(judgeGateCase(item, repeats, artifacts, report));
		if (options.smoke) {
			let recorded: unknown;
			try {
				recorded = JSON.parse(readFileSync(join(artifacts, "vitest-results.json"), "utf8"));
			} catch {
				recorded = undefined;
			}
			const scores = smokeScoresFromResults(recorded);
			// Both arms must score even though the smoke list may be one case: a baseline arm
			// that never scored hides a fixture the judge cannot read.
			if (scores.length < 2) smokeProblems.push(`${item.caseId}: only ${scores.length}/2 arm(s) recorded a score`);
			for (const problem of auditSmokeScores(scores).problems) smokeProblems.push(`${item.caseId}: ${problem}`);
		}
	}
	const verdict = gateVerdict(results);
	const summaryPath = join(options.outDir, "gate-summary.json");
	const summary = {
		schema: GATE_SCHEMA,
		finishedAt: new Date().toISOString(),
		model: options.manifest.model,
		repeats,
		...(options.smoke ? { smoke: true, smokeOk: smokeProblems.length === 0, smokeProblems } : {}),
		baselineProduct: options.baselineProduct,
		candidateProduct: options.candidateProduct,
		verdict,
		results,
	};
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	return { verdict, results, summaryPath, smokeProblems };
}

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
	model: GateManifest["model"];
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
		model: input.model,
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
