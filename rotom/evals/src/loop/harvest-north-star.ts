/**
 * North-star accounting for one session: how many interventions there were, which of them v2
 * keeps, and which model was answering each of them. Kept out of `harvest.ts` so the session
 * walk and the metric stay readable on their own.
 */
import type { Incident, IncidentKind } from "./harvest.ts";

/** Human-side signals: the user had to step in. These form the north-star metric. */
export const INTERVENTION_KINDS = ["user_correction", "user_repeat", "bare_continue", "user_interrupt"] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export type NorthStar = {
	interventions: number;
	/** v2: corrections, repeats, bare continues and the interrupts that reached a real attempt. */
	northStarV2: number;
	interruptExcluded: number;
	interruptTriage: Record<"self-retract" | "quality" | "other", number>;
	interventionModels: Record<string, number>;
	v2Models: Record<string, number>;
};

function isIntervention(kind: IncidentKind): kind is InterventionKind {
	return (INTERVENTION_KINDS as readonly string[]).includes(kind);
}

/** An injected goal contract or a compaction moved the session on by itself; only the rest are interrupts a person caused. */
function causedByHuman(incident: Incident): boolean {
	return incident.detail.cause !== "injected" && incident.detail.cause !== "compaction";
}

/**
 * A periodic re-send of an instruction that was already answered counts as noise, not as the agent
 * needing a person. The harvest marks it; everything else still counts.
 */
function routineRepeat(incident: Incident): boolean {
	return incident.kind === "user_repeat" && incident.detail.routine === true;
}

export function northStar(incidents: readonly Incident[], intervenedEntries: number): NorthStar {
	const interrupts = incidents.filter((incident) => incident.kind === "user_interrupt");
	const excluded = interrupts.filter((incident) => !causedByHuman(incident)).length;
	const counted = interrupts.filter(causedByHuman);
	const interruptTriage: NorthStar["interruptTriage"] = { "self-retract": 0, quality: 0, other: 0 };
	for (const incident of counted) interruptTriage[(incident.detail.triage as keyof NorthStar["interruptTriage"] | undefined) ?? "other"]++;
	const interventionModels: Record<string, number> = {};
	const v2Models: Record<string, number> = {};
	for (const incident of incidents) {
		if (!isIntervention(incident.kind) || !causedByHuman(incident) || routineRepeat(incident)) continue;
		const model = typeof incident.detail.model === "string" ? incident.detail.model : "unknown";
		interventionModels[model] = (interventionModels[model] ?? 0) + 1;
		if (incident.kind !== "user_interrupt" || incident.detail.triage === "quality") v2Models[model] = (v2Models[model] ?? 0) + 1;
	}
	const interventions = intervenedEntries + interrupts.length - excluded;
	// v2 swaps every counted interrupt for the quality ones, so a self-retract stops counting.
	return {
		interventions,
		northStarV2: interventions - counted.length + interruptTriage.quality,
		interruptExcluded: excluded,
		interruptTriage,
		interventionModels,
		v2Models,
	};
}

/** A trace span that ended in error is a failed compaction, whether or not the session logged one. */
export function compactionFailuresFromTrace(traceLines: readonly string[], fallbackTimestamp: string): Incident[] {
	const failures: Incident[] = [];
	for (const line of traceLines) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record !== "object" || record === null) continue;
		const span = record as Record<string, unknown>;
		if (span.kind !== "span_end" || span.name !== "pi.session.compaction" || span.status !== "error") continue;
		failures.push({
			kind: "compaction_failed",
			sessionId: "",
			sessionFile: "",
			entryId: typeof span.spanId === "string" ? `trace:${span.spanId}` : "trace",
			timestamp: typeof span.timestamp === "string" ? span.timestamp : fallbackTimestamp,
			detail: {},
		});
	}
	return failures;
}
