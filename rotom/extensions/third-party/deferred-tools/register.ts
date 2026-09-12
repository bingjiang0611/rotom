import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const DEFERRED_TOOLS_ENV = "ROTOM_DEFERRED_TOOLS";
export const DEFERRED_DEFAULT_SURFACE_ENV = "ROTOM_DEFERRED_DEFAULT_SURFACE";
export const LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV = "ROTOM_EXPERIMENTAL_DEFERRED_TOOLS";
export const DEFERRED_TOOL_SEARCH_NAME = "search_tools";
export const DEFERRED_TOOL_STATE_ENTRY = "dev-agent-deferred-tools-state";

export const RESIDENT_BROWSER_TOOL_NAMES = [
	"browser_inspect",
	"browser_interact",
	"find_roots",
	"observe_ui",
	"search_ui",
	"expand_ui",
	"inspect_ui",
	"act_ui",
	"read_text",
	"wait_for",
	"launch_browser",
	"navigate_browser",
	"evaluate_browser",
] as const;

export const DEFERRED_INITIAL_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"ask_user_question",
	...RESIDENT_BROWSER_TOOL_NAMES,
] as const;

export const DEFERRED_TOOL_ROUTING_GUIDELINES = [
	"Specialized Subagent tools are available on demand; call search_tools once before using the needed capability.",
] as const;

export const DEFERRED_CAPABILITY_GROUPS = [
	{
		id: "subagent",
		label: "Subagent",
		aliases: ["subagent", "sub-agent", "agent delegation", "opus subagent", "子agent", "子 agent", "子代理", "委派子代理", "评审子代理"],
		toolNames: ["subagent", "subagent_wait"],
	},
] as const;

export type DeferredCapabilityGroupId = (typeof DEFERRED_CAPABILITY_GROUPS)[number]["id"];

type DeferredToolState = {
	v: 1;
	groups: DeferredCapabilityGroupId[];
};

const GROUP_BY_ID = new Map(DEFERRED_CAPABILITY_GROUPS.map((group) => [group.id, group] as const));
const DEFERRED_TOOL_NAMES = new Set(DEFERRED_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames]));

function normalized(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase();
}

function validGroupId(value: unknown): value is DeferredCapabilityGroupId {
	return typeof value === "string" && GROUP_BY_ID.has(value as DeferredCapabilityGroupId);
}

function restorableStateGroups(value: unknown): DeferredCapabilityGroupId[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { v?: unknown; groups?: unknown };
	if (candidate.v !== 1 || !Array.isArray(candidate.groups)) return undefined;
	// A v1 snapshot restores only capabilities this product actually declares.
	// Unknown string IDs (retired or unavailable) cannot activate tools; avoid a
	// registry of private legacy integrations. Malformed records remain ignored.
	if (!candidate.groups.every((id) => typeof id === "string")) return undefined;
	return canonicalGroupIds(candidate.groups.filter(validGroupId));
}

function enabledByEnvironment(value: string | undefined): boolean {
	return value === undefined || !/^(?:0|false|no)$/iu.test(value.trim());
}

export function deferredToolsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	const configured = environment[DEFERRED_TOOLS_ENV];
	if (configured !== undefined) return enabledByEnvironment(configured);
	return enabledByEnvironment(environment[LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV]);
}

export function matchDeferredCapabilityGroups(query: string, limit = 2): DeferredCapabilityGroupId[] {
	const needle = normalized(query);
	if (!needle) return [];
	const asciiTerms = new Set(needle.split(/[^a-z0-9_-]+/u).filter(Boolean));
	return DEFERRED_CAPABILITY_GROUPS
		.map((group, index) => ({
			group,
			index,
			score: Math.max(needle === normalized(group.label) ? 200 : 0, ...group.aliases.map((alias) => {
				const candidate = normalized(alias);
				const matched = /^[a-z0-9_-]+$/u.test(candidate) ? asciiTerms.has(candidate) : needle.includes(candidate);
				if (!matched) return 0;
				return candidate.length + (needle === candidate ? 100 : 0);
			})),
		}))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, Math.max(1, Math.min(3, limit)))
		.map((candidate) => candidate.group.id);
}

function canonicalGroupIds(groups: Iterable<DeferredCapabilityGroupId>): DeferredCapabilityGroupId[] {
	const selected = new Set(groups);
	return DEFERRED_CAPABILITY_GROUPS
		.filter((group) => selected.has(group.id))
		.map((group) => group.id);
}

function restoreGroups(ctx: ExtensionContext): DeferredCapabilityGroupId[] {
	let restored: DeferredCapabilityGroupId[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DEFERRED_TOOL_STATE_ENTRY) continue;
		const groups = restorableStateGroups(entry.data);
		if (groups !== undefined) restored = groups;
	}
	return restored;
}

function toolsForGroups(groups: Iterable<DeferredCapabilityGroupId>, registered: Set<string>): string[] {
	const tools: string[] = [];
	for (const id of groups) {
		const group = GROUP_BY_ID.get(id);
		if (!group) continue;
		for (const name of group.toolNames) if (registered.has(name)) tools.push(name);
	}
	return [...new Set(tools)];
}

function canonicalActiveTools(active: Iterable<string>): string[] {
	const activeNames = [...new Set(active)];
	const nonDeferred = activeNames.filter((name) => !DEFERRED_TOOL_NAMES.has(name));
	const activeDeferred = new Set(activeNames.filter((name) => DEFERRED_TOOL_NAMES.has(name)));
	return [...nonDeferred, ...toolsForGroups(DEFERRED_CAPABILITY_GROUPS.map((group) => group.id), activeDeferred)];
}

export function registerDeferredTools(pi: ExtensionAPI, environment: NodeJS.ProcessEnv = process.env): void {
	if (!deferredToolsEnabled(environment)) return;

	const restoredGroups = new Set<DeferredCapabilityGroupId>();

	pi.registerTool({
		name: DEFERRED_TOOL_SEARCH_NAME,
		label: "Search Tools",
		description: "Search for and add specialized Subagent tools. Supports English and Chinese queries. Browser and Computer Use tools are already active. Added tools remain active for the session.",
		promptSnippet: "Search for specialized tools before using Subagent capabilities; Browser and Computer Use tools are already active",
		promptGuidelines: [...DEFERRED_TOOL_ROUTING_GUIDELINES],
		executionMode: "sequential",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Capability or task to search for; Chinese and English are supported" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const matches = matchDeferredCapabilityGroups(params.query, params.limit ?? 2);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No specialized capability matched: ${params.query}. Available groups: ${DEFERRED_CAPABILITY_GROUPS.map((group) => group.label).join(", ")}.` }],
					details: { matches: [], added: [] },
				};
			}
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const active = pi.getActiveTools();
			const added = toolsForGroups(matches, registered).filter((name) => !active.includes(name));
			if (added.length > 0) pi.setActiveTools(canonicalActiveTools([...active, ...added]));
			const groups = canonicalGroupIds([...restoredGroups, ...matches]);
			restoredGroups.clear();
			for (const id of groups) restoredGroups.add(id);
			pi.appendEntry(DEFERRED_TOOL_STATE_ENTRY, { v: 1, groups } satisfies DeferredToolState);
			return {
				content: [{ type: "text", text: added.length > 0 ? `Loaded specialized tools: ${added.join(", ")}` : `Matching tools already active: ${toolsForGroups(matches, registered).join(", ")}` }],
				details: { matches, added },
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Only the supported launcher may identify the unfiltered product default.
		// Without this handshake, preserve SDK/runtime and explicit CLI selections.
		if (environment[DEFERRED_DEFAULT_SURFACE_ENV] !== "1") return;
		const allTools = pi.getAllTools();
		const registered = new Set(allTools.map((tool) => tool.name));
		const active = pi.getActiveTools();
		const required = [...DEFERRED_INITIAL_TOOL_NAMES, DEFERRED_TOOL_SEARCH_NAME, ...DEFERRED_TOOL_NAMES];
		if (!required.every((name) => registered.has(name) && active.includes(name))) return;

		restoredGroups.clear();
		for (const id of restoreGroups(ctx)) restoredGroups.add(id);
		const restoredTools = toolsForGroups(canonicalGroupIds(restoredGroups), registered);
		const initial = active.filter((name) => !DEFERRED_TOOL_NAMES.has(name));
		pi.setActiveTools(canonicalActiveTools([...initial, ...restoredTools]));
	});
}
