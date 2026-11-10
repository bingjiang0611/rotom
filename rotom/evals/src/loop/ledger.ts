/**
 * Experiment ledger: one JSON array per month under `loop/ledger/`, with one
 * entry per optimization attempt, so the loop's history is queryable instead of
 * scattered across narrative reports. (Not JSONL: the public audit treats
 * tracked .jsonl as session data.) Shards keep each file small enough for the
 * staged-file size hook without abbreviating what an entry records.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_SCHEMA = "rotom-loop-ledger/v1";

export const CHANGE_KINDS = ["mechanism", "prompt", "eval", "removal"] as const;
export const DECISIONS = ["shipped", "reverted", "kept-off", "removed", "open"] as const;
export const EVIDENCE_LEVELS = ["improved", "no-difference", "regressed", "inconclusive", "unmeasured", "not-reproduced"] as const;

export type LedgerEntry = {
	schema: typeof LEDGER_SCHEMA;
	id: string;
	date: string;
	title: string;
	hypothesis: string;
	change: (typeof CHANGE_KINDS)[number];
	/** Model, case set and sample size; free text but must be concrete. */
	measurement: string;
	result: string;
	evidence: (typeof EVIDENCE_LEVELS)[number];
	decision: (typeof DECISIONS)[number];
	/** Repository-relative record backing this entry. */
	source: string;
	/**
	 * The acceptance metric of a shipped-but-unmeasured record, in the one form the weekly report
	 * can read: an incident kind counted per 100 user turns after `startedAt`, against the baseline
	 * observed before the change. `metric` is the human name shown in the report and `detail` an
	 * optional `[field, value]` filter on the incident detail.
	 */
	acceptance?: {
		startedAt: string;
		metric: string;
		incident: IncidentKindName;
		detail?: [string, string];
		baselinePer100: number;
		/**
	 * Turns needed before any verdict may be reported: the exposure at which the baseline rate
	 * predicts ten events. It is derived from `baselinePer100`, and the parser refuses a record
	 * that declares anything else, so the exposure is pre-registered rather than chosen later.
	 */
		minimumTurns: number;
		expect: "lower" | "higher";
	};
};

/** Kept as a string list here so the ledger stays free of the harvest's type graph. */
const INCIDENT_KINDS = ["user_correction", "user_repeat", "bare_continue", "user_interrupt", "tool_error_streak", "edit_retry_without_read", "provider_error", "length_stop", "goal_pause", "compaction_failed"] as const;
type IncidentKindName = (typeof INCIDENT_KINDS)[number];

/** Prompt changes ship only with measured improvement from this date on; older entries stay as recorded. */
export const PROMPT_RENT_SINCE = "2026-11-09";

const ID = /^L-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
/**
 * `<YYYY-MM>.json` is the month's shard; `<YYYY-MM>-<slug>.json` is an overflow shard for a
 * month whose single file would exceed the 20 KB staged-file budget. The month prefix still
 * decides which dates the file may hold.
 */
const SHARD = /^(\d{4}-\d{2})(?:-[a-z0-9-]+)?\.json$/u;

/**
 * Turns at which the baseline rate predicts ten events: `rate/100 × turns = 10`. Below it, a run of
 * zero events is unremarkable, so reporting "no change" or "improved" would be noise dressed up as
 * a finding.
 */
export function exposureTurns(baselinePer100: number): number {
	return Math.ceil(1000 / baselinePer100);
}

/** A shard file name is the month its entries must fall in. */export function shardFile(month: string): string {
	if (!/^\d{4}-\d{2}$/u.test(month)) throw new Error(`ledger: month must look like YYYY-MM, got ${month}`);
	return `${month}.json`;
}

/** The acceptance spec is validated here because the weekly report reads it without a second check. */
function validateAcceptance(where: string, raw: unknown): void {
	if (typeof raw !== "object" || raw === null) throw new Error(`${where}: acceptance must be an object`);
	const value = raw as Record<string, unknown>;
	if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) throw new Error(`${where}: acceptance.startedAt must be an ISO timestamp`);
	if (typeof value.metric !== "string" || !value.metric.trim()) throw new Error(`${where}: acceptance.metric is required`);
	if (!INCIDENT_KINDS.includes(value.incident as never)) throw new Error(`${where}: acceptance.incident must be one of ${INCIDENT_KINDS.join(", ")}`);
	if (value.detail !== undefined) {
		const detail = value.detail;
		if (!Array.isArray(detail) || detail.length !== 2 || detail.some((item) => typeof item !== "string")) throw new Error(`${where}: acceptance.detail must be [field, value]`);
	}
	if (typeof value.baselinePer100 !== "number" || !Number.isFinite(value.baselinePer100) || value.baselinePer100 <= 0) {
		// A zero baseline can never predict ten events, so no amount of turns would license a verdict.
		throw new Error(`${where}: acceptance.baselinePer100 must be a positive number (a zero baseline has no reachable exposure)`);
	}
	const minimumTurns = exposureTurns(value.baselinePer100);
	if (value.minimumTurns !== minimumTurns) throw new Error(`${where}: acceptance.minimumTurns must be ${minimumTurns}, the exposure implied by baselinePer100 ${value.baselinePer100}`);
	if (value.expect !== "lower" && value.expect !== "higher") throw new Error(`${where}: acceptance.expect must be lower or higher`);
}

export function parseLedger(text: string, repoRoot?: string): LedgerEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("ledger: invalid JSON");
	}
	if (!Array.isArray(parsed)) throw new Error("ledger: expected a JSON array");
	const entries: LedgerEntry[] = [];
	const ids = new Set<string>();
	for (const [index, raw] of parsed.entries()) {
		const where = `ledger entry ${index + 1}`;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
		const value = raw as Partial<LedgerEntry>;
		if (value.schema !== LEDGER_SCHEMA) throw new Error(`${where}: schema must be ${LEDGER_SCHEMA}`);
		if (typeof value.id !== "string" || !ID.test(value.id)) throw new Error(`${where}: id must look like L-YYYY-MM-DD-slug`);
		if (ids.has(value.id)) throw new Error(`${where}: duplicate id ${value.id}`);
		if (typeof value.date !== "string" || !DATE.test(value.date) || !value.id.startsWith(`L-${value.date}-`)) throw new Error(`${where}: date must be YYYY-MM-DD and match the id`);
		for (const field of ["title", "hypothesis", "measurement", "result", "source"] as const) {
			if (typeof value[field] !== "string" || !(value[field] as string).trim()) throw new Error(`${where}: ${field} is required`);
		}
		if (!CHANGE_KINDS.includes(value.change as never)) throw new Error(`${where}: change must be one of ${CHANGE_KINDS.join(", ")}`);
		if (!EVIDENCE_LEVELS.includes(value.evidence as never)) throw new Error(`${where}: evidence must be one of ${EVIDENCE_LEVELS.join(", ")}`);
		if (!DECISIONS.includes(value.decision as never)) throw new Error(`${where}: decision must be one of ${DECISIONS.join(", ")}`);
		if (value.date >= PROMPT_RENT_SINCE && value.decision === "shipped" && value.change === "prompt" && value.evidence !== "improved") {
			throw new Error(`${where}: since ${PROMPT_RENT_SINCE} a shipped prompt change needs evidence "improved"`);
		}
		if (repoRoot && !existsSync(join(repoRoot, (value.source as string).split("#")[0]))) throw new Error(`${where}: source ${value.source} does not exist`);
		if (value.acceptance !== undefined) validateAcceptance(where, value.acceptance);
		ids.add(value.id);
		entries.push(value as LedgerEntry);
	}
	return entries;
}

/**
 * Validate every shard and return the entries in month order. A duplicate id
 * across two shards is rejected here, because each shard only guards itself.
 */
export function parseLedgerDir(directory: string, repoRoot?: string): LedgerEntry[] {
	const shards = readdirSync(directory).filter((name) => SHARD.test(name)).sort();
	if (shards.length === 0) throw new Error(`ledger: no shards in ${directory}`);
	const entries: LedgerEntry[] = [];
	const seen = new Map<string, string>();
	for (const shard of shards) {
		const month = SHARD.exec(shard)?.[1];
		const parsed = parseLedger(readFileSync(join(directory, shard), "utf8"), repoRoot);
		for (const entry of parsed) {
			// Duplicate first: one id in two shards is the more precise diagnosis, and a shard
			// holding a foreign month would otherwise report the date rule instead.
			const previous = seen.get(entry.id);
			if (previous) throw new Error(`${shard}: duplicate id ${entry.id} (already in ${previous})`);
			seen.set(entry.id, shard);
			if (!entry.date.startsWith(`${month}-`)) throw new Error(`${shard}: ${entry.id} is dated ${entry.date}`);
		}
		entries.push(...parsed);
	}
	// Shard file names sort by month, but an overflow shard ("2026-11-x.json") sorts before its
	// own month ("2026-11.json"), so the merged list is sorted by date to stay chronological.
	return entries.sort((left, right) => left.date.localeCompare(right.date));
}
