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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describeProducts, preflightFailure, preflightGate } from "./gate-preflight.ts";
import { auditSmokeScores, smokeScoresFromResults } from "./gate-smoke.ts";

export { auditSmokeScores, smokeScoresFromResults, type SmokeScore } from "./gate-smoke.ts";

export const GATE_SCHEMA = "rotom-loop-gate/v1";

export type GateModel = { provider: string; model: string };

/**
 * Reproduction evidence is recorded per model: whether a case discriminates on `qoder/dfmodel`
 * says nothing about `openai-codex/gpt-6.1-sol`. Since 2026-11-25 the loop runs dfmodel only;
 * records for other models stay as history.
 * `not-reproduced` means the frozen baseline no longer fails the case on that model, so it
 * cannot show improvement there and needs a new case; `flaky-candidate` is a case that fails on
 * the frozen baseline, but below the admission rule, so it may only be pooled with more samples
 * before it decides anything.
 */
export type ReproductionRecord = { model: string; verdict: ReproductionVerdict; detail: string };

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
	/** Overrides the manifest model for this case; absent means the manifest default. */
	model?: GateModel;
	/** Overrides the manifest repeats for this case; `--repeats` still overrides every case. */
	repeats?: number;
	/**
	 * A holdout case restates another case's mechanism in different words and fixtures. It is
	 * never run while a fix is being tuned, only with `--holdout` at the judging round, and it
	 * is reported next to the verdict instead of deciding it.
	 */
	split?: "holdout";
	/** The tuned case a holdout restates. Required for a holdout, refused otherwise. */
	variantOf?: string;
	reproduction?: ReproductionRecord[];
};

export const REPRODUCTION_VERDICTS = ["reproduced", "not-reproduced", "flaky-candidate"] as const;
export type ReproductionVerdict = (typeof REPRODUCTION_VERDICTS)[number];

export type GateManifest = {
	schema: typeof GATE_SCHEMA;
	model: { provider: string; model: string };
	repeats: number;
	cases: GateCase[];
	/**
	 * Replay cases (`loop replay-gate`) are registered here by id and a de-identified mechanism
	 * only. The incident, the check and the session branch live in `~/.rotom/loop/replay-cases/`,
	 * because they quote a real session.
	 */
	replays?: { id: string; kind: "replay"; mechanism: string }[];
};

const ENV_NAME = /^ROTOM_EVAL_[A-Z0-9_]+$/u;

function validModel(value: unknown): value is GateModel {
	if (typeof value !== "object" || value === null) return false;
	const { provider, model } = value as { provider?: unknown; model?: unknown };
	return typeof provider === "string" && provider.trim() !== "" && typeof model === "string" && model.trim() !== "";
}

/** The model this case runs on: its own override, else the manifest default. */
export function effectiveModel(item: GateCase, manifest: Pick<GateManifest, "model">): GateModel {
	return item.model ?? manifest.model;
}

export function parseGateManifest(text: string): GateManifest {
	const value = JSON.parse(text) as Partial<GateManifest>;
	if (value.schema !== GATE_SCHEMA) throw new Error(`gate manifest schema must be ${GATE_SCHEMA}`);
	if (!validModel(value.model)) throw new Error("gate manifest needs model.provider and model.model");
	if (!Number.isSafeInteger(value.repeats) || (value.repeats as number) < 1 || (value.repeats as number) > 5) throw new Error("gate repeats must be an integer from 1 to 5");
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error("gate manifest needs at least one case");
	const seen = new Set<string>();
	for (const item of value.cases) {
		if (!item || typeof item.suite !== "string" || !/^cases\/[\w.-]+\.eval\.ts$/u.test(item.suite)) throw new Error("gate case suite must be cases/<name>.eval.ts");
		if (typeof item.caseId !== "string" || !item.caseId) throw new Error("gate case needs caseId");
		if (item.role !== "reproduced" && item.role !== "control") throw new Error(`gate case ${item.caseId} role must be reproduced or control`);
		for (const name of [item.enableEnv, item.caseEnv, item.repeatsEnv]) if (typeof name !== "string" || !ENV_NAME.test(name)) throw new Error(`gate case ${item.caseId} has an invalid env name`);
		if (typeof item.ledger !== "string" || !item.ledger) throw new Error(`gate case ${item.caseId} must cite a ledger entry`);
		if (item.model !== undefined && !validModel(item.model)) throw new Error(`gate case ${item.caseId} model must have provider and model`);
		if (item.repeats !== undefined && (!Number.isSafeInteger(item.repeats) || item.repeats < 1 || item.repeats > 5)) throw new Error(`gate case ${item.caseId} repeats must be an integer from 1 to 5`);
		if (item.split !== undefined && item.split !== "holdout") throw new Error(`gate case ${item.caseId} split must be holdout or absent`);
		if ((item.split === "holdout") !== (typeof item.variantOf === "string" && item.variantOf !== "")) throw new Error(`gate case ${item.caseId}: a holdout names the case it restates in variantOf, and only a holdout does`);
		if (item.reproduction !== undefined) {
			if (!Array.isArray(item.reproduction)) throw new Error(`gate case ${item.caseId} reproduction must be a list, one record per model`);
			const models = new Set<string>();
			for (const reproduction of item.reproduction as Partial<ReproductionRecord>[]) {
				if (typeof reproduction !== "object" || reproduction === null) throw new Error(`gate case ${item.caseId} reproduction record must be an object`);
				const record = reproduction as { model?: unknown; detail?: unknown; verdict?: unknown };
				for (const field of ["model", "detail"] as const) {
					const value = record[field];
					if (typeof value !== "string" || !value.trim()) throw new Error(`gate case ${item.caseId} reproduction.${field} is required`);
				}
				if (!REPRODUCTION_VERDICTS.includes(record.verdict as ReproductionVerdict)) throw new Error(`gate case ${item.caseId} reproduction.verdict must be ${REPRODUCTION_VERDICTS.join(", ")}`);
				const model = record.model as string;
				if (models.has(model)) throw new Error(`gate case ${item.caseId} records reproduction twice for ${model}`);
				models.add(model);
			}
		}
		const key = `${item.suite}#${item.caseId}`;
		if (seen.has(key)) throw new Error(`duplicate gate case ${key}`);
		seen.add(key);
	}
	// A holdout cannot stand in for the tuned case: it is skipped by default, so a manifest
	// holding only holdouts would gate nothing.
	const tuned = value.cases.filter((item) => item.split !== "holdout");
	if (!tuned.some((item) => item.role === "reproduced")) throw new Error("gate manifest needs at least one reproduced case");
	for (const item of value.cases) if (item.split === "holdout" && !tuned.some((other) => other.caseId === item.variantOf)) throw new Error(`gate case ${item.caseId} variantOf must name a case that is not itself a holdout`);
	if (value.replays !== undefined) {
		if (!Array.isArray(value.replays) || value.replays.length === 0) throw new Error("gate manifest replays must be a non-empty list");
		const ids = new Set<string>();
		for (const item of value.replays as { id?: unknown; kind?: unknown; mechanism?: unknown }[]) {
			if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,60}$/u.test(item.id)) throw new Error("gate replay case id must be a slug");
			if (ids.has(item.id)) throw new Error(`duplicate gate replay case ${item.id}`);
			ids.add(item.id);
			if (item.kind !== "replay") throw new Error(`gate replay case ${item.id} kind must be replay`);
			if (typeof item.mechanism !== "string" || !item.mechanism.trim()) throw new Error(`gate replay case ${item.id} needs a mechanism summary`);
			if (/\/Users\/|\/home\/|\.rotom/u.test(item.mechanism)) throw new Error(`gate replay case ${item.id} mechanism must not carry a local path`);
		}
	}
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
	split?: GateCase["split"];
	/** Model actually used for both arms, so a per-case override stays visible in the artifacts. */
	model: GateModel;
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

export function judgeGateCase(item: GateCase, repeats: number, artifacts: string, report: ComparisonsReport | undefined, model: GateModel = { provider: "", model: "" }): GateCaseResult {
	const base = { caseId: item.caseId, role: item.role, ...(item.split ? { split: item.split } : {}), model, reproduction: item.reproduction, expectedPairs: repeats, artifacts };
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

/**
 * What a holdout says about the fix. A holdout restates a mechanism the frozen baseline already
 * fails, so a candidate failure there is expected and "regressed" would misread it: the question
 * is whether the fix carried over, i.e. whether the candidate fails less than the baseline on
 * the same pairs. Equal failures mean the fix did not show on the restatement; with three pairs
 * that is a reason to add samples, not a conclusion.
 */
export type HoldoutReading = "generalizes" | "no-difference" | "worse" | "unknown";

export function holdoutReading(results: readonly Pick<GateCaseResult, "verdict" | "pairs" | "expectedPairs" | "baselinePassRate" | "candidatePassRate">[]): HoldoutReading {
	if (results.length === 0 || results.some((result) => result.pairs < result.expectedPairs || result.baselinePassRate === null || result.candidatePassRate === null)) return "unknown";
	const passes = (rate: number | null, pairs: number) => Math.round((rate ?? 0) * pairs);
	const baseline = results.reduce((sum, result) => sum + passes(result.baselinePassRate, result.pairs), 0);
	const candidate = results.reduce((sum, result) => sum + passes(result.candidatePassRate, result.pairs), 0);
	return candidate > baseline ? "generalizes" : candidate === baseline ? "no-difference" : "worse";
}

/** Holdout results are reported beside the verdict, so callers pass them separately. */
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
	/** `--repeats`: one count for every case, ahead of a case's own and the manifest's. */
	repeats?: number;
	/** Also run holdout cases. Off by default so tuning a fix never looks at them. */
	holdout?: boolean;
	env?: NodeJS.ProcessEnv;
	/** One pair per case plus a judge audit; not a sample, so it is never recorded as one. */
	smoke?: boolean;
};

/** Cases one run covers: the selection by id, minus holdouts unless they were asked for. */
export function selectGateCases(manifest: GateManifest, options: { only?: string; holdout?: boolean }): GateCase[] {
	const named = manifest.cases.filter((item) => !options.only || item.caseId === options.only);
	if (named.length === 0) throw new Error(`no gate case matches ${options.only}`);
	const cases = named.filter((item) => options.holdout || item.split !== "holdout");
	if (cases.length === 0) throw new Error(`${options.only} is a holdout case; pass --holdout to run it`);
	return cases;
}

/** Repetitions for one case: smoke is always one pair, then `--repeats`, the case, the manifest. */
export function repeatsFor(item: GateCase, options: { manifest: Pick<GateManifest, "repeats">; repeats?: number; smoke?: boolean }): number {
	return options.smoke ? 1 : options.repeats ?? item.repeats ?? options.manifest.repeats;
}

export function runGate(options: RunGateOptions): { verdict: GateCaseVerdict; holdoutReading?: HoldoutReading; results: GateCaseResult[]; summaryPath: string; smokeProblems: string[] } {
	for (const [label, path] of [["baseline", options.baselineProduct], ["candidate", options.candidateProduct]] as const) {
		if (!isAbsolute(path) || !existsSync(join(path, "runtime", "resolve-installed-pi.mjs"))) throw new Error(`${label} product must be an absolute rotom product directory: ${path}`);
	}
	if (resolve(options.baselineProduct) === resolve(options.candidateProduct)) throw new Error("baseline and candidate are the same directory; that is an A/A runner smoke, not a gate");
	// Both products are checked against their own lock and fork build before anything is spent:
	// last round's candidate arm installed an older archive than its product declared and only
	// failed once the baseline arm had already been paid for.
	const preflight = preflightGate([{ product: options.baselineProduct, label: "baseline" }, { product: options.candidateProduct, label: "candidate" }]);
	if (preflight.problems.length > 0) throw new Error(preflightFailure(preflight.problems));
	for (const line of describeProducts(preflight.products)) console.error(line);
	const cases = selectGateCases(options.manifest, options);
	mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
	const results: GateCaseResult[] = [];
	const smokeProblems: string[] = [];
	for (const item of cases) {
		const model = effectiveModel(item, options.manifest);
		const repeats = repeatsFor(item, options);
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
		console.error(`[gate] ${item.caseId} (${item.role}) × ${repeats} on ${model.provider}/${model.model}${options.smoke ? " (smoke)" : ""} → ${artifacts}`);
		const run = spawnSync(join(options.evalsRoot, "bin", "eval"), ["--provider", model.provider, "--model", model.model, item.suite], {
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
		results.push(judgeGateCase(item, repeats, artifacts, report, model));
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
	const verdict = gateVerdict(results.filter((result) => result.split !== "holdout"));
	const holdouts = results.filter((result) => result.split === "holdout");
	const reading = holdouts.length > 0 ? holdoutReading(holdouts) : undefined;
	const summaryPath = join(options.outDir, "gate-summary.json");
	const summary = {
		schema: GATE_SCHEMA,
		finishedAt: new Date().toISOString(),
		model: options.manifest.model,
		// Per-case overrides are listed once, so the summary names every model this run used.
		models: [...new Set(results.map((result) => `${result.model.provider}/${result.model.model}`))],
		// The run-wide default; a case with its own count records it in `expectedPairs`.
		repeats: options.smoke ? 1 : options.repeats ?? options.manifest.repeats,
		...(options.smoke ? { smoke: true, smokeOk: smokeProblems.length === 0, smokeProblems } : {}),
		baselineProduct: options.baselineProduct,
		candidateProduct: options.candidateProduct,
		products: preflight.products,
		verdict,
		...(reading ? { holdoutReading: reading } : {}),
		results,
	};
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	return { verdict, ...(reading ? { holdoutReading: reading } : {}), results, summaryPath, smokeProblems };
}
