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
};

/** Prompt changes ship only with measured improvement from this date on; older entries stay as recorded. */
export const PROMPT_RENT_SINCE = "2026-11-09";

const ID = /^L-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
// `2026-11.json`, or `2026-11-<series>.json` when one month outgrows the staged-file budget.
const SHARD = /^(\d{4}-\d{2})(?:-[a-z][a-z0-9-]*)?\.json$/u;

/** A shard file name is the month its entries must fall in. */
export function shardFile(month: string): string {
	if (!/^\d{4}-\d{2}$/u.test(month)) throw new Error(`ledger: month must look like YYYY-MM, got ${month}`);
	return `${month}.json`;
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
		ids.add(value.id);
		entries.push(value as LedgerEntry);
	}
	return entries;
}

/**
 * Validate every shard and return the entries in date order. A duplicate id
 * across two shards is rejected here, because each shard only guards itself.
 */
export function parseLedgerDir(directory: string, repoRoot?: string): LedgerEntry[] {
	const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
	// A JSON file the shard rule does not name would otherwise be skipped without a word.
	const stray = files.find((name) => !SHARD.test(name));
	if (stray) throw new Error(`ledger: ${stray} is not named YYYY-MM.json or YYYY-MM-<series>.json`);
	const shards = files;
	if (shards.length === 0) throw new Error(`ledger: no shards in ${directory}`);
	const entries: LedgerEntry[] = [];
	const seen = new Map<string, string>();
	for (const shard of shards) {
		const month = SHARD.exec(shard)![1];
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
	// A month split across a series shard is read file by file, so restore date order (stable).
	return entries.map((entry, index) => ({ entry, index })).sort((left, right) => left.entry.date.localeCompare(right.entry.date) || left.index - right.index).map(({ entry }) => entry);
}
