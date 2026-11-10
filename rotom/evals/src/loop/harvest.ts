/**
 * Optimization-loop harvester analysis: turns one Pi session into incident candidates.
 *
 * Zero model calls. Reads session JSONL (and the sibling local trace when present) on this
 * machine only; every output stays under a private local directory and is never meant for Git.
 * Detectors are deterministic and deliberately simple: they rank candidates for human triage,
 * they do not decide that the agent was wrong.
 */

import { providerDetail, traceErrorSpans } from "./harvest-provider.ts";
import { clip, humanText, isBareContinue, isCorrection, isRecord, normalized, similarity, textOf } from "./harvest-text.ts";
import { interruptActivity, interruptFollowUp, interruptTriage, resolveInterruptCauses, resolveStartedAt, runtimeVersionOf, releaseOf, toolErrorCategory, type StartSource, type InterruptActivity, type InterruptCause, type InterruptFollowUp, type InterruptTriage } from "./harvest-signals.ts";
import { messageOf, parseLines, paths, type Block, type Entry, type Message } from "./harvest-tree.ts";

// Re-exported so the detectors, the report and the tests keep one import surface.
export { isBareContinue, isCorrection, similarity } from "./harvest-text.ts";
export { releaseOf, resolveStartedAt } from "./harvest-signals.ts";
export { TOOL_ERROR_CATEGORIES, interruptActivity, interruptFollowUp, interruptTriage, runtimeVersionOf, toolErrorCategory, type InterruptActivity, type InterruptFollowUp, type InterruptTriage, type ToolErrorCategory } from "./harvest-signals.ts";

export const HARVEST_SCHEMA = "rotom-loop-harvest/v1";
import { INTERVENTION_KINDS, compactionFailuresFromTrace, northStar, type InterventionKind } from "./harvest-north-star.ts";
export { INTERVENTION_KINDS, type InterventionKind } from "./harvest-north-star.ts";

/** Agent-side signals: something went wrong without (yet) a user reaction. */
export const FAILURE_KINDS = [
	"tool_error_streak",
	"edit_retry_without_read",
	"provider_error",
	"length_stop",
	"goal_pause",
	"compaction_failed",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type IncidentKind = InterventionKind | FailureKind;

export type Incident = {
	kind: IncidentKind;
	sessionId: string;
	sessionFile: string;
	/** Session entry the incident is anchored to; open/fork the session there to replay. */
	entryId: string;
	timestamp: string;
	detail: Record<string, string | number | boolean>;
	/** Local-only text excerpts; omitted with `excerpts: false`. */
	excerpt?: { user?: string; assistant?: string; error?: string };
};

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
	/** Product runtime that served this session, when its trace recorded one. */
	runtimeVersion?: string;
	failures: number;
	incidentCounts: Partial<Record<IncidentKind, number>>;
};

const READ_TOOLS = new Set(["read", "obs_recall"]);
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch"]);
/** Independent of the run, a paused Goal needs no action; the cause is already an incident. */
const BENIGN_GOAL_PAUSES = new Set(["explicit_pause", "session_restored", "agent_interruption"]);
/**
 * Action Fusion appends the follow-up command outcome to the mutation result. A failed fused
 * run means the command after the edit failed, not that the file was left unchanged.
 */
const THEN_RUN_FAILED = "[then_run:failed]";
export type AnalyzeOptions = { sessionFile: string; excerpts: boolean; traceLines?: readonly string[]; shared?: HarvestShared; fileMtimeMs?: number };
/**
 * Harvest-wide state. Forks copy their parent's entries, so a conversation continued in a
 * second session file must not count its user turns or incidents twice.
 */
export type HarvestShared = { incidentKeys: Set<string>; userEntries: Set<string>; turnModels: Map<string, string> };

export function createHarvestShared(): HarvestShared {
	return { incidentKeys: new Set<string>(), userEntries: new Set<string>(), turnModels: new Map<string, string>() };
}

/** Milliseconds from the entry that started this request to the abort, when the message carries none. */
function elapsedSinceParent(parent: Entry | undefined, entry: Entry): number | undefined {
	if (!parent) return undefined;
	const from = Date.parse(parent.timestamp);
	const to = Date.parse(entry.timestamp);
	if (Number.isNaN(from) || Number.isNaN(to) || to < from) return undefined;
	return to - from;
}

/** Detail fragment naming the model in force; an unknown model stays absent rather than "unknown". */
function modelKey(model: string | undefined): { model?: string } {
	return model ? { model } : {};
}

export function analyzeSession(lines: readonly string[], options: AnalyzeOptions): { session: SessionSummary; incidents: Incident[] } | undefined {
	const { header, entries } = parseLines(lines);
	if (!header || typeof header.id !== "string") return undefined;
	const sessionId = header.id;
	const shared = options.shared ?? createHarvestShared();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const incidents = new Map<string, Incident>();
	// A user turn counts once even when several signals fire on it.
	const intervenedUserEntries = new Set<string>();
	const add = (incident: Omit<Incident, "sessionId" | "sessionFile">) => {
		const key = `${incident.kind}:${incident.entryId}`;
		if (incidents.has(key) || shared.incidentKeys.has(key)) return;
		incidents.set(key, { ...incident, sessionId, sessionFile: options.sessionFile });
		shared.incidentKeys.add(key);
		if (incident.kind !== "user_interrupt" && (INTERVENTION_KINDS as readonly string[]).includes(incident.kind)) intervenedUserEntries.add(incident.entryId);
	};
	const withExcerpt = (excerpt: Incident["excerpt"]) => (options.excerpts ? { excerpt } : {});

	const userEntries = new Set<string>();
	const assistantEntries = new Set<string>();
	const toolCallIds = new Set<string>();
	const toolErrorIds = new Set<string>();
	const models = new Set<string>();

	for (const path of paths(entries)) {
		const aborts: { index: number; incident: Incident; requestText: string }[] = [];
		// The model in force for the message being read, so an intervention can name it.
		let currentModel: string | undefined;
		let pendingUser: { id: string; text: string } | undefined;
		let lastUserText = "";
		let lastAssistant: { entry: Entry; message: Message } | undefined;
		const recentUsers: { entry: Entry; text: string }[] = [];
		const callArgs = new Map<string, { name: string; path?: string; action: string }>();
		const lastResultByAction = new Map<string, { isError: boolean; streak: number }>();
		const failedEditPaths = new Map<string, string>(); // path -> entryId of failed edit
		let lastGoalPause: string | undefined;
		// A retrying provider produces one failed request per attempt; that is one incident.
		let errorRun: { entryId: string; attempts: number; incident?: Incident } | undefined;
		const providerSpans = traceErrorSpans(options.traceLines);

		for (const [index, entry] of path.entries()) {
			if (entry.type === "model_change") {
				// A model switch writes provider/modelId, not a message; it resets the attribution.
				if (typeof entry.provider === "string" && typeof entry.modelId === "string") currentModel = `${entry.provider}/${entry.modelId}`;
				continue;
			}
			if (entry.type === "custom" && entry.customType === "goal-state" && isRecord(entry.data)) {
				const goal = isRecord(entry.data.goal) ? entry.data.goal : undefined;
				const reason = goal && goal.status === "paused" && typeof goal.stopReason === "string" ? goal.stopReason : undefined;
				const marker = reason ? `${String(goal?.id)}:${reason}` : undefined;
				if (reason && !BENIGN_GOAL_PAUSES.has(reason) && marker !== lastGoalPause) {
					add({ kind: "goal_pause", entryId: entry.id, timestamp: entry.timestamp, detail: { reason } });
				}
				lastGoalPause = marker;
				continue;
			}
			const message = messageOf(entry);
			if (!message) continue;

			if (message.role === "user") {
				const isNewTurn = !shared.userEntries.has(entry.id);
				if (isNewTurn) {
					shared.userEntries.add(entry.id);
					userEntries.add(entry.id);
				}
				const text = humanText(textOf(message.content));
				lastUserText = text;
				if (isNewTurn) pendingUser = { id: entry.id, text };
				const previousAssistantText = lastAssistant ? textOf(lastAssistant.message.content) : "";
				const excerpt = { user: clip(text), assistant: previousAssistantText ? clip(previousAssistantText, true) : undefined };
				const modelDetail = modelKey(currentModel);
				if (lastAssistant && isBareContinue(text) && lastAssistant.message.stopReason === "stop") {
					add({ kind: "bare_continue", entryId: entry.id, timestamp: entry.timestamp, detail: { ...modelDetail }, ...withExcerpt(excerpt) });
				} else if (lastAssistant && isCorrection(text)) {
					add({ kind: "user_correction", entryId: entry.id, timestamp: entry.timestamp, detail: { ...modelDetail }, ...withExcerpt(excerpt) });
				}
				if (normalized(text).length >= 12) {
					const repeated = recentUsers.find((previous) => similarity(previous.text, text) >= 0.8);
					// Re-sending after a provider error or an interrupt is not the agent ignoring the request.
					const resentAfterFailure = lastAssistant?.message.stopReason === "error" || lastAssistant?.message.stopReason === "aborted";
					if (repeated && lastAssistant && !resentAfterFailure) {
						add({
							kind: "user_repeat",
							entryId: entry.id,
							timestamp: entry.timestamp,
							detail: { repeatsEntry: repeated.entry.id, ...modelDetail },
							...withExcerpt(excerpt),
						});
					}
				}
				recentUsers.push({ entry, text });
				if (recentUsers.length > 3) recentUsers.shift();
				lastResultByAction.clear();
				failedEditPaths.clear();
				errorRun = undefined;
				continue;
			}

			if (message.role === "assistant") {
				assistantEntries.add(entry.id);
				lastAssistant = { entry, message };
				if (typeof message.provider === "string" && typeof message.model === "string") {
					models.add(`${message.provider}/${message.model}`);
					currentModel = `${message.provider}/${message.model}`;
				}
				// The first assistant message after a user turn is the model that answered it.
				if (pendingUser && typeof message.provider === "string" && typeof message.model === "string") {
					if (!shared.turnModels.has(pendingUser.id)) shared.turnModels.set(pendingUser.id, `${message.provider}/${message.model}`);
					pendingUser = undefined;
				}
				const blocks = Array.isArray(message.content) ? (message.content as unknown[]).filter(isRecord) as Block[] : [];
				for (const block of blocks) {
					if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
					toolCallIds.add(`${entry.id}:${block.id}`);
					const target = isRecord(block.arguments) && typeof block.arguments.path === "string" ? block.arguments.path : undefined;
					const command = isRecord(block.arguments) && typeof block.arguments.command === "string" ? block.arguments.command : undefined;
					callArgs.set(block.id, { name: block.name, path: target, action: `${block.name}\u0000${command ?? target ?? ""}` });
					if (target && EDIT_TOOLS.has(block.name) && failedEditPaths.has(target)) {
						add({
							kind: "edit_retry_without_read",
							entryId: entry.id,
							timestamp: entry.timestamp,
							detail: { tool: block.name, failedAt: failedEditPaths.get(target) ?? "" },
						});
						failedEditPaths.delete(target);
					}
					if (target && READ_TOOLS.has(block.name)) failedEditPaths.delete(target);
				}
				const errorText = typeof message.errorMessage === "string" ? message.errorMessage : "";
				if (message.stopReason === "aborted") {
					errorRun = undefined;
					const parent = index > 0 ? path[index - 1] : byId.get(entry.parentId ?? "");
					const activity = interruptActivity(message, parent);
					const elapsed = typeof message.durationMs === "number" && Number.isFinite(message.durationMs) ? message.durationMs : elapsedSinceParent(parent, entry);
					const waited = elapsed === undefined ? undefined : Math.max(0, Math.round(elapsed));
					add({
						kind: "user_interrupt",
						entryId: entry.id,
						timestamp: entry.timestamp,
						detail: { ...activity, ...(waited === undefined ? {} : { elapsedMs: waited }), triage: interruptTriage(activity.activity, waited), ...modelKey(currentModel), cause: "unknown", nextUser: "none" },
					});
					const created = incidents.get(`user_interrupt:${entry.id}`);
					if (created) aborts.push({ index, incident: created, requestText: lastUserText });
				} else if (message.stopReason === "error") {
					if (errorRun) {
						errorRun.attempts++;
						if (errorRun.incident) errorRun.incident.detail.attempts = errorRun.attempts;
					} else {
						const detail = providerDetail({
							provider: typeof message.provider === "string" ? message.provider : "unknown",
							model: typeof message.model === "string" ? message.model : "unknown",
							errorMessage: errorText,
							spans: providerSpans,
							timestamp: entry.timestamp,
						});
						errorRun = { entryId: entry.id, attempts: 1 };
						add({ kind: "provider_error", entryId: entry.id, timestamp: entry.timestamp, detail: { attempts: 1, ...detail, final: false }, ...withExcerpt({ error: clip(errorText) }) });
						errorRun.incident = incidents.get(`provider_error:${entry.id}`);
					}
				} else if (message.stopReason === "length") {
					errorRun = undefined;
					add({ kind: "length_stop", entryId: entry.id, timestamp: entry.timestamp, detail: {} });
				} else {
					// A usable answer ends the retry run: the provider failure did not reach the user.
					if (errorRun?.incident) errorRun.incident.detail.final = true;
					errorRun = undefined;
				}
				continue;
			}

			if (message.role === "toolResult") {
				const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
				const resultText = textOf(message.content);
				const isError = message.isError === true;
				if (isError) toolErrorIds.add(entry.id);
				// A failed fused follow-up is a command outcome; the mutation itself was applied.
				const mutationFailed = isError && !resultText.includes(THEN_RUN_FAILED);
				const call = typeof message.toolCallId === "string" ? callArgs.get(message.toolCallId) : undefined;
				const action = call?.action ?? toolName;
				const previous = lastResultByAction.get(action);
				const streak = mutationFailed ? (previous?.isError ? previous.streak + 1 : 1) : 0;
				lastResultByAction.set(action, { isError: mutationFailed, streak });
				if (streak === 2) {
					add({
						kind: "tool_error_streak",
						entryId: entry.id,
						timestamp: entry.timestamp,
						detail: { tool: toolName, category: toolErrorCategory(resultText) },
						...withExcerpt({ error: clip(resultText) }),
					});
				}
				if (mutationFailed && call?.path && EDIT_TOOLS.has(toolName)) failedEditPaths.set(call.path, entry.id);
			}
		}

		// Resolved after the walk, because the answer is what the session did *next*.
		resolveInterruptCauses(path, aborts.map((abort) => ({ index: abort.index, requestText: abort.requestText, detail: abort.incident.detail })));
	}

	for (const failure of compactionFailuresFromTrace(options.traceLines ?? [], String(header.timestamp ?? ""))) {
		add({ kind: failure.kind, entryId: failure.entryId, timestamp: failure.timestamp, detail: failure.detail });
	}

	const list = [...incidents.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
	const incidentCounts: Partial<Record<IncidentKind, number>> = {};
	for (const incident of list) incidentCounts[incident.kind] = (incidentCounts[incident.kind] ?? 0) + 1;
	const modelTurns: Record<string, number> = {};
	for (const id of userEntries) {
		const model = shared.turnModels.get(id);
		if (model) modelTurns[model] = (modelTurns[model] ?? 0) + 1;
	}
	const started = resolveStartedAt(header.timestamp, entries[0]?.timestamp, options.fileMtimeMs);
	const release = releaseOf(lines);
	const runtimeVersion = runtimeVersionOf(options.traceLines);
	const star = northStar(list, intervenedUserEntries.size);
	const failures = FAILURE_KINDS.reduce((sum, kind) => sum + (incidentCounts[kind] ?? 0), 0);

	return {
		session: {
			sessionId,
			sessionFile: options.sessionFile,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			startedAt: started.startedAt,
			startedAtSource: started.startedAtSource,
			modelTurns,
			...(release ? { release } : {}),
			models: [...models].sort(),
			userTurns: userEntries.size,
			assistantMessages: assistantEntries.size,
			toolCalls: toolCallIds.size,
			toolErrors: toolErrorIds.size,
			interventions: star.interventions,
			interruptExcluded: star.interruptExcluded,
			interventionModels: star.interventionModels,
			northStarV2: star.northStarV2,
			v2Models: star.v2Models,
			interruptTriage: star.interruptTriage,
			...(runtimeVersion ? { runtimeVersion } : {}),
			failures,
			incidentCounts,
		},
		incidents: list,
	};
}
