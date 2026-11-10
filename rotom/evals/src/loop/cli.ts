import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { parseGateManifest, runGate } from "./gate.ts";
import { appendGateHistory, gateHistoryRecords, parseGateHistory, poolGateHistory } from "./gate-history.ts";
import { defaultLoopDir, defaultSessionsDir, harvest } from "./harvest-run.ts";
import { defaultModelExperiment } from "./harvest-models.ts";
import { parseLedgerDir } from "./ledger.ts";
import { buildWeekly, parseWeeklyConfig, writeWeekly } from "./weekly.ts";
import { originCheck, replayIncident } from "./replay-run.ts";
import { readdirSync } from "node:fs";

const evalsRoot = resolve(import.meta.dirname, "../..");
const homeDir = () => process.env.HOME ?? homedir();
const repoRoot = resolve(evalsRoot, "../..");
export const GATE_MANIFEST = join(evalsRoot, "loop", "gate.json");
export const WEEKLY_CONFIG = join(evalsRoot, "loop", "weekly.json");
export const LEDGER = join(evalsRoot, "loop", "ledger");

const USAGE = `Usage: npm run loop -- <command>

  harvest [--sessions DIR] [--out DIR] [--days N | --since YYYY-MM-DD] [--no-excerpts]
          [--experiment default-model]
      Scan local Pi sessions (default ${defaultSessionsDir()}) into a private incident
      queue and weekly intervention rate under ${defaultLoopDir()}. No model calls.
      --experiment default-model adds the odd/even default-model comparison: only sessions
      whose first assistant message used that day's default model enter the rates.

  gate --baseline /abs/frozen/rotom [--candidate /abs/rotom] [--case ID] [--repeats N] [--out DIR] [--smoke]
      Re-run reproduced regression cases from loop/gate.json against both products
      and print held / regressed / unknown. Appends each case to the private gate
      history. Calls the configured model.

      --smoke runs one pair per case and audits the recorded scores: both arms must
      score, every check must be a boolean, and no check may read a file the fixture
      did not observe. It is not a sample, so nothing is appended to the history.
      Run it before a real gate run.

  gate-pool --since ISO [--case ID] [--history PATH]
      Merge every recorded gate run of the same candidate commit and baseline for
      each case since ISO, then judge the pooled pass and fail counts.

  ledger
      Validate every loop/ledger/<month>.json shard and print the experiment history.

  replay --incident <sessionId:entryId> [--repeats N] [--frozen DIR] [--current DIR]
         [--model provider/model] [--check COMMAND] [--origin-check [--origin-only]] [--out DIR]
      Re-run one recorded failure against a frozen product in an isolated copy of the
      session's own project: a worktree at the last commit before the session, its
      remotes removed, a scrubbed environment with its own HOME and a shell shim that
      refuses pushes, publishes and remote writes. Artifacts only under
      ~/.rotom/loop/replay-<stamp>/. The incident is read from the newest harvest.
      Product and model default to the frozen release the incident ran and the model
      that answered it; a replay never switches model. --check runs the event's own
      deterministic check in the same sandbox after each run (exit 0 pass, 1 the
      failure, anything else unknown) and admits reproduced (replay) at three of five
      failing runs. The check runs in the clone with REPLAY_TRANSCRIPT (this run's
      output) and REPLAY_WORKSPACE set. Tool calls and usage count the replay's new
      turns only. --origin-check applies the same check to what the original run
      produced before any model call: a pass means the event was never a failure,
      so it is skipped and counted as a harvest false positive. --origin-only stops
      after that verdict and spends no model call.

  weekly [--sessions DIR] [--days N] [--out DIR]
      Harvest the last N days (default 28) and write ~/.rotom/loop/weekly-<date>/:
      north star v2 with bands and a sensitivity column, the blinded field
      comparison (counts and adherence only until the window closes), every
      shipped-but-unmeasured ledger record against its own acceptance metric,
      and provider-to-user failures per 100 turns before and after the switch.
      No model calls; nothing is written to Git.
`;

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/gu, "-");
}

/** History lives next to the other private loop artifacts, never in Git. */
function gateHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(defaultLoopDir(env), "gate-history.jsonl");
}

/** Candidate commit of the product under test; `unknown` when it is not a Git checkout. */
function commitOf(product: string): string {
	const run = spawnSync("git", ["-C", product, "rev-parse", "HEAD"], { encoding: "utf8" });
	const commit = run.status === 0 ? run.stdout.trim() : "";
	return /^[0-9a-f]{40}$/u.test(commit) ? commit : "unknown";
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "harvest") {
		const { values } = parseArgs({
			args: rest,
			options: { sessions: { type: "string" }, out: { type: "string" }, days: { type: "string" }, since: { type: "string" }, "no-excerpts": { type: "boolean" }, experiment: { type: "string" } },
		});
		if (values.days && values.since) throw new Error("use --days or --since, not both");
		const days = values.days ? Number(values.days) : 28;
		if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
		const since = values.since ? new Date(`${values.since}T00:00:00Z`) : new Date(Date.now() - days * 86_400_000);
		if (Number.isNaN(since.getTime())) throw new Error("--since must be YYYY-MM-DD");
		if (values.experiment !== undefined && values.experiment !== "default-model") throw new Error("--experiment must be default-model");
		const result = await harvest({
			sessionsDir: values.sessions ?? defaultSessionsDir(),
			outRoot: values.out ?? defaultLoopDir(),
			since,
			excerpts: !values["no-excerpts"],
			...(values.experiment ? { experiment: "default-model" } : {}),
		});
		console.log(`sessions=${result.sessions.length} incidents=${result.incidents.length} skipped=${Object.entries(result.skipped).map(([reason, count]) => `${reason}:${count}`).join(",") || "0"}`);
		console.log(`report: ${join(result.outDir, "report.md")}`);
		if (values.experiment) {
			const experiment = defaultModelExperiment(result.sessions);
			const band = (row: (typeof experiment.groups)[number]) => `${row.v2Per100 ?? "N/A"}${row.v2Interval ? ` (${row.v2Interval.low.toFixed(1)}-${row.v2Interval.high.toFixed(1)})` : ""}`;
			for (const row of experiment.groups) {
				console.log(`experiment ${row.model}: sessions=${row.sessions} turns=${row.turns} v2=${row.v2} per100=${band(row)}`);
			}
			const { compliance, sensitivity } = experiment;
			console.log(`compliance: ${compliance.onDefault}/${compliance.sessions} sessions opened on that day's default (${compliance.rate === null ? "N/A" : `${Math.round(compliance.rate * 1000) / 10}%`}); switched=${experiment.switched.length} off-default=${experiment.offDefault.length}`);
			for (const row of sensitivity.groups) {
				console.log(`sensitivity (dropped ${sensitivity.droppedSessionId ?? "none"}) ${row.model}: turns=${row.turns} v2=${row.v2} per100=${band(row)}`);
			}
		}
		return 0;
	}
	if (command === "weekly") {
		const { values } = parseArgs({ args: rest, options: { sessions: { type: "string" }, days: { type: "string" }, out: { type: "string" } } });
		const days = values.days ? Number(values.days) : 28;
		if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
		const since = new Date(Date.now() - days * 86_400_000);
		const config = parseWeeklyConfig(readFileSync(WEEKLY_CONFIG, "utf8"));
		const result = await harvest({ sessionsDir: values.sessions ?? defaultSessionsDir(), outRoot: values.out ?? defaultLoopDir(), since, excerpts: false });
		const report = buildWeekly({ sessions: result.sessions, incidents: result.incidents, ledger: parseLedgerDir(LEDGER, repoRoot), config, since: since.toISOString() });
		const directory = await writeWeekly(values.out ?? defaultLoopDir(), report);
		console.log(`sessions=${result.sessions.length} incidents=${result.incidents.length}`);
		console.log(`weekly: ${directory}/report.md`);
		console.log(`experiment: ${report.experiment.state}; arms ${report.experiment.arms.map((arm) => `${arm.arm}=${arm.sessions}`).join(" ")}`);
		for (const row of report.records) console.log(`record ${row.status.padEnd(12)} ${row.id}  turns=${row.turns} observed=${row.observedPer100 ?? "N/A"} baseline=${row.baselinePer100 ?? "N/A"}`);
		return 0;
	}
	if (command === "replay") {
		const { values } = parseArgs({
			args: rest,
			options: { incident: { type: "string" }, repeats: { type: "string" }, frozen: { type: "string" }, current: { type: "string" }, model: { type: "string" }, check: { type: "string" }, "origin-check": { type: "boolean" }, "origin-only": { type: "boolean" }, out: { type: "string" } },
		});
		if (!values.incident) throw new Error("replay needs --incident <sessionId:entryId>");
		const [sessionId, entryId] = values.incident.split(":");
		if (!sessionId || !entryId) throw new Error("--incident must look like <sessionId>:<entryId>");
		const repeats = values.repeats === undefined ? 1 : Number(values.repeats);
		if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("--repeats must be an integer from 1 to 10");
		const loopDir = defaultLoopDir();
		const harvests = readdirSync(loopDir).filter((name) => name.startsWith("harvest-")).sort();
		const newest = harvests.at(-1);
		if (!newest) throw new Error(`no harvest artifact in ${loopDir}; run \`loop harvest\` first`);
		const incidents = readFileSync(join(loopDir, newest, "incidents.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; sessionId: string; sessionFile: string; entryId: string; timestamp: string; detail: Record<string, unknown> });
		const incident = incidents.find((item) => item.sessionId === sessionId && item.entryId === entryId);
		if (!incident) throw new Error(`no incident ${values.incident} in ${join(loopDir, newest)}`);
		if (incident.kind !== "user_correction" && incident.kind !== "user_repeat") throw new Error(`incident ${values.incident} is ${incident.kind}; only user_correction and user_repeat are replayable`);
		const modelText = values.model ?? String(incident.detail.model ?? "");
		const [provider, model] = modelText.split("/");
		if (!provider || !model) throw new Error("the incident records no model; pass --model provider/model");
		const frozen = values.frozen ?? resolve(homeDir(), ".local/share/rotom/releases", "0.1.27-main.50ccdc87/node_modules/rotom");
		const products = [{ label: "frozen", directory: frozen }];
		if (values.current) products.push({ label: "current", directory: resolve(values.current) });
		if (values["origin-check"]) {
			const judged = await originCheck({ sessionFile: incident.sessionFile, entryId: incident.entryId, ...(values.check ? { check: values.check } : {}) });
			console.log(`origin: ${judged.verdict}${judged.verdict === "pass" ? " (harvest false positive: the original run satisfied the check, so no replay)" : ""}`);
			if (judged.verdict === "pass") return 0;
			// `--repeats 0` judges the original run only: no model call is spent on the event.
			if (values["origin-only"]) return 0;
		}
		const outcome = await replayIncident({
			incidentId: values.incident,
			sessionFile: incident.sessionFile,
			cwd: (JSON.parse(readFileSync(incident.sessionFile, "utf8").split("\n")[0] ?? "{}") as { cwd?: string }).cwd ?? "",
			incidentTimestamp: incident.timestamp,
			entryId: incident.entryId,
			products,
			repeats,
			outRoot: values.out ?? loopDir,
			agentSource: join(homeDir(), ".pi", "agent"),
			model: { provider, model },
			...(values.check ? { check: values.check } : {}),
		});
		for (const run of outcome.runs) {
			const usage = run.stats.usage;
			console.log(`${run.label} run ${run.repeat}: exit=${run.exitCode ?? "signal"} check=${run.check} assistant=${run.stats.assistantMessages} toolCalls=${run.stats.toolCalls} usage=input ${usage.input} output ${usage.output} cacheRead ${usage.cacheRead} cacheWrite ${usage.cacheWrite} refusals=${run.refusals.length}${run.failed ? " FAILED" : ""}`);
			const names = Object.entries(run.stats.toolCallNames).sort((left, right) => right[1] - left[1]).map(([name, count]) => `${name}=${count}`).join(" ");
			if (names) console.log(`  tools: ${names}`);
		}
		for (const { label, admission } of outcome.admissions) console.log(`${label}: ${admission.verdict} (pass ${admission.passed}, fail ${admission.failed}, unknown ${admission.unknown} of ${admission.total})`);
		console.log(`replay: ${outcome.outDir}`);
		return 0;
	}
	if (command === "gate") {
		const { values } = parseArgs({
			args: rest,
			options: { baseline: { type: "string" }, candidate: { type: "string" }, case: { type: "string" }, repeats: { type: "string" }, out: { type: "string" }, smoke: { type: "boolean" } },
			allowNegative: false,
		});
		if (!values.baseline) throw new Error("gate needs --baseline /absolute/frozen/rotom");
		const manifest = parseGateManifest(readFileSync(GATE_MANIFEST, "utf8"));
		const repeats = values.repeats === undefined ? manifest.repeats : Number(values.repeats);
		if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("--repeats must be an integer from 1 to 5");
		const candidateProduct = values.candidate ?? resolve(evalsRoot, "..");
		const outDir = values.out ?? join(defaultLoopDir(), `gate-${stamp()}`);
		const smoke = values.smoke === true;
		if (smoke && values.repeats !== undefined) throw new Error("--smoke always runs one pair per case; drop --repeats");
		const result = runGate({
			evalsRoot,
			manifest: { ...manifest, repeats },
			baselineProduct: values.baseline,
			candidateProduct,
			only: values.case,
			outDir,
			smoke,
		});
		for (const item of result.results) {
			const rate = (value: number | null) => (value === null ? "N/A" : `${Math.round(value * 100)}%`);
			console.log(`${item.verdict.padEnd(9)} ${item.role.padEnd(10)} ${item.caseId}  ${item.model.provider}/${item.model.model}  baseline=${rate(item.baselinePassRate)} candidate=${rate(item.candidatePassRate)} pairs=${item.pairs}/${item.expectedPairs}${item.reason ? `  (${item.reason})` : ""}`);
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
			repeats,
			candidateCommit: commitOf(candidateProduct),
			baselineProduct: resolve(values.baseline),
			candidateProduct: resolve(candidateProduct),
			results: result.results,
		});
		appendGateHistory(historyPath, records);
		console.log(`gate: ${result.verdict} · ${result.summaryPath}`);
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
			console.log(`${group.verdict.padEnd(9)} ${(group.role ?? "?").padEnd(10)} ${group.caseId}`);
			console.log(`          runs=${group.runs} pairs=${group.pairs} baselineFail=${failures(group.pairs, group.baselinePass)} candidateFail=${failures(group.pairs, group.candidatePass)} unknownRuns=${group.unknownRuns}`);
			console.log(`          candidate=${group.candidateCommit} baseline=${group.baselineProduct} model=${group.model.provider}/${group.model.model}`);
		}
		return pooled.some((group) => group.verdict === "regressed") ? 1 : pooled.some((group) => group.verdict === "unknown") ? 2 : 0;
	}
	if (command === "ledger") {
		const entries = parseLedgerDir(LEDGER, repoRoot);
		for (const entry of entries) console.log(`${entry.date}  ${entry.change.padEnd(9)} ${entry.evidence.padEnd(15)} ${entry.decision.padEnd(8)} ${entry.title}`);
		console.log(`${entries.length} entries; ${entries.filter((entry) => entry.evidence === "improved").length} with measured improvement`);
		return 0;
	}
	console.error(USAGE);
	return command === undefined || command === "help" || command === "--help" ? 0 : 64;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
