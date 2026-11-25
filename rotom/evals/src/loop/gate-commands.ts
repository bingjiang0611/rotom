/**
 * The commands around one gate run: freeze a baseline, run the gate, pool its history, and
 * print where the loop stands. They share the manifest, the private history file and the
 * frozen-baseline pointer, so they live together instead of lengthening the argument switch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freezeBaseline, latestFrozen, type Run } from "./freeze.ts";
import { holdoutReading, parseGateManifest, runGate } from "./gate.ts";
import { appendGateHistory, gateHistoryRecords, parseGateHistory, poolGateHistory } from "./gate-history.ts";
import { defaultLoopDir } from "./harvest-run.ts";
import { parseLedgerDir } from "./ledger.ts";
import { buildStatus, parseWeeklySnapshot, renderStatus } from "./status.ts";
import { parseWeeklyConfig } from "./weekly.ts";

type Deps = { repoRoot: string; evalsRoot: string };

/** History lives next to the other private loop artifacts, never in Git. */
const gateHistoryPath = (env: NodeJS.ProcessEnv = process.env) => join(defaultLoopDir(env), "gate-history.jsonl");

/** Candidate commit of the product under test; `unknown` when it is not a Git checkout. */
function commitOf(product: string): string {
	const run = spawnSync("git", ["-C", product, "rev-parse", "HEAD"], { encoding: "utf8" });
	const commit = run.status === 0 ? run.stdout.trim() : "";
	return /^[0-9a-f]{40}$/u.test(commit) ? commit : "unknown";
}

/** git and npm talk on stderr while they work; stdout is kept because `rev-parse` answers there. */
const run: Run = (command, args) => {
	const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	return { status: result.status, stdout: result.stdout ?? "" };
};

/** The newest `weekly-<date>/summary.json`, or nothing when no weekly report was ever written. */
function newestWeekly(loopDir: string): string | undefined {
	if (!existsSync(loopDir)) return undefined;
	const newest = readdirSync(loopDir).filter((name) => /^weekly-\d{4}-\d{2}-\d{2}$/u.test(name)).sort().at(-1);
	const path = newest ? join(loopDir, newest, "summary.json") : undefined;
	return path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export async function gateCommand(command: string, rest: string[], deps: Deps): Promise<number> {
	const manifestPath = join(deps.evalsRoot, "loop", "gate.json");
	const loopDir = defaultLoopDir();
	if (command === "freeze") {
		const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
		if (positionals.length !== 1) throw new Error("freeze needs exactly one commit, tag or branch: loop freeze <ref>");
		const frozen = freezeBaseline({ ref: positionals[0] as string, repoRoot: deps.repoRoot, loopDir, run });
		console.log(`frozen ${frozen.sha.slice(0, 12)} (${frozen.ref}) ${frozen.reused ? "reused, nothing reinstalled" : "installed"}`);
		console.log(`baseline: ${frozen.product}`);
		return 0;
	}
	if (command === "status") {
		const historyPath = gateHistoryPath();
		const weekly = newestWeekly(loopDir);
		const report = buildStatus({
			manifest: parseGateManifest(readFileSync(manifestPath, "utf8")),
			history: existsSync(historyPath) ? parseGateHistory(readFileSync(historyPath, "utf8")) : undefined,
			ledger: parseLedgerDir(join(deps.evalsRoot, "loop", "ledger"), deps.repoRoot),
			weekly: weekly === undefined ? undefined : parseWeeklySnapshot(weekly),
			weeklyDay: parseWeeklyConfig(readFileSync(join(deps.evalsRoot, "loop", "weekly.json"), "utf8")).day,
			frozen: latestFrozen(loopDir),
			now: new Date(),
		});
		process.stdout.write(renderStatus(report));
		return 0;
	}
	if (command === "gate") {
		const { values } = parseArgs({
			args: rest,
			options: { baseline: { type: "string" }, candidate: { type: "string" }, case: { type: "string" }, repeats: { type: "string" }, out: { type: "string" }, smoke: { type: "boolean" }, holdout: { type: "boolean" }, model: { type: "string" } },
			allowNegative: false,
		});
		// Without --baseline the gate compares against the last frozen commit and says which one,
		// so a run is never judged against a baseline nobody named.
		const frozen = values.baseline ? undefined : latestFrozen(loopDir);
		const baseline = values.baseline ?? frozen?.product;
		if (!baseline) throw new Error("gate needs --baseline /absolute/frozen/rotom, or run `loop freeze <ref>` once first");
		if (frozen) console.error(`[gate] baseline: frozen ${frozen.sha.slice(0, 12)} (${frozen.ref})`);
		const manifest = parseGateManifest(readFileSync(manifestPath, "utf8"));
		const repeats = values.repeats === undefined ? undefined : Number(values.repeats);
		if (repeats !== undefined && (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5)) throw new Error("--repeats must be an integer from 1 to 5");
		const candidateProduct = values.candidate ?? resolve(deps.evalsRoot, "..");
		const outDir = values.out ?? join(loopDir, `gate-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
		const smoke = values.smoke === true;
		if (smoke && repeats !== undefined) throw new Error("--smoke always runs one pair per case; drop --repeats");
		// `--model` overrides the manifest default for every case, so a control can be sampled on a
		// second model without editing the committed manifest.
		const modelOverride = values.model === undefined ? undefined : String(values.model).split("/");
		if (modelOverride && (modelOverride.length !== 2 || !modelOverride[0] || !modelOverride[1])) throw new Error("--model must look like provider/model");
		const result = runGate({
			evalsRoot: deps.evalsRoot,
			manifest: { ...manifest, ...(modelOverride ? { model: { provider: modelOverride[0] as string, model: modelOverride[1] as string } } : {}) },
			baselineProduct: baseline,
			candidateProduct,
			only: values.case,
			...(repeats === undefined ? {} : { repeats }),
			holdout: values.holdout === true,
			outDir,
			smoke,
		});
		for (const item of result.results) {
			const rate = (value: number | null) => (value === null ? "N/A" : `${Math.round(value * 100)}%`);
			// A holdout prints its reading, not held/regressed: it is expected to fail on the baseline.
			const label = item.split === "holdout" ? holdoutReading([item]) : item.verdict;
			console.log(`${label.padEnd(13)} ${(item.split ?? item.role).padEnd(10)} ${item.caseId}  ${item.model.provider}/${item.model.model}  baseline=${rate(item.baselinePassRate)} candidate=${rate(item.candidatePassRate)} pairs=${item.pairs}/${item.expectedPairs}${item.reason ? `  (${item.reason})` : ""}`);
		}
		if (smoke) {
			console.log(`smoke: ${result.smokeProblems.length === 0 ? "ok" : "failed"}`);
			for (const problem of result.smokeProblems) console.log(`  - ${problem}`);
			console.log(`summary: ${result.summaryPath}`);
			return result.smokeProblems.length === 0 ? 0 : 1;
		}
		const historyPath = gateHistoryPath();
		const records = gateHistoryRecords({
			recordedAt: new Date().toISOString(),
			runId: outDir.split("/").at(-1) ?? outDir,
			candidateCommit: commitOf(candidateProduct),
			baselineProduct: resolve(baseline),
			candidateProduct: resolve(candidateProduct),
			results: result.results,
		});
		appendGateHistory(historyPath, records);
		console.log(`gate: ${result.verdict} · ${result.summaryPath}`);
		// Reported, not folded in: a tuned case that improves while its holdout shows no difference
		// means the fix fits the case rather than the mechanism, a finding about the fix.
		if (result.holdoutReading) console.log(`holdout: ${result.holdoutReading} (candidate against baseline on the restated cases; not part of the verdict)`);
		console.log(`history: ${historyPath} (+${records.length} samples)`);
		return result.verdict === "held" ? 0 : result.verdict === "regressed" ? 1 : 2;
	}
	if (command === "gate-pool") {
		const { values } = parseArgs({ args: rest, options: { since: { type: "string" }, case: { type: "string" }, history: { type: "string" } } });
		if (!values.since) throw new Error("gate-pool needs --since <ISO time>");
		const since = new Date(values.since);
		if (Number.isNaN(since.getTime())) throw new Error("--since must be an ISO timestamp");
		const historyPath = values.history ?? gateHistoryPath();
		if (!existsSync(historyPath)) throw new Error(`no gate history at ${historyPath}`);
		const pooled = poolGateHistory(parseGateHistory(readFileSync(historyPath, "utf8")), { since, caseId: values.case });
		if (pooled.length === 0) throw new Error(`no gate samples since ${since.toISOString()}`);
		for (const group of pooled) {
			const failures = (total: number, pass: number) => total - pass;
			const label = group.split === "holdout"
				? holdoutReading([{ verdict: group.verdict, pairs: group.pairs, expectedPairs: group.pairs, baselinePassRate: group.pairs ? group.baselinePass / group.pairs : null, candidatePassRate: group.pairs ? group.candidatePass / group.pairs : null }])
				: group.verdict;
			console.log(`${label.padEnd(13)} ${(group.split ?? group.role ?? "?").padEnd(10)} ${group.caseId}`);
			console.log(`          runs=${group.runs} pairs=${group.pairs} baselineFail=${failures(group.pairs, group.baselinePass)} candidateFail=${failures(group.pairs, group.candidatePass)} unknownRuns=${group.unknownRuns}`);
			console.log(`          candidate=${group.candidateCommit} baseline=${group.baselineProduct} model=${group.model.provider}/${group.model.model}`);
		}
		// Holdout groups are printed above but do not decide the exit code, as in a single run.
		const tuned = pooled.filter((group) => group.split !== "holdout");
		return tuned.some((group) => group.verdict === "regressed") ? 1 : tuned.some((group) => group.verdict === "unknown") ? 2 : 0;
	}
	return 64;
}
