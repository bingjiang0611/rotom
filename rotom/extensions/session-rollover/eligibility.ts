import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Mirrors `VIRTUAL_MODEL_API` in Pi's `core/virtual-models.ts`. Extensions receive the model object
 * but not that constant, and a virtual selection routes to a physical model whose window is unknown.
 */
const VIRTUAL_MODEL_API = "pi-virtual";

/** Eligibility rules of design 4.2, each mechanically decided from runtime state or branch entries. */
export type BlockReason =
	| "not-idle"
	| "pending-messages"
	| "unfinished-turn"
	| "unpaired-tool-call"
	| "no-model"
	| "virtual-model"
	| "compaction-disabled"
	| "no-session"
	| "no-recall-tool"
	| "local-command"
	| "extension-input"
	| "streaming-input"
	| "goal-active"
	| "below-watermark";

/** Tool that makes cleared history searchable; without it a rollover would lose the context for good. */
export const RECALL_TOOL = "context_recall";
/** Persisted goal entry written by the Goal extension. */
export const GOAL_STATE_ENTRY = "goal-state";

export interface RolloverEstimate {
	tokens: number;
	contextWindow: number;
	reserveTokens: number;
	enabled: boolean;
}

export interface RolloverInput {
	text: string;
	source: string;
	streamingBehavior?: "steer" | "followUp";
}

/** Everything the decision reads, so tests can vary one field at a time. */
export interface RolloverState {
	/** `input` decides before a submission; `after-run` decides whether to defer a threshold compaction. */
	trigger: "input" | "after-run";
	model: { api: string } | undefined;
	estimate: RolloverEstimate | undefined;
	sessionFile: string | undefined;
	activeTools: readonly string[];
	branch: readonly SessionEntry[];
	idle: boolean;
	pendingMessages: boolean;
	input?: RolloverInput;
}

export type RolloverDecision =
	| { allowed: true; tokens: number; reserveTokens: number }
	| { allowed: false; reason: BlockReason };

/** Inter-turn water mark: one full reserve below the compaction threshold (design 4.1). */
export function rolloverWatermark(contextWindow: number, reserveTokens: number): number {
	return contextWindow - 2 * reserveTokens;
}

/** The last assistant message must have finished, and every tool call in it must have a result. */
function unfinishedTurn(branch: readonly SessionEntry[]): BlockReason | undefined {
	const index = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (index < 0) return undefined;
	const message = branch[index];
	if (message?.type !== "message" || message.message.role !== "assistant") return undefined;
	if (message.message.stopReason !== "stop") return "unfinished-turn";
	const callIds = message.message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
	if (callIds.length === 0) return undefined;
	const results = new Set<string>();
	for (const entry of branch.slice(index + 1)) {
		if (entry.type === "message" && entry.message.role === "toolResult") results.add(entry.message.toolCallId);
	}
	return callIds.some((id) => !results.has(id)) ? "unpaired-tool-call" : undefined;
}

/** Goal state is persisted as a custom entry; `active` includes waiting and provider-recovery waits. */
function goalIsActive(branch: readonly SessionEntry[]): boolean {
	const entry = branch.findLast((item) => item.type === "custom" && item.customType === GOAL_STATE_ENTRY);
	if (entry?.type !== "custom") return false;
	const status = (entry.data as { goal?: { status?: unknown } } | undefined)?.goal?.status;
	return status === "active";
}

export function decideRollover(state: RolloverState): RolloverDecision {
	const block = (reason: BlockReason): RolloverDecision => ({ allowed: false, reason });

	// A run that just ended is not idle by definition; after-run only waits for queued work.
	if (state.pendingMessages) return block("pending-messages");
	if (state.trigger === "input" && !state.idle) return block("not-idle");
	const unfinished = unfinishedTurn(state.branch);
	if (unfinished) return block(unfinished);
	const estimate = state.estimate;
	if (!estimate) return block("no-model");
	if (state.model?.api === VIRTUAL_MODEL_API) return block("virtual-model");
	if (!estimate.enabled) return block("compaction-disabled");
	if (state.sessionFile === undefined) return block("no-session");
	if (!state.activeTools.includes(RECALL_TOOL)) return block("no-recall-tool");
	if (state.trigger === "input") {
		const input = state.input;
		if (!input) return block("extension-input");
		if (input.source !== "interactive" && input.source !== "rpc") return block("extension-input");
		if (input.streamingBehavior !== undefined) return block("streaming-input");
		// Local commands such as /model or /new do not dispatch a model request to roll over before.
		if (input.text.trimStart().startsWith("/")) return block("local-command");
	}
	if (goalIsActive(state.branch)) return block("goal-active");
	if (!(estimate.tokens > rolloverWatermark(estimate.contextWindow, estimate.reserveTokens))) {
		return block("below-watermark");
	}
	return { allowed: true, tokens: estimate.tokens, reserveTokens: estimate.reserveTokens };
}
