/**
 * Weekly report: one command that answers "what does the metric say this week" without hand
 * assembling the harvest artifacts. Four sections, each with its own rule about what may be
 * printed:
 *
 * 1. North star v2 overall, per model and per product version, each with a 95% Poisson band and
 *    the same rate recomputed without the single session that carried the most v2 events.
 * 2. The default-model field comparison, counted only: session counts and adherence per arm. The
 *    blinded section deliberately has no field for an outcome metric, so an in-window report
 *    cannot leak one; the verdict is read after the window closes.
 * 3. Every shipped-but-unmeasured ledger record, against the acceptance metric it declared and
 *    the baseline it recorded, using only sessions that started after its acceptance start.
 * 4. Provider-to-user failures per 100 turns per provider, split before and after the version
 *    switch, because a new runtime mid-week changes the failure profile.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dimensionRates, type RateInterval } from "./harvest-breakdown.ts";
import { DEFAULT_MODEL_BY_PARITY, dimensionRatesWithoutLargestSession, dominantModel, type PeakAdjustedRate } from "./harvest-models.ts";
import type { Incident, SessionSummary } from "./harvest.ts";
import type { LedgerEntry } from "./ledger.ts";
import { acceptanceRows, poissonBand, type AcceptanceRow } from "./weekly-acceptance.ts";

export { acceptanceRows, recentTurnsPerDay, type AcceptanceRow, type AcceptanceStatus } from "./weekly-acceptance.ts";

export const WEEKLY_SCHEMA = "rotom-loop-weekly/v1";

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export type WeeklyConfig = {
	/** ISO instant the daily install switched product builds; splits the provider table. */
	switchAt: string;
	experiment: { /** First local day inside the field comparison, inclusive. */ start: string; /** Last local day, inclusive. */ end: string };
};

/** The window is written as local dates: a session records its own local start, not UTC. */
export function parseWeeklyConfig(text: string): WeeklyConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("weekly config: invalid JSON");
	}
	const value = parsed as Partial<WeeklyConfig>;
	if (typeof value.switchAt !== "string" || Number.isNaN(Date.parse(value.switchAt))) throw new Error("weekly config: switchAt must be an ISO timestamp");
	const experiment = value.experiment as Partial<WeeklyConfig["experiment"]> | undefined;
	if (!experiment || typeof experiment.start !== "string" || typeof experiment.end !== "string" || !DATE.test(experiment.start) || !DATE.test(experiment.end)) {
		throw new Error("weekly config: experiment.start and experiment.end must be YYYY-MM-DD");
	}
	if (experiment.end < experiment.start) throw new Error("weekly config: experiment.end is before experiment.start");
	// The arms are the parity defaults themselves, so the config cannot disagree with the metric.
	return { switchAt: value.switchAt, experiment: { start: experiment.start, end: experiment.end } };
}

export type RateRow = {
	key: string;
	turns: number;
	v2: number;
	v2Per100: number | null;
	interval?: RateInterval;
	/** The same rate with this key's largest v2 session removed; `null` when that session had none. */
	sensitivity: { v2Per100: number | null; droppedSessionId: string | null };
};

const per100 = (count: number, turns: number) => (turns > 0 ? Math.round((count / turns) * 1000) / 10 : null);

function rateRows(rows: ReturnType<typeof dimensionRates>, without: Map<string, PeakAdjustedRate>): RateRow[] {
	return rows.map((row) => {
		const adjusted = without.get(row.key);
		return {
			key: row.key,
			turns: row.turns,
			v2: row.northStarV2,
			v2Per100: row.v2Per100,
			...(row.v2Interval ? { interval: row.v2Interval } : {}),
			sensitivity: { v2Per100: adjusted?.v2Per100 ?? null, droppedSessionId: adjusted?.droppedSessionId ?? null },
		};
	});
}

/** Overall, per model (whole session attributed to its dominant model) and per product version. */
export function northStarTables(sessions: readonly SessionSummary[]): { overall: RateRow[]; models: RateRow[]; products: RateRow[]; entries: RateRow[] } {
	const all = () => "all";
	const model = (session: SessionSummary) => dominantModel(session);
	const product = (session: SessionSummary) => session.productVersion;
	// Which entry started the session, not which version it happened to print: an install, a
	// development checkout, or a trace old enough to carry no launcher record.
	const entry = (session: SessionSummary) => session.entry;
	return {
		overall: rateRows(dimensionRates(sessions, all), dimensionRatesWithoutLargestSession(sessions, all)),
		models: rateRows(dimensionRates(sessions, model), dimensionRatesWithoutLargestSession(sessions, model)),
		products: rateRows(dimensionRates(sessions, product), dimensionRatesWithoutLargestSession(sessions, product)),
		entries: rateRows(dimensionRates(sessions, entry), dimensionRatesWithoutLargestSession(sessions, entry)),
	};
}

/** Counts and adherence only: the shape itself is the blinding, not a formatting choice. */
export type BlindedArm = { arm: string; sessions: number; adherence: number | null };
export type BlindedExperiment = { state: "open" | "closed"; start: string; end: string; arms: BlindedArm[]; excluded: { switched: number; offDefault: number } };

export function blindedExperiment(sessions: readonly SessionSummary[], experiment: WeeklyConfig["experiment"], today = new Date()): BlindedExperiment {
	const arms = [DEFAULT_MODEL_BY_PARITY.odd, DEFAULT_MODEL_BY_PARITY.even].map((arm) => ({ arm, sessions: 0, eligible: 0 }));
	const excluded = { switched: 0, offDefault: 0 };
	for (const session of sessions) {
		const day = session.startedAt.slice(0, 10);
		if (day < experiment.start || day > experiment.end) continue;
		// Odd local days default to one arm and even days to the other, as the experiment defines it.
		const dayNumber = Number(day.slice(8, 10));
		const arm = arms[dayNumber % 2 === 1 ? 0 : 1];
		if (!arm) continue;
		arm.eligible += 1;
		if (!session.firstAssistantModel) {
			excluded.offDefault += 1;
			continue;
		}
		if (session.firstAssistantModel !== arm.arm) {
			excluded.offDefault += 1;
			continue;
		}
		arm.sessions += 1;
		if (session.models.length > 1) excluded.switched += 1;
	}
	return {
		state: today.toISOString().slice(0, 10) > experiment.end ? "closed" : "open",
		start: experiment.start,
		end: experiment.end,
		arms: arms.map(({ arm, sessions: counted, eligible }) => ({ arm, sessions: counted, adherence: eligible > 0 ? Math.round((counted / eligible) * 1000) / 1000 : null })),
		excluded,
	};
}


export type ProviderSegmentRow = {
	segment: "before" | "after";
	provider: string;
	turns: number;
	failures: number;
	per100: number | null;
	interval?: RateInterval;
};

/**
 * Failures the user actually saw: a `provider_error` incident that no later usable answer closed
 * (`recovered` unset), counted against the turns that provider answered. A turn is attributed
 * through the session's model turns, so a session that switched providers splits between them.
 * This is the same predicate the harvest's provider table uses; a test pins the two together.
 */
export function providerSegments(sessions: readonly SessionSummary[], incidents: readonly Incident[], switchAt: string): ProviderSegmentRow[] {
	const switchTime = Date.parse(switchAt);
	const rows = new Map<string, { segment: "before" | "after"; provider: string; turns: number; failures: number }>();
	const key = (segment: "before" | "after", provider: string) => `${segment}\u0000${provider}`;
	// A failure belongs to the segment its session started in: segmenting the numerator by the
	// incident time and the denominator by the session start would list failures against zero turns.
	const segmentOf = new Map<string, "before" | "after">();
	for (const session of sessions) {
		const segment = Date.parse(session.startedAt) >= switchTime ? "after" : "before";
		segmentOf.set(session.sessionId, segment);
		for (const [model, turns] of Object.entries(session.modelTurns)) {
			const provider = model.split("/")[0] ?? "unknown";
			const id = key(segment, provider);
			const row = rows.get(id) ?? { segment, provider, turns: 0, failures: 0 };
			row.turns += turns;
			rows.set(id, row);
		}
	}
	for (const incident of incidents) {
		if (incident.kind !== "provider_error" || incident.detail.recovered === true) continue;
		const segment = segmentOf.get(incident.sessionId);
		if (!segment) continue;
		const provider = String(incident.detail.provider ?? "unknown");
		const id = key(segment, provider);
		const row = rows.get(id) ?? { segment, provider, turns: 0, failures: 0 };
		row.failures += 1;
		rows.set(id, row);
	}
	return [...rows.values()]
		.map((row) => ({ ...row, per100: per100(row.failures, row.turns), ...(poissonBand(row.failures, row.turns) ? { interval: poissonBand(row.failures, row.turns) } : {}) }))
		.sort((left, right) => left.segment.localeCompare(right.segment) || right.turns - left.turns);
}

const band = (interval: RateInterval | undefined) => (interval ? `${interval.low}–${interval.high}` : "N/A");

export type WeeklyReport = {
	generatedAt: string;
	window: { since: string };
	config: WeeklyConfig;
	northStar: ReturnType<typeof northStarTables>;
	experiment: BlindedExperiment;
	records: AcceptanceRow[];
	providerFailures: ProviderSegmentRow[];
};

export function buildWeekly(input: { sessions: readonly SessionSummary[]; incidents: readonly Incident[]; ledger: readonly LedgerEntry[]; config: WeeklyConfig; since: string; now?: Date; ranWithFix?: (session: SessionSummary, firstCommit: string) => boolean }): WeeklyReport {
	const now = input.now ?? new Date();
	return {
		generatedAt: now.toISOString(),
		window: { since: input.since },
		config: input.config,
		northStar: northStarTables(input.sessions),
		experiment: blindedExperiment(input.sessions, input.config.experiment, now),
		records: acceptanceRows(input.ledger, input.sessions, input.incidents, now, input.ranWithFix),
		providerFailures: providerSegments(input.sessions, input.incidents, input.config.switchAt),
	};
}

const rateTable = (rows: readonly RateRow[], dimension: string) => [
	`| ${dimension} | User turns | v2 | v2 per 100 | v2 95% band | without its largest session |`,
	"| --- | ---: | ---: | ---: | --- | ---: |",
	...rows.map((row) => `| ${row.key} | ${row.turns} | ${row.v2} | ${row.v2Per100 ?? "N/A"} | ${band(row.interval)} | ${row.sensitivity.v2Per100 ?? "N/A"}${row.sensitivity.droppedSessionId ? ` (\`${row.sensitivity.droppedSessionId.slice(0, 8)}\`)` : ""} |`),
	"",
];

export function renderWeekly(report: WeeklyReport): string {
	const open = report.experiment.state === "open";
	return [
		"# rotom weekly report",
		"",
		`Generated ${report.generatedAt} · sessions since ${report.window.since} · switch at ${report.config.switchAt}`,
		"",
		"Local, private output. Rates are per 100 user turns with a 95% Poisson band: a rough sampling band, not a confidence statement.",
		"",
		"## North star v2",
		"",
		"### Overall",
		"",
		...rateTable(report.northStar.overall, "Scope"),
		"### Per model",
		"",
		"Each session is attributed to the model that answered most of its turns.",
		"",
		...rateTable(report.northStar.models, "Model"),
		"### Per product version",
		"",
		"Only sessions whose trace recorded the product version they ran.",
		"",
		...rateTable(report.northStar.products, "Product version"),
		"",
		"### Entry",
		"",
		...rateTable(report.northStar.entries, "Entry"),
		"## Field comparison: default model by date parity",
		"",
		open
			? `Blinded until ${report.experiment.end}: this section shows how many sessions each arm got and how often the day's default actually applied. Outcome metrics stay out of the report until the window closes, so nothing here can be read as a result.`
			: `The window closed after ${report.experiment.end}. The verdict is read from \`L-2026-11-10-default-model-field-comparison\` with the pre-registered rule, not from this section.`,
		"",
		"| Arm | Sessions | Adherence |",
		"| --- | ---: | ---: |",
		...report.experiment.arms.map((arm) => `| ${arm.arm} | ${arm.sessions} | ${arm.adherence === null ? "N/A" : `${Math.round(arm.adherence * 1000) / 10}%`} |`),
		"",
		`Excluded inside the window: ${report.experiment.excluded.switched} started on the default and switched model, ${report.experiment.excluded.offDefault} never used it.`,
		"",
		"## Shipped records still waiting for evidence",
		"",
		"`decision=shipped` with `evidence=unmeasured`. Status uses only sessions that started after the record's own acceptance start. Below the record's exposure (the turns where its baseline predicts ten events) the status is `insufficient-exposure` and no verdict is offered; at or above it the verdict is an exact one-sided Poisson rate test at alpha 0.05, and `no-change` means only that no difference was shown.",
		"",
		"| Record | Metric | Turns | Exposure | Days to exposure | Observed per 100 | Baseline per 100 | Status | Note |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
		...(report.records.length
			? report.records.map((row) => `| \`${row.id.replace(/^L-\d{4}-\d{2}-\d{2}-/u, "")}\` | ${row.metric ?? "—"} | ${row.turns} | ${row.minimumTurns ?? "—"} | ${row.daysToExposure ?? "—"} | ${row.observedPer100 ?? "N/A"} | ${row.baselinePer100 ?? "N/A"} | ${row.status} | ${row.note} |`)
			: ["| none | — | 0 | N/A | N/A | — | every shipped record carries measured evidence |"]),
		"",
		"## Provider failures per 100 turns, before and after the switch",
		"",
		"Counted only when the failure reached the user (never closed by a usable answer), against the turns that provider answered. The harvest's provider table counts the same incidents; its `recovered` column is the complement.",
		"",
		"| Segment | Provider | Turns | User-visible failures | Per 100 turns | 95% band |",
		"| --- | --- | ---: | ---: | ---: | --- |",
		...(report.providerFailures.length
			? report.providerFailures.map((row) => `| ${row.segment} | ${row.provider} | ${row.turns} | ${row.failures} | ${row.per100 ?? "N/A"} | ${band(row.interval)} |`)
			: ["| — | none | 0 | 0 | N/A | N/A |"]),
		"",
	].join("\n");
}

/** Writes `weekly-<YYYY-MM-DD>/` under the private loop directory and returns it. */
export async function writeWeekly(outRoot: string, report: WeeklyReport): Promise<string> {
	const { mkdir, lstat } = await import("node:fs/promises");
	const directory = join(outRoot, `weekly-${report.generatedAt.slice(0, 10)}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing non-directory or symlink output: ${directory}`);
	await writeFile(join(directory, "report.md"), renderWeekly(report), { mode: 0o600 });
	await writeFile(join(directory, "summary.json"), `${JSON.stringify({ schema: WEEKLY_SCHEMA, ...report }, null, 2)}\n`, { mode: 0o600 });
	return directory;
}
