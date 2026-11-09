import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";
import { decideRollover, type RolloverDecision, type RolloverEstimate, type RolloverState } from "./eligibility.ts";
import { buildRolloverSummary } from "./summary.ts";

/** Mirrors `ROLLOVER_DETAILS_KIND` in Pi's `core/messages.ts`; Pi projects entries with this kind. */
export const ROLLOVER_DETAILS_KIND = "rotom-rollover";
const ROLLOVER_DETAILS = { kind: ROLLOVER_DETAILS_KIND, version: 1 } as const;

/**
 * Read only the fields the decision uses. `stale` matters: right after a compaction the estimate is
 * a message estimate of the pre-compaction context, which threshold compaction itself ignores.
 */
function readEstimate(ctx: ExtensionContext): RolloverEstimate | undefined {
	const estimate = ctx.getContextThresholdEstimate();
	if (!estimate) return undefined;
	const { tokens, contextWindow, reserveTokens, enabled, stale } = estimate;
	return { tokens, contextWindow, reserveTokens, enabled, stale };
}

/** Read the current state once, so one decision sees one consistent snapshot. */
function readState(pi: ExtensionAPI, ctx: ExtensionContext, trigger: RolloverState["trigger"], input?: RolloverState["input"]): RolloverState {
	return {
		trigger,
		model: ctx.model,
		estimate: readEstimate(ctx),
		sessionFile: ctx.sessionManager.getSessionFile(),
		activeTools: pi.getActiveTools(),
		branch: ctx.sessionManager.getBranch(),
		idle: ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		...(input ? { input } : {}),
	};
}

/** A failed append may still have written the entry: read the branch back instead of appending again. */
export function entryWasAppended(
	readLeaf: () => string | null,
	readEntry: (id: string) => SessionEntry | undefined,
	leafBefore: string | null,
): boolean {
	const leaf = readLeaf();
	if (leaf === null || leaf === leafBefore) return false;
	const entry = readEntry(leaf);
	return entry?.type === "compaction" && (entry.details as { kind?: unknown } | undefined)?.kind === ROLLOVER_DETAILS_KIND;
}

/** One rollover: build the deterministic summary, then reset the context through Pi's seam. */
async function rollover(ctx: ExtensionContext, decision: Extract<RolloverDecision, { allowed: true }>): Promise<void> {
	const notify = (message: string) => ctx.ui.notify(message, "warning");
	let summary: string;
	try {
		summary = buildRolloverSummary(ctx.sessionManager.getBranch(), decision.reserveTokens);
	} catch (error) {
		notify(COPY.summaryFailed(error instanceof Error ? error.message : String(error)));
		return;
	}

	const leafBefore = ctx.sessionManager.getLeafId();
	const result = await ctx.resetContext({ summary, details: ROLLOVER_DETAILS });
	if (result.status === "applied") return;
	if (result.status === "cancelled") {
		notify(COPY.cancelled(result.reason));
		return;
	}
	const appended = entryWasAppended(
		() => ctx.sessionManager.getLeafId(),
		(id) => ctx.sessionManager.getEntry(id),
		leafBefore,
	);
	notify(appended ? COPY.appliedDespiteError(result.reason) : COPY.failed(result.reason));
}

/**
 * Same-session rollover. Off by default: `ROTOM_SESSION_ROLLOVER=1` registers the handlers, any
 * other value registers nothing at all.
 */
export default function sessionRollover(pi: ExtensionAPI): void {
	if (process.env.ROTOM_SESSION_ROLLOVER !== "1") return;

	pi.on("input", async (event, ctx) => {
		const input = { text: event.text, source: event.source, streamingBehavior: event.streamingBehavior };
		const decision = decideRollover(readState(pi, ctx, "input", input));
		if (decision.allowed) await rollover(ctx, decision);
		return undefined;
	});

	pi.on("session_before_compact", (event, ctx) => {
		// Only the after-run threshold compaction is deferred to the next submission; in-run
		// compaction, overflow recovery and explicit requests keep their existing path.
		if (event.reason !== "threshold" || event.phase !== "after-run") return undefined;
		return decideRollover(readState(pi, ctx, "after-run")).allowed ? { cancel: true as const } : undefined;
	});
}
