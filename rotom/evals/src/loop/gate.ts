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
};

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
	const base = { caseId: item.caseId, role: item.role, expectedPairs: repeats, artifacts };
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
};

export function runGate(options: RunGateOptions): { verdict: GateCaseVerdict; results: GateCaseResult[]; summaryPath: string } {
	for (const [label, path] of [["baseline", options.baselineProduct], ["candidate", options.candidateProduct]] as const) {
		if (!isAbsolute(path) || !existsSync(join(path, "runtime", "resolve-installed-pi.mjs"))) throw new Error(`${label} product must be an absolute rotom product directory: ${path}`);
	}
	if (resolve(options.baselineProduct) === resolve(options.candidateProduct)) throw new Error("baseline and candidate are the same directory; that is an A/A runner smoke, not a gate");
	const cases = options.manifest.cases.filter((item) => !options.only || item.caseId === options.only);
	if (cases.length === 0) throw new Error(`no gate case matches ${options.only}`);
	mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
	const results: GateCaseResult[] = [];
	for (const item of cases) {
		const artifacts = join(options.outDir, item.caseId);
		const env: NodeJS.ProcessEnv = {
			...(options.env ?? process.env),
			[item.enableEnv]: "1",
			[item.caseEnv]: item.caseId,
			[item.repeatsEnv]: String(options.manifest.repeats),
			ROTOM_EVAL_BASELINE_PRODUCT: options.baselineProduct,
			ROTOM_EVAL_CANDIDATE_PRODUCT: options.candidateProduct,
			ROTOM_EVAL_ARTIFACT_DIR: artifacts,
		};
		console.error(`[gate] ${item.caseId} (${item.role}) × ${options.manifest.repeats} → ${artifacts}`);
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
		results.push(judgeGateCase(item, options.manifest.repeats, artifacts, report));
	}
	const verdict = gateVerdict(results);
	const summaryPath = join(options.outDir, "gate-summary.json");
	const summary = {
		schema: GATE_SCHEMA,
		finishedAt: new Date().toISOString(),
		model: options.manifest.model,
		repeats: options.manifest.repeats,
		baselineProduct: options.baselineProduct,
		candidateProduct: options.candidateProduct,
		verdict,
		results,
	};
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	return { verdict, results, summaryPath };
}
