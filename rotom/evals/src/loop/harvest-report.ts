/**
 * Harvest report: the markdown the harvest writes, the weekly north-star table and the triage
 * queue. Walking sessions and writing the output directory live in `harvest-run.ts`; analysis
 * of one session lives in `harvest.ts`.
 */
import { FAILURE_KINDS, INTERVENTION_KINDS, type Incident, type IncidentKind, type SessionSummary } from "./harvest.ts";
import { summarizeProviderErrors } from "./harvest-provider.ts";
import { dayBreakdown, dimensionRates, interruptTables, modelDimensionRates, modelShareWeeks, modelSwitchTables, modelTurnShare, northStarWeeks, poissonRateInterval, toolErrorTables, triageTable } from "./harvest-breakdown.ts";

/** Why a file under the sessions root did not become a session. The label names the reason,
 * not the path, so a skip count can be audited without exposing where the files live.
 * `artifact-store` is a subtree the product writes next to sessions (trace sidecars, subagent
 * runs, observation packs); those trees hold no user session, and a walk that skips them says so. */
export type SkipReason = "symlink" | "unreadable" | "not-a-session" | "outside-window" | "no-user-turns" | "artifact-store" | "deep-directory";

export type SkipCounts = Partial<Record<SkipReason, number>>;

/** ISO-8601 week label, e.g. 2026-W45. */
export function isoWeek(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "unknown";
	const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WeekMetric = {
	week: string;
	sessions: number;
	userTurns: number;
	interventions: number;
	/** North star: user interventions per 100 user turns. */
	interventionsPer100Turns: number | null;
	/** 95% Poisson band for that rate; see {@link poissonRateInterval}. */
	interventionsInterval: { low: number; high: number } | null;
	failures: number;
	incidentCounts: Partial<Record<IncidentKind, number>>;
};

export function weeklyMetrics(sessions: readonly SessionSummary[]): WeekMetric[] {
	const weeks = new Map<string, WeekMetric>();
	for (const session of sessions) {
		const week = isoWeek(session.startedAt);
		const metric = weeks.get(week) ?? { week, sessions: 0, userTurns: 0, interventions: 0, interventionsPer100Turns: null, interventionsInterval: null, failures: 0, incidentCounts: {} };
		metric.sessions++;
		metric.userTurns += session.userTurns;
		metric.interventions += session.interventions;
		metric.failures += session.failures;
		for (const [kind, count] of Object.entries(session.incidentCounts) as [IncidentKind, number][]) {
			metric.incidentCounts[kind] = (metric.incidentCounts[kind] ?? 0) + count;
		}
		weeks.set(week, metric);
	}
	return [...weeks.values()]
		.map((metric) => ({
			...metric,
			interventionsPer100Turns: metric.userTurns > 0 ? Math.round((metric.interventions / metric.userTurns) * 1000) / 10 : null,
			interventionsInterval: poissonRateInterval(metric.interventions, metric.userTurns) ?? null,
		}))
		.sort((left, right) => left.week.localeCompare(right.week));
}

const TRIAGE_WEIGHT: Record<IncidentKind, number> = {
	user_correction: 3,
	user_repeat: 2,
	bare_continue: 2,
	user_interrupt: 1,
	tool_error_streak: 1,
	edit_retry_without_read: 1,
	provider_error: 0.5,
	length_stop: 0.5,
	goal_pause: 1,
	compaction_failed: 1,
};

export function triageScore(session: SessionSummary): number {
	return (Object.entries(session.incidentCounts) as [IncidentKind, number][]).reduce((sum, [kind, count]) => sum + TRIAGE_WEIGHT[kind] * count, 0);
}

export function renderReport(input: { generatedAt: string; since: string; sessionsDir: string; sessions: readonly SessionSummary[]; incidents: readonly Incident[]; skipped: SkipCounts }): string {
	const weeks = weeklyMetrics(input.sessions);
	const providerRows = summarizeProviderErrors(input.incidents.filter((incident) => incident.kind === "provider_error"));
	const weekOf = (session: SessionSummary) => isoWeek(session.startedAt);
	const modelRows = modelShareWeeks(input.sessions, weekOf);
	const interrupts = interruptTables(input.incidents);
	const toolErrors = toolErrorTables(input.incidents);
	// The peak is the highest rate among weeks with enough turns for the ratio to mean anything.
	const peak = weeks.filter((week) => week.userTurns >= 20).sort((left, right) => (right.interventionsPer100Turns ?? 0) - (left.interventionsPer100Turns ?? 0))[0];
	const startSources = new Map<string, number>();
	for (const session of input.sessions) startSources.set(session.startedAtSource, (startSources.get(session.startedAtSource) ?? 0) + 1);
	const releases = input.sessions.filter((session) => session.release).length;
	const runtimeCoverage = input.sessions.filter((session) => session.runtimeVersion).length;
	const lines = [
		"# rotom loop harvest",
		"",
		`Generated ${input.generatedAt} · sessions since ${input.since} · source \`${input.sessionsDir}\``,
		"",
		"Local, private output. Detectors are heuristic candidates for triage, not verdicts.",
		"",
		"## Weekly intervention rate: v1 and v2",
		"",
		"`95% band` is the Poisson normal approximation `k ± 1.96√k` per 100 turns: a rough sampling band, not a product-quality claim.",
		"",
		"v1 counts every intervention. v2 keeps corrections, repeats, bare continues and only those interrupts where the run had already produced something (a tool executing, text or a tool call streaming) or the user had waited 10 seconds or more.",
		"",
		"| Week | Sessions | User turns | v1 | v1 per 100 | v1 95% band | v2 | v2 per 100 | v2 95% band | Agent-side failures |",
		"| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: |",
		...(() => {
			const byWeek = new Map(northStarWeeks(input.sessions, weekOf).map((row) => [row.week, row]));
			const band = (interval: { low: number; high: number } | null | undefined) => (interval ? `${interval.low}–${interval.high}` : "N/A");
			return weeks.map((week) => {
				const star = byWeek.get(week.week);
				return `| ${week.week} | ${week.sessions} | ${week.userTurns} | ${week.interventions} | ${week.interventionsPer100Turns ?? "N/A"} | ${band(week.interventionsInterval)} | ${star?.v2 ?? "N/A"} | ${star?.v2Per100 ?? "N/A"} | ${band(star?.v2Interval)} | ${week.failures} |`;
			});
		})(),
		"",
		"### The same rate per model",
		"",
		"A week mixes models, so a week-to-week move can be a model-mix change. Each model's own rate is the comparison that survives it.",
		"",
		"| Model | User turns | v1 interventions | v1 per 100 | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | ---: | ---: | --- |",
		...modelDimensionRates(input.sessions).map((row) => `| ${row.key} | ${row.turns} | ${row.interventions} | ${row.turns > 0 ? Math.round((row.interventions / row.turns) * 1000) / 10 : "N/A"} | ${row.northStarV2} | ${row.v2Per100 ?? "N/A"} | ${row.v2Interval ? `${row.v2Interval.low}–${row.v2Interval.high}` : "N/A"} |`),
		"",
		"### The same rate per runtime",
		"",
		`Sessions whose trace recorded \`pi.session.runtime\` are grouped by the runtime that served them; ${runtimeCoverage} of ${input.sessions.length} sessions carry one; the rest appear as \`unknown\` rather than being attributed to a version.`,
		"",
		"| Runtime | User turns | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | --- |",
		...dimensionRates(input.sessions, (session) => session.runtimeVersion).map((row) => `| ${row.key} | ${row.turns} | ${row.northStarV2} | ${row.v2Per100 ?? "N/A"} | ${row.v2Interval ? `${row.v2Interval.low}–${row.v2Interval.high}` : "N/A"} |`),
		"",
		"### Model turn share over the whole window",
		"",
		"| Model | Turns | Share |",
		"| --- | ---: | ---: |",
		...modelTurnShare(input.sessions).map((row) => `| ${row.model} | ${row.turns} | ${row.share}% |`),
		"",
		"## Model share by user turn",
		"",
		"Each user turn is attributed to the model of the first assistant message that answered it.",
		"",
		"| Week | Model | Turns | Share |",
		"| --- | --- | ---: | ---: |",
		...modelRows.map((row) => `| ${row.week} | ${row.model} | ${row.turns} | ${row.share}% |`),
		"",
	];
	if (peak) {
		const days = dayBreakdown(input.sessions, peak.week, weekOf);
		lines.push(
			`## ${peak.week} by day and provider`,
			"",
			`The peak week (${peak.interventionsPer100Turns ?? "N/A"} interventions per 100 turns). A session is attributed to the provider that answered most of its turns, so its interventions all count there.`,
			"",
			"| Day | Provider | Sessions | User turns | Interventions | per 100 turns | Failures |",
			"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
			...days.map((row) => `| ${row.day} | ${row.provider} | ${row.sessions} | ${row.turns} | ${row.interventions} | ${row.per100 ?? "N/A"} | ${row.failures} |`),
			"",
		);
	}
	lines.push(
		"## Interrupts",
		"",
		`\`cause\` is the first non-control entry after the aborted message. A human message with typed text is \`human\` (${interrupts.humanShare}% of interrupts); an injected contract or skill block is \`injected\`; \`compaction\` and \`system\` moved the session on without the user; \`no-following-turn\` means the file ends there, so the cause stays unknown.`,
		"",
		"| Cause | Count |",
		"| --- | ---: |",
		...interrupts.byCause.map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Running when aborted | Count |",
		"| --- | ---: |",
		...interrupts.byActivity.map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Aborted after | Count |",
		"| --- | ---: |",
		...interrupts.byDuration.map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Next user message | Count |",
		"| --- | ---: |",
		...interrupts.byFollowUp.map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Cause | Running when aborted | Count |",
		"| --- | --- | ---: |",
		...interrupts.causeActivity.map((row) => `| ${row.cause} | ${row.activity} | ${row.count} |`),
		"",
		"## Tool error streaks",
		"",
		"| Tool | Streaks |",
		"| --- | ---: |",
		...toolErrors.byTool.slice(0, 12).map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Error class | Streaks |",
		"| --- | ---: |",
		...toolErrors.byCategory.map((row) => `| ${row.key} | ${row.count} |`),
		"",
		"| Tool | Error class | Streaks |",
		"| --- | --- | ---: |",
		...toolErrors.toolCategory.slice(0, 15).map((row) => `| ${row.tool} | ${row.category} | ${row.count} |`),
		"",
		"## Incidents by kind",
		"",
		"| Kind | Count |",
		"| --- | ---: |",
		...[...INTERVENTION_KINDS, ...FAILURE_KINDS].map((kind) => `| ${kind} | ${input.incidents.filter((incident) => incident.kind === kind).length} |`),
		"",
		"## Provider errors by provider, category and outcome",
		"",
		"`Outcome` is `recovered` when a usable assistant message closed the retry run (Pi absorbed the error) and `user-visible` when the run ended without one, so the user saw the failure. Read the recovered share, not the user-visible share, as the retry budget working.",
		"",
		"| Provider | Model | Category | Outcome | Incidents | Attempts |",
		"| --- | --- | --- | --- | ---: | ---: |",
		...providerRows.rows.map((row) => `| ${row.provider} | ${row.model} | ${row.category} | ${row.final ? "recovered" : "user-visible"} | ${row.count} | ${row.attempts} |`),
		"",
		`Provider errors: ${providerRows.total} incidents, ${providerRows.final} recovered, ${providerRows.total - providerRows.final} reached the user.`,
		"",
		"## Provenance",
		"",
		`\`startedAt\` source: ${[...startSources].sort((left, right) => right[1] - left[1]).map(([source, count]) => `${source} ${count}`).join(", ")}. A session whose own timestamps are missing or pre-2000 falls back to the file mtime, so a reconstructed date is visible here instead of becoming 1970-W01.`,
		"",
		`Release: ${releases} of ${input.sessions.length} sessions embed a rotom release path, and only in stack traces, so a release split is biased toward failures and is not reported.`,
		"",
		"## Triage queue (top sessions)",
		"",
		"| Score | Session | Started | Turns | Incidents | File |",
		"| ---: | --- | --- | ---: | --- | --- |",
	);
	const ranked = [...input.sessions].filter((session) => triageScore(session) > 0).sort((left, right) => triageScore(right) - triageScore(left)).slice(0, 20);
	for (const session of ranked) {
		const counts = Object.entries(session.incidentCounts).map(([kind, count]) => `${kind}×${count}`).join(", ");
		lines.push(`| ${triageScore(session)} | ${session.sessionId.slice(0, 8)} | ${session.startedAt.slice(0, 16)} | ${session.userTurns} | ${counts} | \`${session.sessionFile}\` |`);
	}
	const skipRows = Object.entries(input.skipped).sort((left, right) => right[1] - left[1]);
	if (skipRows.length > 0) {
		// Each reason is named, so a skip count can be audited instead of trusted.
		lines.push("", "## Skipped files", "", "`outside-window` is a session file older than the window and `no-user-turns` is one with no user message; neither can hide a usable session inside the window.", "", "| Reason | Files |", "| --- | ---: |", ...skipRows.map(([reason, count]) => `| ${reason} | ${count} |`));
	}
	const triage = triageTable(input.incidents);
	const switches = modelSwitchTables(input.incidents);
	if (triage.length > 0) {
		lines.push(
			"",
			"## Interrupt triage",
			"",
			"`self-retract`: still waiting for the first byte and under two seconds. `quality`: a tool was executing, text or a tool call was streaming, or the wait passed ten seconds. `other` is everything left, including a session that ends at the abort.",
			"",
			"| Triage | Interrupts |",
			"| --- | ---: |",
			...triage.map((row) => `| ${row.triage} | ${row.count} |`),
			"",
			"### Interrupts followed by a model switch",
			"",
			`${switches.total} interrupts were followed by a \`model_change\` before the next user message: the person changed model at the interrupt rather than later.`,
			"",
			...(switches.total === 0 ? ["None in this window.", ""] : [
				"| Model switched away from | Count |",
				"| --- | ---: |",
				...switches.byModel.map((row) => `| ${row.model} | ${row.count} |`),
				"",
				"| Wait before the abort | Count |",
				"| --- | ---: |",
				...switches.byDuration.map((row) => `| ${row.duration} | ${row.count} |`),
				"",
				"| Model | Wait | Count |",
				"| --- | --- | ---: |",
				...switches.byModelDuration.map((row) => `| ${row.model} | ${row.duration} | ${row.count} |`),
				"",
			]),
		);
	}
	lines.push("", "Next: pick incidents from `incidents.jsonl`, classify them, and turn reproducible ones into replay cases (see docs/agent/optimization-loop.md).", "");
	return lines.join("\n");
}
