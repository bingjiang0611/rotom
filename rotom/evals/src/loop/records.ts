/**
 * Shared loop records: the results several machines need to pool, kept in Git under
 * `loop/results/` instead of each machine's private `~/.rotom/loop/`.
 *
 * Only aggregates go here: case ids, pass counts, verdicts, models, commits and a product
 * fingerprint. Never a session, an excerpt, a session id, a host name or a local path; the
 * private run directory is named by its run id only, so the machine that ran it can still find
 * its artifacts. One file per run and machine, so two machines never edit the same file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCaseResult } from "./gate.ts";
import type { GateHistoryRecord } from "./gate-history.ts";

export const GATE_RECORD_SCHEMA = "rotom-loop-gate-record/v1";
export const WEEKLY_RECORD_SCHEMA = "rotom-loop-weekly-record/v1";

const MACHINE = /^[a-z0-9][a-z0-9-]{1,30}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^gate-[0-9TZ-]+$/u;

/** Injected so tests can answer git without a repository. */
export type Git = (args: readonly string[]) => { status: number | null; stdout: string };

export type ProductIdentity = {
	/** Commit the product was checked out at, or `unknown`. */
	commit: string;
	/**
	 * Hash of the product tree without `evals/`. Two commits that differ only in evals or docs
	 * run the same product, so their samples pool; uncommitted product changes make it `dirty-…`,
	 * which never pools with anything.
	 */
	productId: string;
};

export type GateRecordCase = {
	caseId: string;
	role: "reproduced" | "control";
	split?: "holdout";
	model: string;
	verdict: "held" | "regressed" | "unknown";
	pairs: number;
	expectedPairs: number;
	baselinePass: number;
	candidatePass: number;
};

export type GateRecord = {
	schema: typeof GATE_RECORD_SCHEMA;
	machine: string;
	runId: string;
	recordedAt: string;
	baseline: ProductIdentity;
	candidate: ProductIdentity;
	cases: GateRecordCase[];
};

export type WeeklyRecord = {
	schema: typeof WEEKLY_RECORD_SCHEMA;
	machine: string;
	generatedAt: string;
	since: string;
	overall: { turns: number; events: number; per100: number | null; band: [number, number] | null; withoutLargestPer100: number | null };
	models: { model: string; turns: number; per100: number | null }[];
	acceptance: { id: string; status: string }[];
};

export function validMachine(name: string): boolean {
	return MACHINE.test(name);
}

/** The machine label: `ROTOM_LOOP_MACHINE`, else `<loopDir>/machine.json`; undefined when neither is set. */
export function machineName(loopDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env.ROTOM_LOOP_MACHINE?.trim();
	if (fromEnv) {
		if (!validMachine(fromEnv)) throw new Error(`ROTOM_LOOP_MACHINE must be a short lowercase label such as mac1, got ${fromEnv}`);
		return fromEnv;
	}
	const path = join(loopDir, "machine.json");
	if (!existsSync(path)) return undefined;
	const name = (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown }).name;
	if (typeof name !== "string" || !validMachine(name)) throw new Error(`${path} must hold {"name": "<label>"} with a short lowercase label`);
	return name;
}

export function setMachineName(loopDir: string, name: string): void {
	if (!validMachine(name)) throw new Error("machine label must be 2-31 lowercase letters, digits or dashes, such as mac1");
	mkdirSync(loopDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(loopDir, "machine.json"), `${JSON.stringify({ name })}\n`, { mode: 0o600 });
}

/** Product fingerprint of `commit`: the `rotom/` tree listing without `evals`, hashed. */
export function productIdAt(git: Git, commit: string): string {
	if (!SHA.test(commit)) return "unknown";
	const listing = git(["ls-tree", `${commit}:rotom`]);
	if (listing.status !== 0) return "unknown";
	const lines = listing.stdout.split("\n").filter((line) => line && !/\tevals$/u.test(line));
	return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Identity of a product directory inside a checkout: its HEAD and the fingerprint of that tree,
 * marked dirty when product files outside `evals/` differ from HEAD.
 */
export function productIdentity(git: Git, gitInProduct: Git): ProductIdentity {
	const head = gitInProduct(["rev-parse", "HEAD"]);
	const commit = head.status === 0 && SHA.test(head.stdout.trim()) ? head.stdout.trim() : "unknown";
	if (commit === "unknown") return { commit, productId: "unknown" };
	const status = gitInProduct(["status", "--porcelain", "--", ".", ":(exclude)evals"]);
	const productId = productIdAt(git, commit);
	if (status.status !== 0) return { commit, productId: "unknown" };
	return { commit, productId: status.stdout.trim() ? `dirty-${commit.slice(0, 12)}` : productId };
}

export function gateRecord(input: { machine: string; runId: string; recordedAt: string; baseline: ProductIdentity; candidate: ProductIdentity; results: readonly GateCaseResult[] }): GateRecord {
	const passes = (rate: number | null, pairs: number) => (rate === null || pairs <= 0 ? 0 : Math.round(rate * pairs));
	return {
		schema: GATE_RECORD_SCHEMA,
		machine: input.machine,
		runId: input.runId,
		recordedAt: input.recordedAt,
		baseline: input.baseline,
		candidate: input.candidate,
		cases: input.results.map((result) => ({
			caseId: result.caseId,
			role: result.role,
			...(result.split ? { split: result.split } : {}),
			model: `${result.model.provider}/${result.model.model}`,
			verdict: result.verdict,
			pairs: result.pairs,
			expectedPairs: result.expectedPairs,
			baselinePass: passes(result.baselinePassRate, result.pairs),
			candidatePass: passes(result.candidatePassRate, result.pairs),
		})),
	};
}

const gateDir = (evalsRoot: string, machine: string) => join(evalsRoot, "loop", "results", "gate", machine);

/** Writes one run's record; refuses to overwrite, because a run is recorded exactly once. */
export function writeGateRecord(evalsRoot: string, record: GateRecord): string {
	const directory = gateDir(evalsRoot, record.machine);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${record.runId}.json`);
	if (existsSync(path)) throw new Error(`${path} already exists; a run is recorded once`);
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`);
	return path;
}

function parseGateRecord(text: string, where: string): GateRecord {
	const value = JSON.parse(text) as Partial<GateRecord>;
	if (value.schema !== GATE_RECORD_SCHEMA) throw new Error(`${where}: schema must be ${GATE_RECORD_SCHEMA}`);
	if (typeof value.machine !== "string" || !validMachine(value.machine)) throw new Error(`${where}: invalid machine`);
	if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) throw new Error(`${where}: invalid runId`);
	if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) throw new Error(`${where}: invalid recordedAt`);
	for (const side of ["baseline", "candidate"] as const) {
		const identity = value[side];
		if (!identity || typeof identity.commit !== "string" || typeof identity.productId !== "string") throw new Error(`${where}: ${side} needs commit and productId`);
	}
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error(`${where}: needs cases`);
	for (const item of value.cases) {
		if (typeof item.caseId !== "string" || typeof item.model !== "string" || !item.model.includes("/")) throw new Error(`${where}: case needs caseId and provider/model`);
		for (const field of ["pairs", "expectedPairs", "baselinePass", "candidatePass"] as const) {
			if (!Number.isSafeInteger(item[field]) || item[field] < 0) throw new Error(`${where}: ${item.caseId} needs ${field}`);
		}
		if (item.baselinePass > item.pairs || item.candidatePass > item.pairs) throw new Error(`${where}: ${item.caseId} passes exceed pairs`);
	}
	// A record is public: a local path or a home directory in it is a leak, not data.
	if (/\/Users\/|\/home\/|~\/|\.rotom/u.test(text)) throw new Error(`${where}: records must not carry local paths`);
	return value as GateRecord;
}

/** Every committed gate record, all machines; a missing directory is no records, not an error. */
export function readGateRecords(evalsRoot: string): GateRecord[] {
	const root = join(evalsRoot, "loop", "results", "gate");
	if (!existsSync(root)) return [];
	const records: GateRecord[] = [];
	const seen = new Set<string>();
	for (const machine of readdirSync(root).sort()) {
		for (const name of readdirSync(join(root, machine)).filter((file) => file.endsWith(".json")).sort()) {
			const where = `loop/results/gate/${machine}/${name}`;
			const record = parseGateRecord(readFileSync(join(root, machine, name), "utf8"), where);
			if (record.machine !== machine || `${record.runId}.json` !== name) throw new Error(`${where}: file must sit at gate/<machine>/<runId>.json`);
			const key = `${record.machine}:${record.runId}`;
			if (seen.has(key)) throw new Error(`${where}: duplicate run ${key}`);
			seen.add(key);
			records.push(record);
		}
	}
	return records;
}

/**
 * Records as pooling samples. The pooling key is the product fingerprint, not the commit, so
 * two machines that ran the same product from different commits pool; an unknown fingerprint
 * falls back to the commit.
 */
export function recordSamples(records: readonly GateRecord[]): GateHistoryRecord[] {
	const key = (identity: ProductIdentity) => (identity.productId === "unknown" ? `commit:${identity.commit}` : `product:${identity.productId}`);
	return records.flatMap((record) => record.cases.map((item) => {
		const [provider, ...rest] = item.model.split("/");
		return {
			schema: "rotom-loop-gate-history/v1" as const,
			recordedAt: record.recordedAt,
			runId: `${record.machine}:${record.runId}`,
			model: { provider: provider ?? "", model: rest.join("/") },
			repeats: item.expectedPairs,
			candidateCommit: key(record.candidate),
			baselineProduct: key(record.baseline),
			candidateProduct: record.candidate.commit,
			caseId: item.caseId,
			role: item.role,
			...(item.split ? { split: item.split } : {}),
			verdict: item.verdict,
			pairs: item.pairs,
			baselinePass: item.baselinePass,
			candidatePass: item.candidatePass,
			artifacts: `${record.machine}:${record.runId}`,
		};
	}));
}

/**
 * Turns this machine's private history into records, one per run not yet committed. The frozen
 * baseline's commit is read from its worktree, or from its `frozen/<sha>/` directory name when
 * the worktree is gone.
 */
export function importLocalHistory(input: { history: readonly GateHistoryRecord[]; machine: string; committed: readonly GateRecord[]; git: Git; baselineCommit: (path: string) => string }): GateRecord[] {
	const done = new Set(input.committed.filter((record) => record.machine === input.machine).map((record) => record.runId));
	const runs = new Map<string, GateHistoryRecord[]>();
	for (const sample of input.history) {
		if (done.has(sample.runId) || !RUN_ID.test(sample.runId)) continue;
		runs.set(sample.runId, [...(runs.get(sample.runId) ?? []), sample]);
	}
	return [...runs.entries()].map(([runId, samples]) => {
		const first = samples[0] as GateHistoryRecord;
		const baselineCommit = input.baselineCommit(first.baselineProduct);
		return {
			schema: GATE_RECORD_SCHEMA,
			machine: input.machine,
			runId,
			recordedAt: first.recordedAt,
			baseline: { commit: baselineCommit, productId: productIdAt(input.git, baselineCommit) },
			// The private history kept no dirty flag, so an imported candidate is fingerprinted
			// from its commit; the import says so in its output.
			candidate: { commit: first.candidateCommit, productId: productIdAt(input.git, first.candidateCommit) },
			cases: samples.map((sample) => ({
				caseId: sample.caseId,
				role: sample.role,
				...(sample.split ? { split: sample.split } : {}),
				model: `${sample.model.provider}/${sample.model.model}`,
				verdict: sample.verdict,
				pairs: sample.pairs,
				expectedPairs: sample.repeats,
				baselinePass: sample.baselinePass,
				candidatePass: sample.candidatePass,
			})),
		};
	});
}

/** The aggregate of one weekly report that may leave the machine: no session ids, no excerpts. */
export function weeklyRecord(machine: string, report: { generatedAt: string; window: { since: string }; northStar: { overall: { turns: number; v2: number; v2Per100: number | null; interval?: { low: number; high: number }; sensitivity: { v2Per100: number | null } }[]; models: { key: string; turns: number; v2Per100: number | null }[] }; records: { id: string; status: string }[] }): WeeklyRecord {
	const overall = report.northStar.overall[0];
	return {
		schema: WEEKLY_RECORD_SCHEMA,
		machine,
		generatedAt: report.generatedAt,
		since: report.window.since,
		overall: {
			turns: overall?.turns ?? 0,
			events: overall?.v2 ?? 0,
			per100: overall?.v2Per100 ?? null,
			band: overall?.interval ? [overall.interval.low, overall.interval.high] : null,
			withoutLargestPer100: overall?.sensitivity.v2Per100 ?? null,
		},
		models: report.northStar.models.map((row) => ({ model: row.key, turns: row.turns, per100: row.v2Per100 })),
		acceptance: report.records.map((row) => ({ id: row.id, status: row.status })),
	};
}

export function writeWeeklyRecord(evalsRoot: string, record: WeeklyRecord): string {
	const directory = join(evalsRoot, "loop", "results", "weekly", record.machine);
	mkdirSync(directory, { recursive: true });
	// One file per machine and day: a second run on the same day replaces that day's aggregate.
	const path = join(directory, `${record.generatedAt.slice(0, 10)}.json`);
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`);
	return path;
}

/** The newest committed weekly record of each machine. */
export function latestWeeklyRecords(evalsRoot: string): WeeklyRecord[] {
	const root = join(evalsRoot, "loop", "results", "weekly");
	if (!existsSync(root)) return [];
	return readdirSync(root).sort().flatMap((machine) => {
		const newest = readdirSync(join(root, machine)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().at(-1);
		if (!newest) return [];
		const value = JSON.parse(readFileSync(join(root, machine, newest), "utf8")) as WeeklyRecord;
		if (value.schema !== WEEKLY_RECORD_SCHEMA || value.machine !== machine) throw new Error(`loop/results/weekly/${machine}/${newest}: invalid weekly record`);
		return [value];
	});
}
