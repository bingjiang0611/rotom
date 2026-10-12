import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planFold, recallBlock, renderOutline, searchHidden } from "./fold.ts";

export const CONTEXT_FOLD_ENV = "ROTOM_CONTEXT_FOLD";
export const CONTEXT_TOOL_NAME = "context";
const OUTLINE_DEFAULT_LIMIT = 80;
// First reminder at half the window, then once per further 10 points of growth.
const NUDGE_START_BUCKET = 5;

/** Opt-in until real long-session A/B evidence exists. Invalid values fail loudly. */
export function contextFoldEnabled(env: NodeJS.ProcessEnv): boolean {
	const value = env[CONTEXT_FOLD_ENV];
	if (value === undefined || value === "0") return false;
	if (value === "1") return true;
	throw new Error(`${CONTEXT_FOLD_ENV} must be 0 or 1`);
}

export const CONTEXT_TOOL_DESCRIPTION = [
	"Manage your own context window. Actions:",
	"- outline: list visible history (oldest first) with step ids, tools, size estimates and the fold ranges that are safe to fold now.",
	"- fold: replace completed tool steps from..to (step ids from outline, inside one user turn) with your summary. It takes effect when the current step ends. A fold block stays in context as your own completed work, listing the calls that were folded; the originals stay retrievable with recall.",
	"- recall: read folded originals with block=bN (paged by offset), or search hidden history with query. Results are historical, not current state.",
].join("\n");

export const CONTEXT_TOOL_GUIDELINES = [
	"Fold rarely and in large chunks: each fold invalidates the provider prompt cache after the fold point. Prefer old, finished, tool-heavy ranges.",
	"A fold summary must keep decisions, file paths, commands, key results, current state and open issues; omit raw output you can re-read.",
	"Recalled content is historical. Read a file again for its current content instead of trusting a recalled copy.",
];

const parameters = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["outline", "fold", "recall"] },
		from: { type: "string", description: "fold: first step id" },
		to: { type: "string", description: "fold: last step id (its tool results are included)" },
		summary: { type: "string", description: "fold: replacement summary" },
		block: { type: "string", description: "recall: fold block id such as b3" },
		query: { type: "string", description: "recall: case-insensitive text to search in hidden history" },
		offset: { type: "integer", minimum: 0, description: "outline/recall: page offset" },
	},
	required: ["action"],
	additionalProperties: false,
} as const;

type Params = { action: "outline" | "fold" | "recall"; from?: string; to?: string; summary?: string; block?: string; query?: string; offset?: number };
type Pending = { toolCallId: string; from: string; to: string; summary: string };

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });
const failure = (value: string) => { throw new Error(value); };

/** The persisted assistant entry that issued this tool call; it and later entries are not foldable. */
function currentStepId(branch: readonly any[], toolCallId: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const message = branch[index].message;
		if (message?.role === "assistant" && message.content?.some((part: any) => part?.type === "toolCall" && part.id === toolCallId)) return branch[index].id;
	}
	return undefined;
}

export default function contextFold(pi: ExtensionAPI): void {
	if (!contextFoldEnabled(process.env)) return;
	let pending: Pending | undefined;
	let lastNudgeBucket = 0;

	pi.registerTool({
		name: CONTEXT_TOOL_NAME,
		label: "Context",
		description: CONTEXT_TOOL_DESCRIPTION,
		promptSnippet: "Outline, fold or recall your own conversation history to keep the context window small",
		promptGuidelines: CONTEXT_TOOL_GUIDELINES,
		exposure: "model-only",
		executionMode: "sequential",
		parameters: parameters as any,
		async execute(toolCallId: string, params: Params, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const manager = ctx.sessionManager;
			const branch = manager.getBranch();
			const projection = manager.buildSessionProjection().entries;
			const currentEntryId = currentStepId(branch, toolCallId);
			if (params.action === "outline") {
				const page = renderOutline(projection, branch, { currentEntryId, offset: params.offset ?? 0, limit: OUTLINE_DEFAULT_LIMIT, usage: ctx.getContextUsage() });
				return text(page.text, { action: "outline", rows: page.total });
			}
			if (params.action === "recall") {
				if ((params.block === undefined) === (params.query === undefined)) failure("recall needs exactly one of block or query.");
				const result = params.block !== undefined ? recallBlock(branch, params.block, params.offset ?? 0) : searchHidden(projection, branch, params.query!);
				if (!result.ok) failure(result.error);
				return text(result.text, { action: "recall" });
			}
			if (params.from === undefined || params.to === undefined || params.summary === undefined) failure("fold needs from, to and summary.");
			if (pending) failure("Another fold is already scheduled in this step; fold again in a later step.");
			const plan = planFold(projection, branch, { from: params.from!, to: params.to!, summary: params.summary!, currentEntryId });
			if (!plan.ok) failure(plan.error);
			pending = { toolCallId, from: params.from!, to: params.to!, summary: params.summary! };
			const { block, steps, foldedChars } = plan as Extract<typeof plan, { ok: true }>;
			return text(`Fold ${block} scheduled: ${steps} step(s), ~${Math.ceil(foldedChars / 4)} tokens (estimate). It is applied when this step ends; context outline shows the committed state.`, { action: "fold", block, steps });
		},
	} as any);

	pi.on("session_start", () => {
		pending = undefined;
		lastNudgeBucket = 0;
	});

	// Context edits can only be committed at a boundary. Re-plan against the committed
	// projection: if another handler invalidates the boundary, Pi drops every draft and
	// the fold is simply absent (outline remains the source of truth).
	pi.on("turn_end", (event: any, ctx: any) => {
		const scheduled = pending;
		pending = undefined;
		if (!scheduled) return undefined;
		const result = event.toolResults.find((item: any) => item.toolCallId === scheduled.toolCallId);
		if (!result || result.isError) return undefined;
		const manager = ctx.sessionManager;
		const plan = planFold(manager.buildSessionProjection().entries, manager.getBranch(), { ...scheduled, currentEntryId: event.messageEntryId });
		if (!plan.ok) return undefined;
		return { entries: [...event.entries, ...plan.drafts] };
	});

	// The reminder is appended to a real tool result, so it is persisted and stays
	// byte-stable in later requests instead of shifting the cached prefix.
	pi.on("tool_result", (event: any, ctx: any) => {
		if (event.toolName === CONTEXT_TOOL_NAME) return undefined;
		const usage = ctx.getContextUsage?.();
		if (usage?.percent == null) return undefined;
		const bucket = Math.floor(usage.percent / 10);
		if (bucket < lastNudgeBucket) lastNudgeBucket = bucket;
		if (bucket < NUDGE_START_BUCKET || bucket <= lastNudgeBucket) return undefined;
		lastNudgeBucket = bucket;
		return { content: [...event.content, { type: "text" as const, text: `[context: ~${Math.round(usage.percent)}% of the context window is used. If older finished tool steps are no longer needed verbatim, run context outline and fold one large range.]` }] };
	});
}
