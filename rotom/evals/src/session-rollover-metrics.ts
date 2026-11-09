import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type RolloverMetrics = {
	correct: boolean;
	requests: number;
	/** Provider-reported usage sums; `usageKnown` is false when any request omitted usage. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	usageKnown: boolean;
	compactions: number;
	nativeSummaries: number;
	rolloverEntries: number;
	/** Provider-reported spend in USD when the model has pricing, otherwise `null` = unknown. */
	costUsd: number | null;
	costUnknownReason: string | null;
	/** Qoder reports credits per request; `null` when the model does not. */
	credits: number | null;
	creditEntries: number;
	/** Short token explaining a wrong verdict; null when the run was correct. */
	gradeReason: string | null;
	/**
	 * File tasks only: whether the created file satisfied its own rule, independent of the final
	 * reply. `null` for tasks graded from the reply alone. This separates "ignored the rule" from
	 * "answered with extra words", which the strict verdict merges.
	 */
	ruleObeyed: boolean | null;
	/** `context_recall` calls, with the query length and whether the result contained the query. */
	recallCalls: number;
	recallQueries: { length: number; hit: boolean }[];
	wallMs: number;
};

/** Summary-call accounting for one finished replay run. Tokens only; no currency conversion. */
export function rolloverMetrics(branch: SessionEntry[], correct: boolean, pricing: boolean, wallMs = 0): RolloverMetrics {
	const metrics: RolloverMetrics = {
		correct,
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		usageKnown: true,
		compactions: 0,
		nativeSummaries: 0,
		rolloverEntries: 0,
		costUsd: null,
		costUnknownReason: pricing ? null : "provider-report-unknown",
		credits: null,
		creditEntries: 0,
		gradeReason: null,
		ruleObeyed: null,
		recallCalls: 0,
		recallQueries: [],
		wallMs,
	};
	const resultsByCallId = new Map<string, string>();
	const pendingQueries: { callId: string; query: string }[] = [];
	const text = (content: unknown) =>
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.flatMap((part: any) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
				: "";
	for (const entry of branch) {
		if (entry.type === "custom" && (entry as any).customType === "qoder-credit-observation-v1") {
			const data = (entry as any).data;
			if (typeof data?.credits === "number" && Number.isFinite(data.credits)) {
				metrics.credits = (metrics.credits ?? 0) + data.credits;
				metrics.creditEntries++;
			}
			continue;
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			resultsByCallId.set((entry.message as any).toolCallId ?? "", text(entry.message.content));
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			if (!usage) {
				metrics.usageKnown = false;
			} else {
				metrics.requests++;
				metrics.inputTokens += usage.input ?? 0;
				metrics.outputTokens += usage.output ?? 0;
				metrics.cacheReadTokens += usage.cacheRead ?? 0;
				metrics.cacheWriteTokens += usage.cacheWrite ?? 0;
				// `cost.total` is Provider reported; summing it is accounting, not a price estimate.
				// A provider with placeholder zero prices reports 0 here; `costUnknownReason` is what
				// marks that sum as "not priced", so readers must check it before quoting a cost.
				const cost = (usage as { cost?: { total?: number } }).cost?.total;
				if (typeof cost === "number" && Number.isFinite(cost)) metrics.costUsd = (metrics.costUsd ?? 0) + cost;
			}
			for (const part of (entry.message as any).content ?? []) {
				if (part.type !== "toolCall" || part.name !== "context_recall") continue;
				const query = part.arguments?.query;
				metrics.recallCalls++;
				if (typeof query === "string") pendingQueries.push({ callId: part.id, query });
			}
			continue;
		}
		if (entry.type !== "compaction") continue;
		metrics.compactions++;
		if (entry.fromHook === true) {
			if ((entry.details as { kind?: unknown } | undefined)?.kind === "rotom-rollover") metrics.rolloverEntries++;
		} else metrics.nativeSummaries++;
	}
	// A query counts as a hit when the retrieved text repeats it; the query itself is never recorded.
	for (const { callId, query } of pendingQueries) {
		const result = resultsByCallId.get(callId) ?? "";
		metrics.recallQueries.push({ length: query.length, hit: result.toLowerCase().includes(query.toLowerCase()) });
	}
	return metrics;
}
