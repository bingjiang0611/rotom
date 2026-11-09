/**
 * What happened right after each compaction (plan P1-2). Harvest otherwise only sees a
 * compaction when its span fails; this measures the quiet failures: re-reading files the
 * summary listed, users having to step in again, Goal pauses, and recall use. Counts only,
 * never message text, so the output is safe to aggregate.
 */
import { type Entry, INTERVENTION_KINDS, type Incident, isRecord, messageOf, parseLines, paths } from "./harvest.ts";

/** Assistant messages after a compaction inspected for re-reads and recalls. */
export const REREAD_WINDOW_ASSISTANT_MESSAGES = 5;
/** User turns after a compaction inspected for interventions and Goal pauses. */
export const INTERVENTION_WINDOW_USER_TURNS = 3;

const READ_TOOLS = new Set(["read"]);
const RECALL_TOOLS = new Set(["context_recall", "obs_recall"]);

export type CompactionObservation = {
	sessionId: string;
	entryId: string;
	timestamp: string;
	tokensBefore: number | null;
	summaryInputTokens: number | null;
	summaryOutputTokens: number | null;
	/** cacheRead of the last request before and the first request after the compaction. */
	cacheReadBefore: number | null;
	cacheReadAfter: number | null;
	/** Files the summary listed as read or modified. */
	listedFiles: number;
	/** Distinct listed files read again within the window. */
	rereadFiles: number;
	recallCalls: number;
	/** User turns actually observed after the compaction (≤ the window). */
	userTurnsAfter: number;
	interventionsAfter: number;
	goalPausesAfter: number;
};

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageOf(entry: Entry): Record<string, unknown> | undefined {
	const message = messageOf(entry);
	return message?.role === "assistant" && isRecord(message.usage) ? message.usage : undefined;
}

function listedFiles(entry: Entry): Set<string> {
	const details = isRecord(entry.details) ? entry.details : {};
	const files = new Set<string>();
	for (const key of ["readFiles", "modifiedFiles"]) {
		const list = details[key];
		if (Array.isArray(list)) for (const file of list) if (typeof file === "string") files.add(file);
	}
	return files;
}

/**
 * `incidents` are this session's harvest incidents; interventions and Goal pauses are
 * attributed to a compaction by their anchor entry, so detection rules stay in one place.
 */
export function analyzeCompactions(lines: readonly string[], incidents: readonly Incident[], seen = new Set<string>()): CompactionObservation[] {
	const { header, entries } = parseLines(lines);
	if (!header || typeof header.id !== "string") return [];
	const sessionId = header.id;
	const interventionAt = new Set(incidents.filter((incident) => (INTERVENTION_KINDS as readonly string[]).includes(incident.kind)).map((incident) => incident.entryId));
	const goalPauseAt = new Set(incidents.filter((incident) => incident.kind === "goal_pause").map((incident) => incident.entryId));
	const observations: CompactionObservation[] = [];
	for (const path of paths(entries)) {
		path.forEach((entry, index) => {
			if (entry.type !== "compaction" || seen.has(entry.id)) return;
			seen.add(entry.id);
			const before = path.slice(0, index).reverse().find((candidate) => usageOf(candidate));
			const after = path.slice(index + 1);
			const files = listedFiles(entry);
			const reread = new Set<string>();
			let recallCalls = 0;
			let assistantSeen = 0;
			let userTurns = 0;
			let interventions = 0;
			let goalPauses = 0;
			let cacheReadAfter: number | null = null;
			for (const next of after) {
				if (next.type === "compaction") break;
				if (goalPauseAt.has(next.id) && userTurns <= INTERVENTION_WINDOW_USER_TURNS) goalPauses++;
				const message = messageOf(next);
				if (message?.role === "user") {
					if (++userTurns > INTERVENTION_WINDOW_USER_TURNS) break;
					if (interventionAt.has(next.id)) interventions++;
					continue;
				}
				if (message?.role !== "assistant") continue;
				if (interventionAt.has(next.id) && userTurns <= INTERVENTION_WINDOW_USER_TURNS) interventions++;
				const usage = usageOf(next);
				if (cacheReadAfter === null && usage) cacheReadAfter = count(usage.cacheRead);
				if (assistantSeen >= REREAD_WINDOW_ASSISTANT_MESSAGES) continue;
				assistantSeen++;
				for (const block of Array.isArray(message.content) ? message.content : []) {
					if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
					if (RECALL_TOOLS.has(block.name)) recallCalls++;
					const target = isRecord(block.arguments) && typeof block.arguments.path === "string" ? block.arguments.path : undefined;
					if (target && READ_TOOLS.has(block.name) && files.has(target)) reread.add(target);
				}
			}
			const summaryUsage = isRecord(entry.usage) ? entry.usage : {};
			const beforeUsage = before ? usageOf(before) : undefined;
			observations.push({
				sessionId,
				entryId: entry.id,
				timestamp: entry.timestamp,
				tokensBefore: count(entry.tokensBefore),
				summaryInputTokens: count(summaryUsage.input),
				summaryOutputTokens: count(summaryUsage.output),
				cacheReadBefore: beforeUsage ? count(beforeUsage.cacheRead) : null,
				cacheReadAfter,
				listedFiles: files.size,
				rereadFiles: reread.size,
				recallCalls,
				userTurnsAfter: Math.min(userTurns, INTERVENTION_WINDOW_USER_TURNS),
				interventionsAfter: interventions,
				goalPausesAfter: goalPauses,
			});
		});
	}
	return observations.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export type CompactionMetrics = {
	compactions: number;
	/** Share of compactions that listed files and saw at least one of them read again. */
	rereadRate: number | null;
	recallCompactions: number;
	userTurnsAfter: number;
	interventionsAfter: number;
	/** Interventions per 100 user turns inside the post-compaction windows. */
	interventionsPer100TurnsAfter: number | null;
	goalPausesAfter: number;
	medianSummaryOutputTokens: number | null;
	/** Compactions whose first later request read less cache than the last earlier one. */
	cacheDrops: number;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function compactionMetrics(observations: readonly CompactionObservation[]): CompactionMetrics {
	const withFiles = observations.filter((observation) => observation.listedFiles > 0);
	const userTurnsAfter = observations.reduce((sum, observation) => sum + observation.userTurnsAfter, 0);
	const interventionsAfter = observations.reduce((sum, observation) => sum + observation.interventionsAfter, 0);
	return {
		compactions: observations.length,
		rereadRate: withFiles.length ? Math.round((withFiles.filter((observation) => observation.rereadFiles > 0).length / withFiles.length) * 1000) / 1000 : null,
		recallCompactions: observations.filter((observation) => observation.recallCalls > 0).length,
		userTurnsAfter,
		interventionsAfter,
		interventionsPer100TurnsAfter: userTurnsAfter ? Math.round((interventionsAfter / userTurnsAfter) * 1000) / 10 : null,
		goalPausesAfter: observations.reduce((sum, observation) => sum + observation.goalPausesAfter, 0),
		medianSummaryOutputTokens: median(observations.map((observation) => observation.summaryOutputTokens).filter((value): value is number => value !== null)),
		cacheDrops: observations.filter((observation) => observation.cacheReadBefore !== null && observation.cacheReadAfter !== null && observation.cacheReadAfter < observation.cacheReadBefore).length,
	};
}
