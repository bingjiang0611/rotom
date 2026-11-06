// Batch actions for browser_interact (T19).
//
// A batch is only a sequence of the same single-action calls, so the rules here are about
// when to stop. Stopping is the whole point: a step whose outcome is unknown may already
// have reached the page, and a page that navigated or opened a dialog invalidates every
// ref the following steps were planned against.

/** Longest accepted batch. */
export const MAX_BATCH_STEPS_V1 = 10;

/** Fields that belong to one action and may appear inside `actions[]`. */
const ACTION_FIELDS_V1 = ["action", "targetRef", "key", "modifiers", "dropRef", "paths", "accept", "promptText", "x", "y", "observationEpoch", "text", "replace", "option", "expect", "direction", "amount"] as const;
/** Fields that address the tool, not one action; a batch may not repeat them per step. */
const REQUEST_FIELDS_V1 = ["operation", "tabName", "actions", "limit", "cursor", "level", "pattern", "sinceCursor", "failedOnly", "resourceType", "status", "timeoutMs", "url", "history", "placement", "tabId", "toAgentId", "text", "role"];

export type BatchStopReasonV1 = "failed" | "unknown" | "navigation" | "dialog-blocking" | "expect-unmet" | "blocked";

/**
 * Split `actions` out of a browser_interact call. Returns `undefined` when this is a single
 * action, so the caller keeps exactly one execution path per action.
 */
export function parseBatchActionsV1(params: Record<string, unknown>) {
	if (params.actions === undefined) {
		if (params.action === undefined) throw new Error("browser_interact 需要 action 或 actions");
		return undefined;
	}
	if (!Array.isArray(params.actions) || params.actions.length === 0) throw new Error("actions 必须是非空数组");
	if (params.actions.length > MAX_BATCH_STEPS_V1) throw new Error(`actions 单次最多 ${MAX_BATCH_STEPS_V1} 步`);
	if (params.action !== undefined) throw new Error("action 与 actions 互斥");
	if (params.operation !== "execute") throw new Error("actions 只允许 operation=execute");
	// A batch carries its own tab; per-step tab switches would silently change the target
	// between steps, so only the call-level `tabName` is honoured.
	const steps = params.actions.map((step, index) => {
		if (step === null || typeof step !== "object" || Array.isArray(step)) throw new Error(`actions[${index}] 必须是对象`);
		const record = step as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!ACTION_FIELDS_V1.includes(key as never)) throw new Error(`actions[${index}] 不接受字段 ${key}`);
		}
		if (record.action === undefined) throw new Error(`actions[${index}] 缺少 action`);
		return record;
	});
	return { tabName: params.tabName, steps };
}

/**
 * An interaction result carries a snapshot page (`{ observation, offset, ... }`); a plain
 * observation is accepted too, so the summary does not depend on which shape arrives.
 */
function readbackObservationV1(value: unknown) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const nested = record.observation;
	if (nested !== undefined && nested !== null && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
	return record;
}

/**
 * Decide whether the batch may continue after one step. `details` is the single-action
 * result the tool produced for that step; `previous` is the state the batch started from.
 */
export function batchStepOutcomeV1(details: Record<string, unknown>, previous: { tabId?: number; documentGeneration?: number }) {
	const kind = details.kind;
	if (kind === "dialog-blocking") return { stop: true, reason: "dialog-blocking" as BatchStopReasonV1 };
	if (kind === "needs-approval") return { stop: true, reason: "blocked" as BatchStopReasonV1 };
	if (kind !== "browser-interaction-result") return { stop: true, reason: "failed" as BatchStopReasonV1 };
	const effect = details.effect === undefined || details.effect === null ? {} : details.effect as Record<string, unknown>;
	const expectation = effect.expectation === undefined || effect.expectation === null ? undefined : effect.expectation as Record<string, unknown>;
	// An unmet expectation is a real answer about the page, not a transport problem: stop
	// so the following steps do not run against a state the caller did not expect.
	if (expectation?.outcome === "unmet") return { stop: true, reason: "expect-unmet" as BatchStopReasonV1 };
	if (effect.dialogOpened === true) return { stop: true, reason: "dialog-blocking" as BatchStopReasonV1 };
	const readback = readbackObservationV1(details.readback);
	const tabId = typeof readback?.tabId === "number" ? readback.tabId : undefined;
	const documentGeneration = typeof readback?.documentGeneration === "number" ? readback.documentGeneration : undefined;
	if (previous.tabId !== undefined && tabId !== undefined && tabId !== previous.tabId) return { stop: true, reason: "navigation" as BatchStopReasonV1 };
	if (previous.documentGeneration !== undefined && documentGeneration !== undefined && documentGeneration !== previous.documentGeneration) return { stop: true, reason: "navigation" as BatchStopReasonV1 };
	return { stop: false, tabId, documentGeneration };
}

/** Status of a step that ended in an exception: unknown is not a failure to retry. */
export function batchErrorOutcomeV1(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	// The single-action path already distinguishes "dispatch may have happened" from
	// "never left this process" in its own message.
	const unknown = /结果 unknown|unknown，dispatch/iu.test(message) || /timeout/iu.test(message);
	return { stop: true as const, reason: (unknown ? "unknown" : "failed") as BatchStopReasonV1 };
}

/**
 * Compact per-step record. A batch of ten steps must not return ten full readbacks: the
 * caller only needs what changed, whether the target state moved, and the digest that ties
 * the step to the same evidence a single action would have produced.
 */
export function batchStepSummaryV1(index: number, action: unknown, details: Record<string, unknown>, status: string) {
	const effect = details.effect === undefined || details.effect === null ? {} : details.effect as Record<string, unknown>;
	const target = effect.target === undefined || effect.target === null ? undefined : effect.target as Record<string, unknown>;
	const expectation = effect.expectation === undefined || effect.expectation === null ? undefined : effect.expectation as Record<string, unknown>;
	const dialog = effect.dialog === undefined || effect.dialog === null ? undefined : effect.dialog as Record<string, unknown>;
	const readback = readbackObservationV1(details.readback);
	return {
		index,
		action: typeof action === "string" ? action : "unknown",
		status,
		acknowledged: details.acknowledged === true,
		...(typeof details.actionId === "string" ? { actionId: details.actionId } : {}),
		...(typeof effect.dispatch === "string" ? { dispatch: effect.dispatch } : {}),
		...(typeof target?.changed === "boolean" || target?.changed === null ? { targetChanged: target.changed } : {}),
		...(typeof expectation?.outcome === "string" ? { expectation: expectation.outcome } : {}),
		...(typeof dialog?.type === "string" ? { dialog: dialog.type } : {}),
		...(typeof readback?.digest === "string" ? { readbackDigest: readback.digest } : {}),
		...(typeof readback?.url === "string" ? { url: readback.url } : {}),
		...(typeof readback?.documentGeneration === "number" ? { documentGeneration: readback.documentGeneration } : {}),
	};
}
