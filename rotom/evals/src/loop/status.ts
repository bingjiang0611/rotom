/**
 * `loop status`: the four numbers the loop is operated by, on one screen, from files that
 * already exist. It runs nothing and calls no model.
 *
 * Every number is a process indicator: how large the case set is, how much shipped work is
 * still unverified, how long since the loop last ran. None of them says the agent got better.
 * A missing input prints as "no record", never as zero, because "never measured" and
 * "measured nothing" call for different next steps.
 */
import type { FrozenBaseline } from "./freeze.ts";
import { effectiveModel, type GateCase, type GateManifest } from "./gate.ts";
import type { GateHistoryRecord } from "./gate-history.ts";
import type { LedgerEntry } from "./ledger.ts";

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The few fields of a weekly `summary.json` this screen reads. */
export type WeeklySnapshot = { generatedAt: string; turns: number | null; per100: number | null; records: { id: string; status: string }[] };

/** Statuses where the weekly report reached a verdict, so the ledger entry can be updated. */
const VERDICTS = new Set(["improved", "no-change", "worse", "uncertain", "budget-met", "budget-exceeded"]);

/** Reads a weekly summary leniently: an unreadable file is "no record", not a crash. */
export function parseWeeklySnapshot(text: string): WeeklySnapshot | undefined {
	let value: { generatedAt?: unknown; northStar?: { overall?: { turns?: unknown; v2Per100?: unknown }[] }; records?: { id?: unknown; status?: unknown }[] };
	try {
		value = JSON.parse(text) as typeof value;
	} catch {
		return undefined;
	}
	if (typeof value?.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) return undefined;
	const overall = value.northStar?.overall?.[0];
	return {
		generatedAt: value.generatedAt,
		turns: typeof overall?.turns === "number" ? overall.turns : null,
		per100: typeof overall?.v2Per100 === "number" ? overall.v2Per100 : null,
		records: (Array.isArray(value.records) ? value.records : []).flatMap((row) => (typeof row?.id === "string" && typeof row.status === "string" ? [{ id: row.id, status: row.status }] : [])),
	};
}

export type CaseRow = {
	caseId: string;
	kind: "climb" | "keep" | "holdout";
	variantOf?: string;
	/** Recorded reproduction per model, as the manifest states it. */
	recorded: string[];
	last: { date: string; verdict: string; pairs: number; baselinePass: number; candidatePass: number } | null;
	/** Every recorded sample of this case, across candidate commits: a volume, not a verdict. */
	pooled: { runs: number; pairs: number; baselineFail: number; candidateFail: number } | null;
};

export type StatusReport = {
	date: string;
	weeklyDay: Weekday | null;
	intervention: { per100: number | null; turns: number | null; reportDate: string } | null;
	climb: { total: number; proven: number; flaky: number };
	keep: number;
	holdout: number;
	replays: number;
	unverified: { total: number; withoutMetric: number };
	daysSinceGate: number | null;
	daysSinceWeekly: number | null;
	baseline: { sha: string; ref: string } | null;
	cases: CaseRow[];
	ready: { id: string; status: string }[];
	next: string[];
};

const kindOf = (item: GateCase): CaseRow["kind"] => (item.split === "holdout" ? "holdout" : item.role === "reproduced" ? "climb" : "keep");

function daysBetween(earlier: string | undefined, now: Date): number | null {
	if (!earlier) return null;
	const time = Date.parse(earlier);
	return Number.isNaN(time) ? null : Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
}

export function buildStatus(input: {
	manifest: GateManifest;
	/** `undefined` when no gate ever recorded a sample on this machine. */
	history: readonly GateHistoryRecord[] | undefined;
	ledger: readonly LedgerEntry[];
	weekly: WeeklySnapshot | undefined;
	weeklyDay?: Weekday;
	frozen?: Pick<FrozenBaseline, "sha" | "ref">;
	now: Date;
}): StatusReport {
	const { manifest, history, ledger, weekly, now } = input;
	const cases: CaseRow[] = manifest.cases.map((item) => {
		// Samples from another model are not evidence about the model this case runs on now, so
		// a case that switched model starts its "last run" and "all runs" again.
		const model = effectiveModel(item, manifest);
		const samples = (history ?? [])
			.filter((record) => record.caseId === item.caseId && record.model.provider === model.provider && record.model.model === model.model)
			.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
		const last = samples.at(-1);
		const pairs = samples.reduce((sum, record) => sum + record.pairs, 0);
		return {
			caseId: item.caseId,
			kind: kindOf(item),
			...(item.variantOf ? { variantOf: item.variantOf } : {}),
			recorded: (item.reproduction ?? []).map((record) => `${record.model}=${record.verdict}`),
			last: last ? { date: last.recordedAt.slice(0, 10), verdict: last.verdict, pairs: last.pairs, baselinePass: last.baselinePass, candidatePass: last.candidatePass } : null,
			pooled: samples.length > 0
				? { runs: samples.length, pairs, baselineFail: pairs - samples.reduce((sum, record) => sum + record.baselinePass, 0), candidateFail: pairs - samples.reduce((sum, record) => sum + record.candidatePass, 0) }
				: null,
		};
	});
	const climbCases = manifest.cases.filter((item) => kindOf(item) === "climb");
	// Only the record for the model the case actually runs on counts: a case reproduced on a model
	// the loop no longer uses discriminates nothing in today's gate.
	const has = (item: GateCase, verdict: string) => {
		const model = effectiveModel(item, manifest);
		return (item.reproduction ?? []).some((record) => record.model === `${model.provider}/${model.model}` && record.verdict === verdict);
	};
	const proven = climbCases.filter((item) => has(item, "reproduced")).length;
	const flaky = climbCases.filter((item) => !has(item, "reproduced") && has(item, "flaky-candidate")).length;
	const unverified = ledger.filter((entry) => entry.change === "mechanism" && entry.decision === "shipped" && entry.evidence === "unmeasured");
	const ready = (weekly?.records ?? []).filter((row) => VERDICTS.has(row.status));
	const daysSinceGate = daysBetween((history ?? []).map((record) => record.recordedAt).sort().at(-1), now);
	const daysSinceWeekly = daysBetween(weekly?.generatedAt, now);

	const next: string[] = [];
	if (daysSinceWeekly === null) next.push("run `loop weekly`: no weekly report has been written on this machine");
	else if (daysSinceWeekly >= 7) next.push(`run \`loop weekly\`: the last report is ${daysSinceWeekly} days old`);
	if (ready.length > 0) next.push(`update the ledger for ${ready.length} record(s) the weekly report reached a verdict on`);
	if (proven === 0) next.push("no climb case discriminates on the model it runs on: triage the harvest queue for one reproducible failure");
	if (!input.frozen) next.push("run `loop freeze <release commit>` so `loop gate` has a baseline");
	for (const row of cases) if (row.kind === "holdout" && !row.pooled) next.push(`holdout ${row.caseId} has never run: pass \`--holdout\` at the next judging round`);
	if (next.length === 0) next.push("nothing is due");

	return {
		date: now.toISOString().slice(0, 10),
		weeklyDay: input.weeklyDay ?? null,
		intervention: weekly ? { per100: weekly.per100, turns: weekly.turns, reportDate: weekly.generatedAt.slice(0, 10) } : null,
		climb: { total: climbCases.length, proven, flaky },
		keep: cases.filter((row) => row.kind === "keep").length,
		holdout: cases.filter((row) => row.kind === "holdout").length,
		replays: manifest.replays?.length ?? 0,
		unverified: { total: unverified.length, withoutMetric: unverified.filter((entry) => entry.acceptance === undefined).length },
		daysSinceGate,
		daysSinceWeekly,
		baseline: input.frozen ? { sha: input.frozen.sha, ref: input.frozen.ref } : null,
		cases,
		ready,
		next,
	};
}

const NONE = "no record";

export function renderStatus(report: StatusReport): string {
	const days = (value: number | null) => (value === null ? NONE : String(value));
	const intervention = report.intervention
		? `${report.intervention.per100 ?? "N/A"} (${report.intervention.turns ?? "N/A"} turns, weekly report ${report.intervention.reportDate})`
		: NONE;
	const lines = [
		`rotom loop status · ${report.date}${report.weeklyDay ? ` · weekly day ${report.weeklyDay}` : ""}`,
		"",
		`  interventions per 100 user turns            ${intervention}`,
		`  climb cases that discriminate (own model)   ${report.climb.proven} of ${report.climb.total}${report.climb.flaky ? ` (${report.climb.flaky} flaky-candidate)` : ""}`,
		`  shipped mechanism records not yet verified  ${report.unverified.total} (${report.unverified.withoutMetric} declare no acceptance metric)`,
		`  days since last gate / weekly               ${days(report.daysSinceGate)} / ${days(report.daysSinceWeekly)}`,
		"",
		`Case set: climb ${report.climb.total} · keep ${report.keep} · holdout ${report.holdout} · private replays ${report.replays} · baseline ${report.baseline ? `${report.baseline.sha.slice(0, 12)} (${report.baseline.ref})` : "none frozen"}`,
	];
	for (const row of report.cases) {
		// A holdout's last run is read as candidate against baseline, the way `gate` prints it.
		const verdict = (last: NonNullable<CaseRow["last"]>) => (row.kind === "holdout" ? (last.candidatePass > last.baselinePass ? "generalizes" : last.candidatePass === last.baselinePass ? "no-difference" : "worse") : last.verdict);
		lines.push(`  ${row.kind.padEnd(8)} ${row.caseId}${row.variantOf ? ` (restates ${row.variantOf})` : ""}`);
		lines.push(`           recorded  ${row.recorded.join(" ") || NONE}`);
		lines.push(`           last run  ${row.last ? `${row.last.date} ${verdict(row.last)}, baseline ${row.last.baselinePass}/${row.last.pairs}, candidate ${row.last.candidatePass}/${row.last.pairs}` : NONE}`);
		if (row.pooled) lines.push(`           all runs  ${row.pooled.runs} runs, ${row.pooled.pairs} pairs, baseline failed ${row.pooled.baselineFail}, candidate failed ${row.pooled.candidateFail}`);
	}
	if (report.ready.length > 0) {
		lines.push("", "Acceptance verdicts ready");
		for (const row of report.ready) lines.push(`  ${row.status.padEnd(15)} ${row.id}`);
	}
	lines.push("", "Next", ...report.next.map((line) => `  - ${line}`), "", "Process indicators only; \"all runs\" spans every candidate commit and is not a verdict.");
	return `${lines.join("\n")}\n`;
}
