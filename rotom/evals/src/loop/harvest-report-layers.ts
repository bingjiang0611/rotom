/**
 * Report sections that read one dimension layer at a time: how large each model's work was,
 * what its rate looks like without the noisiest session, the product and SoL-Pi versions that
 * served the sessions, and the planned default-model field comparison. They are kept out of
 * `harvest-report.ts` so that file stays a renderer rather than a second analysis module.
 */
import { dimensionRates, type RateInterval } from "./harvest-breakdown.ts";
import { modelDimensionRatesWithoutPeak, modelTaskSize, type DefaultModelExperiment } from "./harvest-models.ts";
import type { SessionSummary } from "./harvest.ts";

const band = (interval: RateInterval | null | undefined) => (interval ? `${interval.low}–${interval.high}` : "N/A");

/** Task size and the sensitivity check, side by side with the per-model rate. */
export function modelLayerTables(sessions: readonly SessionSummary[]): string[] {
	const withoutPeak = modelDimensionRatesWithoutPeak(sessions);
	return [
		"### Task size per model",
		"",
		"A higher v2 rate can mean a worse model or a harder queue. These are the proxies that tell them apart: the median user turns per session and the median tool calls per user turn, with each session attributed to the model that answered most of its turns.",
		"",
		"| Model | Sessions | User turns | Median turns/session | Median tool calls/turn |",
		"| --- | ---: | ---: | ---: | ---: |",
		...modelTaskSize(sessions).map((row) => `| ${row.model} | ${row.sessions} | ${row.turns} | ${row.medianTurnsPerSession ?? "N/A"} | ${row.medianToolCallsPerTurn ?? "N/A"} |`),
		"",
		"### The same rate per model without its largest session",
		"",
		`Sensitivity check: ${withoutPeak.dropped ? `the session with the most v2 events (\`${withoutPeak.dropped.sessionId.slice(0, 8)}\`, ${withoutPeak.dropped.northStarV2} of them) is removed and every model is recomputed` : "no session carried a v2 event, so this is the full set"}. A rate that only survives with that session included describes one conversation.`,
		"",
		"| Model | User turns | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | --- |",
		...withoutPeak.rows.map((row) => `| ${row.key} | ${row.turns} | ${row.northStarV2} | ${row.v2Per100 ?? "N/A"} | ${band(row.v2Interval)} |`),
		"",
	];
}

/** The two version layers: the installed product, and the SoL-Pi build a session proves. */
export function versionLayerTables(sessions: readonly SessionSummary[]): string[] {
	const productCoverage = sessions.filter((session) => session.productVersion).length;
	const solPiCoverage = sessions.filter((session) => session.solPiVersion).length;
	const table = (rows: ReturnType<typeof dimensionRates>) =>
		rows.map((row) => `| ${row.key} | ${row.turns} | ${row.northStarV2} | ${row.v2Per100 ?? "N/A"} | ${band(row.v2Interval)} |`);
	return [
		"### The same rate per product version",
		"",
		`Layered by the installed rotom product version the trace recorded in \`pi.session.runtime\`; ${productCoverage} of ${sessions.length} sessions carry one and the rest stay \`unknown\` rather than being attributed to the release that merely happened to be installed. A mechanism change can only be read here if it shipped in a product version these sessions ran.`,
		"",
		"| Product version | User turns | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | --- |",
		...table(dimensionRates(sessions, (session) => session.productVersion)),
		"",
		"### The same rate per SoL-Pi version",
		"",
		`SoL-Pi version is read only from a vendored \`sol-pi-<version>.tgz\` path a session itself recorded; ${solPiCoverage} of ${sessions.length} sessions do, so most appear as \`unknown\`. This is the layer that can attribute a Context Layers or Observation Pack change, and it stays empty until sessions carry the evidence.`,
		"",
		"| SoL-Pi version | User turns | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | --- |",
		...table(dimensionRates(sessions, (session) => session.solPiVersion)),
		"",
	];
}

/** The default-model comparison: the two groups, then what was excluded and why. */
export function experimentSection(experiment: DefaultModelExperiment): string[] {
	return [
		"",
		"## Experiment: default model by date parity",
		"",
		"The planned field comparison runs odd days on `openai-codex/gpt-6-astra` and even days on `openai-codex/gpt-6.1-sol`. A session counts only when its first assistant message already used that day's default model; a session that started on the default and then switched is listed separately and stays out of the rates.",
		"",
		"| Default model | Sessions | User turns | v2 | v2 per 100 | v2 95% band |",
		"| --- | ---: | ---: | ---: | ---: | --- |",
		...experiment.groups.map((row) => `| ${row.model} | ${row.sessions} | ${row.turns} | ${row.v2} | ${row.v2Per100 ?? "N/A"} | ${band(row.v2Interval)} |`),
		"",
		`Switched after starting on the default (${experiment.switched.length}), excluded:`,
		"",
		...(experiment.switched.length === 0 ? ["None in this window.", ""] : [
			"| Session | Started | Default | Models used |",
			"| --- | --- | --- | --- |",
			...experiment.switched.map((row) => `| ${row.sessionId.slice(0, 8)} | ${row.startedAt.slice(0, 16)} | ${row.expected} | ${row.models.join(", ")} |`),
			"",
		]),
		`Never used the day's default model or recorded no first assistant model (${experiment.offDefault.length}), excluded:`,
		"",
		...(experiment.offDefault.length === 0 ? ["None in this window.", ""] : [
			"| Session | Started | Day default | First assistant model |",
			"| --- | --- | --- | --- |",
			...experiment.offDefault.slice(0, 40).map((row) => `| ${row.sessionId.slice(0, 8)} | ${row.startedAt.slice(0, 16)} | ${row.expected ?? "unknown"} | ${row.firstAssistantModel ?? "unknown"} |`),
			"",
		]),
	];
}
