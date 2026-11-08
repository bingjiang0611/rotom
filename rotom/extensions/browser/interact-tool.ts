import { defineTool } from "@earendil-works/pi-coding-agent";
import { BROWSER_INTERACT_TOOL_V1, BROWSER_INTERACT_OPERATIONS_V1, BROWSER_INTERACTION_ACTIONS_V1, BROWSER_INTERACTION_KEYS_V1, BROWSER_INTERACTION_MODIFIERS_V1, MAX_DIALOG_PROMPT_CHARS_V1 } from "./browser-relay.ts";
import { BROWSER_SHARED_PROMPT_GUIDELINES } from "./tool-contract.ts";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { MAX_UPLOAD_FILES_V1 } from "./upload-guard.ts";
import { INTERACTION_EXPECTATIONS } from "./chrome-extension/interaction-target-state.js";
import { MAX_BATCH_STEPS_V1, parseBatchActionsV1, batchErrorOutcomeV1, batchStepOutcomeV1, batchStepSummaryV1 } from "./batch-actions.ts";
import { browserResult } from "./tool-results.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
import { executeBrowserInteractionV1 } from "./interact-execute.ts";
export function registerBrowserInteractV1(pi: ExtensionAPI, runtime: BrowserRuntimeV1) {
	pi.registerTool(defineTool({
		name: BROWSER_INTERACT_TOOL_V1,
		exposure: "model-only",
		label: "Browser Interact",
		description: "Interact via refs; coordinate clicks need latest screenshot epoch.",
		promptSnippet: "Interact with a relay tab; prefer refs, fresh coordinates only when no ref exists. Main agents need no approval.",
		promptGuidelines: [
			...BROWSER_SHARED_PROMPT_GUIDELINES,
			"keypress requires targetRef, a key from the enum, and optional Shift/Control/Alt/Meta; a chorded key never types.",
			"Prefer targetRef from the latest snapshot_visible. Plain-page scroll may omit it; nested lists, panels, or iframes must pass a visible descendant ref for the nearest scroll container.",
			"Unchanged text may be omitted (omittedUnchangedTextNodes/textBaselineEpoch). acknowledged proves dispatch, not business success. scroll dispatchSettled=false is deadline ambiguity; moved=false: no measured movement. Unknown writes may have executed: recover/snapshot are read-only checks, never re-dispatch. Do not loop; at most one snapshot_visible.",
			"Judge page-alert nodes and effect.target; changed=null is unknown, not unchanged. Optional expect (checked|expanded|selected|disabled|connected|focused|valid=true|false, value=empty|nonempty) needs a targetRef click, type, select, or keypress; met is target evidence, not business success.",
		],
		parameters: Type.Object({
			operation: StringEnum(BROWSER_INTERACT_OPERATIONS_V1),
			tabName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
			action: Type.Optional(StringEnum(BROWSER_INTERACTION_ACTIONS_V1, { description: "One action to run; mutually exclusive with `actions`." })),
			actions: Type.Optional(Type.Array(Type.Object({
				action: StringEnum(BROWSER_INTERACTION_ACTIONS_V1),
				targetRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				key: Type.Optional(StringEnum(BROWSER_INTERACTION_KEYS_V1)),
				modifiers: Type.Optional(Type.Array(StringEnum(BROWSER_INTERACTION_MODIFIERS_V1), { maxItems: 4 })),
				dropRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: MAX_UPLOAD_FILES_V1 })),
				accept: Type.Optional(Type.Boolean()),
				promptText: Type.Optional(Type.String({ maxLength: MAX_DIALOG_PROMPT_CHARS_V1 })),
				x: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
				y: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
				observationEpoch: Type.Optional(Type.Integer({ minimum: 1 })),
				text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
				replace: Type.Optional(Type.Boolean()),
				option: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
				expect: Type.Optional(StringEnum(INTERACTION_EXPECTATIONS)),
				direction: Type.Optional(StringEnum(["up", "down"] as const)),
				amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
			}, { additionalProperties: false }), { minItems: 1, maxItems: MAX_BATCH_STEPS_V1, description: "Batch: up to 10 sequential actions on one tab. Stops at the first failure, unknown outcome, navigation, blocking dialog or unmet expect. Mutually exclusive with `action`." })),
			key: Type.Optional(StringEnum(BROWSER_INTERACTION_KEYS_V1)),
			modifiers: Type.Optional(Type.Array(StringEnum(BROWSER_INTERACTION_MODIFIERS_V1), { maxItems: 4, description: "keypress only: modifier keys held for this key." })),
			dropRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "drag only: the ref the pointer is released over." })),
			paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: MAX_UPLOAD_FILES_V1, description: "upload only: absolute paths of the files to attach to a file input." })),
			accept: Type.Optional(Type.Boolean({ description: "dialog only: accept (true) or dismiss (false) the open JS dialog." })),
			promptText: Type.Optional(Type.String({ maxLength: MAX_DIALOG_PROMPT_CHARS_V1, description: "dialog only: answer typed into a prompt dialog; requires accept=true." })),
			targetRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			x: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
			y: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
			observationEpoch: Type.Optional(Type.Integer({ minimum: 1 })),
			text: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			replace: Type.Optional(Type.Boolean()),
			option: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
			expect: Type.Optional(StringEnum(INTERACTION_EXPECTATIONS, { description: "Target-state check for a ref-bound action, not navigation or arbitrary text. A met check does not prove business completion." })),
			direction: Type.Optional(StringEnum(["up", "down"] as const)),
			amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
			const batch = parseBatchActionsV1(rawParams as Record<string, unknown>);
			if (batch === undefined)
				return executeBrowserInteractionV1(pi, runtime, toolCallId, rawParams as Record<string, unknown>, signal, ctx);
			// One step at a time, reusing the single-action path so validation, lease checks,
			// upload guards and per-step audit are identical. Already dispatched steps are
			// never replayed: the loop stops at the first step it cannot prove continued.
			const steps: Array<Record<string, unknown>> = [];
			let previous: {
				tabId?: number;
				documentGeneration?: number;
			} = {};
			let stopReason: string | undefined;
			let stoppedAt: number | undefined;
			for (const [index, step] of batch.steps.entries()) {
				let details: Record<string, unknown>;
				try {
					const result = await executeBrowserInteractionV1(pi, runtime, `${toolCallId}:${index + 1}`, { operation: "execute", ...(batch.tabName === undefined ? {} : { tabName: batch.tabName }), ...step }, signal, ctx);
					details = result.details as Record<string, unknown>;
				}
				catch (error) {
					const outcome = batchErrorOutcomeV1(error);
					steps.push({ index, action: step.action, status: outcome.reason, error: error instanceof Error ? error.message : String(error) });
					stopReason = outcome.reason;
					stoppedAt = index;
					break;
				}
				const outcome = batchStepOutcomeV1(details, previous);
				steps.push(batchStepSummaryV1(index, step.action, details, outcome.stop ? outcome.reason : "ok"));
				if (outcome.stop) {
					stopReason = outcome.reason;
					stoppedAt = index;
					break;
				}
				previous = { tabId: outcome.tabId, documentGeneration: outcome.documentGeneration };
			}
			return browserResult({ kind: "browser-batch-result", steps, completed: stopReason === undefined, ...(stoppedAt === undefined ? {} : { stoppedAt }), ...(stopReason === undefined ? {} : { stopReason }) });
		},
	}));
}
