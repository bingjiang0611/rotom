import type { EntryClass, InterruptTriage, StartSource } from "./harvest-signals.ts";
import type { IncidentKind } from "./harvest.ts";

/** Where `startedAt` came from, so a reconstructed date is never mistaken for a measured one. */

export type SessionSummary = {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	startedAt: string;
	startedAtSource: StartSource;
	/** User turns attributed to the model that answered them, `provider/model` → count. */
	modelTurns: Record<string, number>;
	/** Release path this session ran, when a stack trace embedded one. Biased toward errors. */
	release?: string;
	/** install, dev-checkout or unknown: which entry started the session. */
	entry?: EntryClass;
	/** Launcher real path as recorded by the trace; paths only. */
	launcher?: string;
	/** Commit the product was built from, when the launcher could prove it. */
	buildCommit?: string;
	buildDirty?: boolean;
	models: string[];
	userTurns: number;
	assistantMessages: number;
	toolCalls: number;
	toolErrors: number;
	interventions: number;
	/** Interrupts the structure proved non-human (injected message, compaction) and therefore excluded. */
	interruptExcluded: number;
	/** Interventions per model, so a rate can be read per model instead of per week. */
	interventionModels: Record<string, number>;
	/** North-star v2 numerator: corrections, repeats, bare continues and quality interrupts. */
	northStarV2: number;
	/** The v2 numerator per model, so a rate can be read per model rather than per week. */
	v2Models: Record<string, number>;
	/** Interrupts by triage class, counted the way v1 counts them (excluded ones are separate). */
	interruptTriage: Record<InterruptTriage, number>;
	/** Pi fork that served this session, when its trace recorded one. */
	runtimeVersion?: string;
	/** Installed rotom product version that served this session, when its trace recorded one. */
	productVersion?: string;
	/** SoL-Pi version the session proves it ran, from a vendored archive path in its own lines. */
	solPiVersion?: string;
	failures: number;
	incidentCounts: Partial<Record<IncidentKind, number>>;
};
