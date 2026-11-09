import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";
import { buildTakeoverSummary } from "./summary.ts";

/** Mirrors `ROLLOVER_DETAILS_KIND` in Pi's `core/messages.ts`; Pi projects entries with this kind. */
export const ROLLOVER_DETAILS_KIND = "rotom-rollover";
const ROLLOVER_DETAILS = { kind: ROLLOVER_DETAILS_KIND, version: 2 } as const;
/** Retrieval tool the takeover summary relies on; without it the native summary path stays. */
const RECALL_TOOL = "context_recall";

/**
 * Same-session context rollover, summary-free: take over the compaction Pi was about to run, write
 * one retrieval entry that keeps the prepared cut point, and let Pi project it.
 *
 * Off by default: `ROTOM_SESSION_ROLLOVER=1` registers the handler, any other value registers
 * nothing at all. Threshold and overflow compaction are taken over; `/compact` and
 * `ctx.compact()` are not.
 */
export default function sessionRollover(pi: ExtensionAPI): void {
	if (process.env.ROTOM_SESSION_ROLLOVER !== "1") return;

	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason !== "threshold" && event.reason !== "overflow") return undefined;
		const preparation = event.preparation;
		if (preparation === undefined) return undefined;
		// Without the retrieval tool the retrieval note would be a dead end.
		if (!pi.getActiveTools().includes(RECALL_TOOL)) return undefined;

		let summary: string;
		try {
			summary = buildTakeoverSummary({
				branch: ctx.sessionManager.getBranch(),
				firstKeptEntryId: preparation.firstKeptEntryId,
				reserveTokens: preparation.settings.reserveTokens,
			});
		} catch (error) {
			ctx.ui.notify(COPY.summaryFailed(error instanceof Error ? error.message : String(error)), "warning");
			return undefined;
		}

		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: ROLLOVER_DETAILS,
			},
		};
	});
}
