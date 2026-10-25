import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";

export function result(bytes = 8192, toolCallId = "call-a", toolName = "read"): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "row\n".repeat(Math.floor(bytes / 4)) + "x".repeat(bytes % 4) }], isError: false, timestamp: 1 };
}

// Real AgentSession scheduling and native compaction, using only a local faux provider.
export async function createOffloadSession(cwd: string, sizes: number[], keepRecentTokens = 400, contextWindow = 5000, initialReply = "done") {
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const faux = fauxProvider({ provider: "offload-faux", api: "offload-faux-api", models: [{ id: "offload", contextWindow, maxTokens: 1000 }] });
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens, reserveTokens: 500 }, retry: { enabled: false } });
	const requests: AgentMessage[][] = [];
	const preparations: Array<{ ids: string[]; before: number }> = [];
	let normalCall = 0;
	let largeNextReply = false;
	let summaryCalls = 0;
	const response: FauxResponseFactory = (context, options) => {
		if (options) options.cacheRetention = "none";
		if (context.messages.some((message) => message.role === "system" && contentText(message.content).includes("context summarization assistant"))) {
			summaryCalls++;
			return fauxAssistantMessage("## Goal\nSynthetic test\n## Progress\nTool work done.\n## Next Steps\nContinue testing.");
		}
		requests.push(structuredClone(context.messages) as AgentMessage[]);
		if (normalCall < sizes.length) {
			const index = normalCall++;
			return fauxAssistantMessage(fauxToolCall("synthetic", { index }, { id: `call-${index}` }), { stopReason: "toolUse" });
		}
		normalCall++;
		return fauxAssistantMessage(largeNextReply ? "z".repeat(22000) : initialReply);
	};
	faux.setResponses(Array.from({ length: 30 }, () => response));
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
		pi.on("session_before_compact", (event) => {
			preparations.push({ ids: [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages].flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []), before: event.preparation.tokensBefore });
		});
		createObservationPackExtension({ compactionOffload: true })(pi);
		pi.registerTool({ name: "synthetic", label: "Synthetic", description: "Synthetic test data", parameters: Type.Object({ index: Type.Number() }),
			execute: async (_id, params) => ({ content: result(sizes[params.index]!).content, details: {} }),
		});
	};
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
		extensionFactories: [{ name: "offload-test", factory: extension }], noExtensions: true,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Synthetic lifecycle test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const open = async (sessionManager: SessionManager) => {
		await resourceLoader.reload();
		return (await createAgentSession({ cwd, agentDir,
			model: faux.getModel(), tools: ["synthetic", "obs_recall"], thinkingLevel: "off", resourceLoader, sessionManager, settingsManager,
		})).session;
	};
	return { session: await open(manager), manager, requests, preparations, open, summaryCalls: () => summaryCalls,
		largeReply: () => { largeNextReply = true; }, sizes };
}
