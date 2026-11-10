/**
 * Experiment ledger: a JSON array with one entry per optimization attempt, so
 * the loop's history is queryable instead of scattered across narrative
 * reports. (Not JSONL: the public audit treats tracked .jsonl as session data.)
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
 * The whole ledger: `ledger.json` plus every `ledger/*.json` shard, one shard per
 * experiment series, so no file outgrows the staged-file budget. Each file is
 * validated on its own; ids are unique across files; entries come back in date
 * order (stable, so same-day entries keep their file order).
 */
export function readLedger(loopDir: string, repoRoot?: string): LedgerEntry[] {
	const files = [join(loopDir, "ledger.json")];
	const shardDir = join(loopDir, "ledger");
	if (existsSync(shardDir)) {
		for (const name of readdirSync(shardDir).filter((name) => name.endsWith(".json")).sort()) files.push(join(shardDir, name));
	}
	const entries: LedgerEntry[] = [];
	const ids = new Map<string, string>();
	for (const file of files) {
		let parsed: LedgerEntry[];
		try {
			parsed = parseLedger(readFileSync(file, "utf8"), repoRoot);
		} catch (error) {
			throw new Error(`${file}: ${(error as Error).message}`);
		}
		for (const entry of parsed) {
			const previous = ids.get(entry.id);
			if (previous) throw new Error(`${file}: duplicate id ${entry.id} (also in ${previous})`);
			ids.set(entry.id, file);
			entries.push(entry);
		}
	}
	return entries.map((entry, index) => ({ entry, index })).sort((left, right) => left.entry.date.localeCompare(right.entry.date) || left.index - right.index).map(({ entry }) => entry);
}
