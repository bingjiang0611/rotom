import { createHash } from "node:crypto";

export const CONTEXT_FOOTPRINT_SCHEMA_V1 = "dev-agent-context-footprint/v1";

export const TOOL_FOOTPRINT_GROUPS_V1 = {
	core: ["read", "bash", "edit", "write"],
	"Deferred Tool Loader": ["search_tools"],
	Browser: ["browser_inspect", "browser_interact"],
	"Computer Use": [
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
	],
	Subagent: ["subagent", "subagent_wait"],
	Ask: ["ask_user_question"],
};

function utf8Bytes(value) {
	return Buffer.byteLength(value, "utf8");
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function toolSchemaPayload(tool) {
	return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
}

function guidelinePayload(tool) {
	return JSON.stringify(tool.promptGuidelines ?? []);
}

function approximateTokens(bytes) {
	return Math.ceil(bytes / 4);
}

function groupForTool(name) {
	for (const [group, names] of Object.entries(TOOL_FOOTPRINT_GROUPS_V1)) {
		if (names.includes(name)) return group;
	}
	return "Unclassified";
}

function measureContextFiles(contextFiles = []) {
	const entries = contextFiles
		.map((file) => ({
			path: file.path,
			contentBytes: utf8Bytes(file.content ?? ""),
			pathBytes: utf8Bytes(file.path ?? ""),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	return { entries, contentBytes: entries.reduce((sum, entry) => sum + entry.contentBytes, 0) };
}

function measureSkills(skills = []) {
	const entries = skills
		.map((skill) => {
			const location = skill.filePath ?? skill.path ?? "";
			const payload = JSON.stringify({ name: skill.name, description: skill.description, location });
			return { name: skill.name, description: skill.description, location, metadataBytes: utf8Bytes(payload) };
		})
		.sort((left, right) => left.name.localeCompare(right.name) || left.location.localeCompare(right.location));
	return { entries, metadataBytes: entries.reduce((sum, entry) => sum + entry.metadataBytes, 0) };
}

export function measureContextFootprint({
	systemPrompt,
	allTools,
	activeToolNames,
	contextFiles = [],
	skills = [],
}) {
	const active = new Set(activeToolNames);
	const guidelineCounts = new Map();
	for (const tool of allTools.filter((tool) => active.has(tool.name))) {
		for (const guideline of tool.promptGuidelines ?? []) {
			if (typeof guideline === "string") guidelineCounts.set(guideline, (guidelineCounts.get(guideline) ?? 0) + 1);
		}
	}
	const repeatedGuidelines = [...guidelineCounts].filter(([, count]) => count > 1)
		.map(([text, occurrences]) => ({ sha256: digest(text), occurrences, repeatedMetadataBytes: utf8Bytes(text) * (occurrences - 1) }))
		.sort((a, b) => b.repeatedMetadataBytes - a.repeatedMetadataBytes || a.sha256.localeCompare(b.sha256));
	const measuredTools = allTools
		.filter((tool) => active.has(tool.name))
		.map((tool) => {
			const schemaPayload = toolSchemaPayload(tool);
			const guidelinesPayload = guidelinePayload(tool);
			return {
				name: tool.name,
				group: groupForTool(tool.name),
				schemaBytes: utf8Bytes(schemaPayload),
				descriptionBytes: utf8Bytes(tool.description ?? ""),
				parameterSchemaBytes: utf8Bytes(JSON.stringify(tool.parameters ?? {})),
				guidelineBytes: utf8Bytes(guidelinesPayload),
				schemaSha256: digest(schemaPayload),
			};
		})
		.sort((left, right) => right.schemaBytes - left.schemaBytes || left.name.localeCompare(right.name));
	const grouped = new Map();
	for (const tool of measuredTools) {
		const current = grouped.get(tool.group) ?? { group: tool.group, tools: [], schemaBytes: 0, guidelineBytes: 0 };
		current.tools.push(tool.name);
		current.schemaBytes += tool.schemaBytes;
		current.guidelineBytes += tool.guidelineBytes;
		grouped.set(tool.group, current);
	}
	const orderedGroups = [...Object.keys(TOOL_FOOTPRINT_GROUPS_V1), "Unclassified"]
		.map((group) => grouped.get(group) ?? { group, tools: [], schemaBytes: 0, guidelineBytes: 0 })
		.filter((group) => group.tools.length > 0);
	const context = measureContextFiles(contextFiles);
	const skillCatalog = measureSkills(skills);
	const systemPromptBytes = utf8Bytes(systemPrompt);
	const activeToolSchemaBytes = measuredTools.reduce((sum, tool) => sum + tool.schemaBytes, 0);
	const activeToolGuidelineBytes = measuredTools.reduce((sum, tool) => sum + tool.guidelineBytes, 0);
	const combinedStaticBytes = systemPromptBytes + activeToolSchemaBytes;
	return {
		schema: CONTEXT_FOOTPRINT_SCHEMA_V1,
		measurement: {
			units: "utf8-bytes",
			approximateTokenProxy: "ceil(utf8-bytes/4); not provider-exact",
			toolSchemaPayload: "JSON.stringify({name,description,parameters})",
			promptGuidelinePayload: "JSON.stringify(promptGuidelines ?? [])",
			repeatedGuidelines: "exact repetitions in active tool metadata; Pi may deduplicate the rendered prompt; not token savings",
		},
		systemPromptBytes,
		systemPromptSha256: digest(systemPrompt),
		registeredToolCount: allTools.length,
		activeToolCount: measuredTools.length,
		activeToolNamesSha256: digest(JSON.stringify([...active])),
		repeatedGuidelines,
		activeToolSchemaBytes,
		activeToolGuidelineBytes,
		combinedStaticBytes,
		approximateTokenProxy: {
			systemPrompt: approximateTokens(systemPromptBytes),
			activeToolSchemas: approximateTokens(activeToolSchemaBytes),
			combinedStatic: approximateTokens(combinedStaticBytes),
			contextFileContents: approximateTokens(context.contentBytes),
			skillCatalogMetadata: approximateTokens(skillCatalog.metadataBytes),
		},
		contextFiles: context,
		skillCatalog,
		groups: orderedGroups,
		tools: measuredTools,
	};
}
