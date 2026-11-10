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
import { RATE_TEST_ALPHA, rateTest } from "./poisson-test.ts";

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
export function northStarTables(sessions: readonly SessionSummary[]): { overall: RateRow[]; models: RateRow[]; products: RateRow[] } {
	const all = () => "all";
	const model = (session: SessionSummary) => dominantModel(session);
	const product = (session: SessionSummary) => session.productVersion;
	return {
		overall: rateRows(dimensionRates(sessions, all), dimensionRatesWithoutLargestSession(sessions, all)),
		models: rateRows(dimensionRates(sessions, model), dimensionRatesWithoutLargestSession(sessions, model)),
		products: rateRows(dimensionRates(sessions, product), dimensionRatesWithoutLargestSession(sessions, product)),
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

export type AcceptanceStatus = "improved" | "no-change" | "worse" | "insufficient-exposure" | "no-metric";

export type AcceptanceRow = {
	id: string;
	title: string;
	status: AcceptanceStatus;
	/** What was counted, e.g. `provider_error where category=429`. */
	metric: string | null;
	turns: number;
	observedPer100: number | null;
	baselinePer100: number | null;
	interval?: RateInterval;
	/** Turns the record declared as its exposure: where the baseline predicts ten events. */
	minimumTurns: number | null;
	/** Days of recent traffic that exposure still needs, at the last seven days' average. */
	daysToExposure: number | null;
	note: string;
};

/** Turns per day over the trailing week, so an exposure requirement reads as days, not abstraction. */
export function recentTurnsPerDay(sessions: readonly SessionSummary[], now = new Date(), days = 7): number {
	const since = now.getTime() - days * 24 * 60 * 60 * 1000;
	const turns = sessions.filter((session) => Date.parse(session.startedAt) >= since).reduce((sum, session) => sum + session.userTurns, 0);
	return turns / days;
}

/**
 * Only data after the record's own acceptance start counts. Below the record's declared exposure
 * the row is `insufficient-exposure` (暴露不足): a run of zero events there is what the baseline
 * predicts, so calling it "no change" or "improved" would dress noise up as a finding.
 *
 * At or above the exposure, the verdict is an exact one-sided Poisson rate test against the
 * baseline rate (`rateTest`, alpha 0.05). Below the alpha the row is `improved` or `worse` in the
 * declared direction; otherwise `no-change`, which means "not shown to differ" and nothing more.
 */
export function acceptanceRows(ledger: readonly LedgerEntry[], sessions: readonly SessionSummary[], incidents: readonly Incident[], now = new Date()): AcceptanceRow[] {
	const turnsPerDay = recentTurnsPerDay(sessions, now);
	const daysFor = (minimumTurns: number, turns: number) => {
		if (turns >= minimumTurns) return 0;
		if (turnsPerDay <= 0) return null;
		return Math.ceil((minimumTurns - turns) / turnsPerDay);
	};
	return ledger
		.filter((entry) => entry.decision === "shipped" && entry.evidence === "unmeasured")
		.map((entry) => {
			const acceptance = entry.acceptance;
			if (!acceptance) {
				return { id: entry.id, title: entry.title, status: "no-metric" as const, metric: null, turns: 0, observedPer100: null, baselinePer100: null, minimumTurns: null, daysToExposure: null, note: "the entry declares no harvest-measurable acceptance metric; its evidence is a gate or eval result" };
			}
			if (new Date(acceptance.startedAt).getTime() > now.getTime()) {
				return { id: entry.id, title: entry.title, status: "insufficient-exposure" as const, metric: acceptance.metric, turns: 0, observedPer100: null, baselinePer100: acceptance.baselinePer100, minimumTurns: acceptance.minimumTurns, daysToExposure: daysFor(acceptance.minimumTurns, 0), note: `acceptance window opens ${acceptance.startedAt}; exposure needs ${acceptance.minimumTurns} turns` };
			}
			const since = Date.parse(acceptance.startedAt);
			const counted = sessions.filter((session) => Date.parse(session.startedAt) >= since);
			const turns = counted.reduce((sum, session) => sum + session.userTurns, 0);
			// Both sides of the rate must come from the same period: an incident recorded before the
			// fix shipped belongs to the baseline, not to the observed rate.
			const matching = incidents.filter((incident) => {
				if (incident.kind !== acceptance.incident) return false;
				if (Date.parse(incident.timestamp) < since) return false;
				const [key, value] = acceptance.detail ?? [];
				return key === undefined || String(incident.detail[key]) === value;
			});
			const observed = per100(matching.length, turns);
			const interval = poissonBand(matching.length, turns);
			const base = { id: entry.id, title: entry.title, metric: acceptance.metric, turns, observedPer100: observed, baselinePer100: acceptance.baselinePer100, minimumTurns: acceptance.minimumTurns, daysToExposure: daysFor(acceptance.minimumTurns, turns), ...(interval ? { interval } : {}) };
			if (turns < acceptance.minimumTurns) {
				const days = base.daysToExposure;
				return { ...base, status: "insufficient-exposure" as const, note: `${turns} of ${acceptance.minimumTurns} turns since ${acceptance.startedAt}${days === null ? "" : `, about ${days} more days at the last week's rate`}` };
			}
			const test = rateTest({ observed: matching.length, turns, baselinePer100: acceptance.baselinePer100, expect: acceptance.expect });
			const exposure = `${matching.length} events against ${Number(test.expectedEvents.toFixed(1))} expected`;
			return {
				...base,
				status: test.verdict,
				note: `${exposure}; one-sided exact Poisson p=${Number(test.pValue.toFixed(4))} (alpha ${RATE_TEST_ALPHA}) → ${test.verdict}`,
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

function poissonBand(count: number, turns: number): RateInterval | undefined {
	if (turns <= 0) return undefined;
	const rate = count / turns;
	const spread = (1.96 * Math.sqrt(count)) / turns;
	return { low: Math.max(0, Math.round((rate - spread) * 1000) / 10), high: Math.round((rate + spread) * 1000) / 10 };
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

export function buildWeekly(input: { sessions: readonly SessionSummary[]; incidents: readonly Incident[]; ledger: readonly LedgerEntry[]; config: WeeklyConfig; since: string; now?: Date }): WeeklyReport {
	const now = input.now ?? new Date();
	return {
		generatedAt: now.toISOString(),
		window: { since: input.since },
		config: input.config,
		northStar: northStarTables(input.sessions),
		experiment: blindedExperiment(input.sessions, input.config.experiment, now),
		records: acceptanceRows(input.ledger, input.sessions, input.incidents, now),
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
