import { BROWSER_INSPECT_TOOL_V1, BROWSER_INSPECT_OPERATIONS_V1, BROWSER_OPEN_PLACEMENTS_V1, BROWSER_NAVIGATE_HISTORY_V1, BROWSER_CONSOLE_LEVELS_V1, BROWSER_NETWORK_RESOURCE_TYPES_V1 } from "./browser-relay.ts";
import { BROWSER_SHARED_PROMPT_GUIDELINES } from "./tool-contract.ts";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { executeBrowserInspectV1 } from "./inspect-execute.ts";
export function registerBrowserInspectV1(pi: ExtensionAPI, runtime: BrowserRuntimeV1) {
	pi.registerTool(defineTool({
		name: BROWSER_INSPECT_TOOL_V1,
		exposure: "model-only",
		label: "Browser Inspect",
		description: "Manage Chrome relay tabs. snapshot traverses virtualized content with completion evidence; snapshot_visible covers current DOM only.",
		promptSnippet: "Inspect Chrome pages; snapshot is the full-content path. Main agents need no approval.",
		promptGuidelines: [
			...BROWSER_SHARED_PROMPT_GUIDELINES,
			"open: named background tab, no focus; placement=agent-window uses one never-focused window per agent. HTTP(S) only; serve HTML via HTTP. discover then claim: tabId + new tabName; handoff returns claimed user tabs.",
			"transfer hands a tab to another agent of the same root session as tabName@yourAgentId; refs and coordinates start fresh.",
			"snapshot and read_full traverse virtualized scroll containers and restore position; use cursor pagination, not manual scrolling, reopening, or reclaiming. Full-text claims need scrolledContainers>0.",
			"Use snapshot_visible to refresh refs, browser_interact for actions, screenshot only for ref-less controls; screenshots are sensitive content.",
			"snapshot_visible text (case-insensitive name substring) AND role (exact) filter bounded AX/text in Relay before the AX cap. scanTruncated/matchesTruncated mark limits, not whole-page absence. Continue nextCursor without filters.",
		],
		parameters: Type.Object({
			operation: StringEnum(BROWSER_INSPECT_OPERATIONS_V1),
			tabName: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Required for open and claim: a new owned tab name. Other operations may use the current owned tab." })),
			tabId: Type.Optional(Type.Integer({ minimum: 0, description: "Required for claim: the tabId returned by discover." })),
			placement: Type.Optional(StringEnum(BROWSER_OPEN_PLACEMENTS_V1)),
			toAgentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Required for transfer: receiving agentId in the same root session." })),
			url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Required for open, or for navigate without history: an HTTP(S) URL." })),
			history: Type.Optional(StringEnum(BROWSER_NAVIGATE_HISTORY_V1, { description: "navigate only: back, forward or reload instead of a URL." })),
			level: Type.Optional(StringEnum(BROWSER_CONSOLE_LEVELS_V1, { description: "console only: verbose, info, warning or error." })),
			pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "console only: case-insensitive substring, never a regular expression." })),
			sinceCursor: Type.Optional(Type.String({ minLength: 2, maxLength: 32, description: "console or network only: the nextCursor value from a previous call." })),
			failedOnly: Type.Optional(Type.Boolean({ description: "network only: keep requests with a failure reason or a >= 400 status." })),
			resourceType: Type.Optional(StringEnum(BROWSER_NETWORK_RESOURCE_TYPES_V1, { description: "network only: filter by resource type." })),
			status: Type.Optional(StringEnum(["loading", "complete"] as const)),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })),
			all: Type.Optional(Type.Boolean()),
			cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			limit: Type.Optional(Type.Integer({ minimum: 1 })),
			text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		}, { additionalProperties: false }),
		// Reading one tab no longer blocks reading another: the relay serializes per tab
		// (`snapshot`/`screenshot`/`wait`...) and only structural operations take the
		// session lock. Writes stay sequential in browser_interact.
		executionMode: "parallel",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeBrowserInspectV1(runtime, params, signal, ctx);
		},
	}));
}
