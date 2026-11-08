import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type Message,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "../src/core/extensions/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const MODEL = getModel("anthropic", "claude-sonnet-4-5")!;
/** The summarizer request carries only its single prompt message. */
function isSummarizerRequest(context: Context): boolean {
	return context.messages.length === 1 && context.messages[0]?.role === "user";
}

function assistantMessage(text: string, tokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function textOf(message: Message): string {
	if (message.role === "user" || message.role === "toolResult") {
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
	}
	if (message.role === "assistant") {
		return message.content.map((part) => (part.type === "text" ? part.text : "[call]")).join(" ");
	}
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function requestText(context: Context): string[] {
	return context.messages.map((message) => `${message.role}:${textOf(message)}`);
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	requests: Context[];
	errors: string[];
	compactEvents: SessionBeforeCompactEvent[];
	tempDir: string;
	dispose(): void;
}

interface HarnessOptions {
	extension?: (pi: ExtensionAPI) => void;
	replyTokens?: number;
	holdFirstReply?: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-rollover-seam-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const requests: Context[] = [];
	const errors: string[] = [];
	const compactEvents: SessionBeforeCompactEvent[] = [];
	let held = 0;

	const agent = new Agent({
		convertToLlm,
		initialState: { model: MODEL, systemPrompt: "Test system prompt", tools: [], messages: [] },
		streamFn: (_model, context) => {
			requests.push(context);
			const summarizer = isSummarizerRequest(context);
			const tokens = summarizer ? 10 : (options.replyTokens ?? 10);
			const respond = () => {
				const message = assistantMessage(summarizer ? "SUMMARY" : "reply", tokens);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			};
			const stream = createAssistantMessageEventStream();
			if (!summarizer && options.holdFirstReply && held === 0) {
				held = 1;
				void options.holdFirstReply().then(respond);
			} else {
				queueMicrotask(respond);
			}
			return stream;
		},
	});

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);

	const extensionFactory: ((pi: ExtensionAPI) => void) | undefined = options.extension
		? (pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					compactEvents.push(event as SessionBeforeCompactEvent);
				});
				options.extension?.(pi);
			}
		: (pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					compactEvents.push(event as SessionBeforeCompactEvent);
				});
			};

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir),
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([extensionFactory]) }),
	});
	session.bindExtensions({ onError: (error) => errors.push(error.error) });

	return {
		session,
		sessionManager: session.sessionManager,
		requests,
		errors,
		compactEvents,
		tempDir,
		dispose: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

/** Requests that carry the conversation, excluding the compaction summarizer. */
function conversationRequests(harness: Harness): Context[] {
	return harness.requests.filter((context) => !isSummarizerRequest(context));
}

function lastConversationRequest(harness: Harness): Context {
	const requests = conversationRequests(harness);
	expect(requests.length).toBeGreaterThan(0);
	return requests[requests.length - 1];
}

function appendHistory(harness: Harness, assistantTokens = 200): void {
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "old question" }],
		timestamp: Date.now() - 2_000,
	});
	harness.sessionManager.appendMessage(assistantMessage("old answer", assistantTokens));
	// Agent state is what threshold checks read; mirror the recorded branch like a resumed session.
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

let harness: Harness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

describe("session rollover seam", () => {
	it("resets the context inside an input handler and keeps only the rollover summary", async () => {
		let reset: unknown;
		let rolesAfterReset: string[] = [];
		harness = await createHarness({
			extension: (pi) => {
				pi.on("input", async (_event, ctx) => {
					reset = await ctx.resetContext({
						summary: "rolled over summary",
						details: { kind: "rotom-rollover", version: 1 },
					});
					// The live agent state must already match the projection the request will use.
					rolesAfterReset = harness!.session.agent.state.messages.map((message) => message.role);
					return undefined;
				});
			},
		});
		const { session, sessionManager } = harness;
		expect(harness.session.getContextThresholdEstimate()).toMatchObject({
			contextWindow: MODEL.contextWindow,
			enabled: true,
			source: "messages",
		});
		appendHistory(harness);

		await session.prompt("new question");

		expect(reset).toEqual({ status: "applied", entryId: expect.any(String) });
		expect(rolesAfterReset).toEqual(["compactionSummary"]);

		const branch = sessionManager.getBranch();
		const visible = branch.filter((entry) => entry.type !== "message" || entry.message.role !== "system");
		expect(visible.map((entry) => entry.type)).toEqual(["message", "message", "compaction", "message", "message"]);
		const compaction = visible[2];
		expect(compaction?.type === "compaction" && compaction.summary).toBe("rolled over summary");

		const request = requestText(lastConversationRequest(harness));
		expect(request.join("\n")).toContain("rolled over summary");
		expect(request.join("\n")).not.toContain("old question");
		expect(request[request.length - 1]).toBe("user:new question");

		expect(harness.compactEvents.map((event) => `${event.reason}/${event.phase}`)).toEqual(["rollover/rollover"]);
	});

	it("rejects a reset outside an input handler and keeps the context", async () => {
		let reset: unknown;
		harness = await createHarness({
			extension: (pi) => {
				pi.on("before_agent_start", async (_event, ctx) => {
					reset = await ctx.resetContext({ summary: "rolled over summary" });
				});
			},
		});
		const { session, sessionManager } = harness;
		appendHistory(harness);

		await session.prompt("new question");

		expect(reset).toEqual({ status: "failed", reason: expect.stringContaining("input handler") });
		expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(requestText(lastConversationRequest(harness)).join("\n")).toContain("old question");
	});

	it("rejects a reset while the session is busy", async () => {
		let release: () => void = () => {};
		const firstReply = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reset: unknown;
		harness = await createHarness({
			holdFirstReply: () => firstReply,
			extension: (pi) => {
				pi.on("input", async (event, ctx) => {
					if (event.text === "steer while busy") {
						reset = await ctx.resetContext({ summary: "rolled over summary" });
					}
					return undefined;
				});
			},
		});
		const { session, sessionManager } = harness;

		const run = session.prompt("first question");
		while (harness.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		await session.prompt("steer while busy", { streamingBehavior: "steer" });
		release();
		await run;

		expect(reset).toEqual({ status: "failed", reason: expect.stringContaining("idle") });
		expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("cancels the reset without aborting the prompt when a handler cancels", async () => {
		let reset: unknown;
		harness = await createHarness({
			extension: (pi) => {
				pi.on("session_before_compact", (event) => {
					if (event.reason === "rollover") return { cancel: true } as SessionBeforeCompactResult;
					return undefined;
				});
				pi.on("input", async (_event, ctx) => {
					reset = await ctx.resetContext({ summary: "rolled over summary" });
					return undefined;
				});
			},
		});
		const { session, sessionManager } = harness;
		appendHistory(harness);

		await session.prompt("new question");

		expect(reset).toEqual({ status: "cancelled", reason: expect.any(String) });
		expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(requestText(lastConversationRequest(harness)).join("\n")).toContain("old question");
	});

	it("ignores a replacement compaction from a rollover handler and reports it", async () => {
		let reset: unknown;
		harness = await createHarness({
			extension: (pi) => {
				pi.on("session_before_compact", (event) => {
					if (event.reason !== "rollover") return undefined;
					return {
						compaction: { summary: "replacement summary", tokensBefore: 1, firstKeptEntryId: null },
					} as unknown as SessionBeforeCompactResult;
				});
				pi.on("input", async (_event, ctx) => {
					reset = await ctx.resetContext({ summary: "rolled over summary" });
					return undefined;
				});
			},
		});
		const { session, sessionManager } = harness;
		appendHistory(harness);

		await session.prompt("new question");

		expect(reset).toEqual({ status: "applied", entryId: expect.any(String) });
		const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.type === "compaction" && compactions[0].summary).toBe("rolled over summary");
		expect(harness.errors.join("\n")).toContain("replacement");
	});

	it("reports the pre-prompt phase when the recorded context is above the threshold", async () => {
		harness = await createHarness();
		const { session } = harness;
		const threshold = session.getContextThresholdEstimate()?.thresholdTokens ?? 0;
		expect(threshold).toBeGreaterThan(0);

		appendHistory(harness, threshold + 1_000);
		await session.prompt("prompt above the threshold");

		expect(harness.compactEvents.map((event) => `${event.reason}/${event.phase}`)).toEqual(["threshold/before-request"]);
	});

	it("reports the post-run phase when the reply usage is above the threshold", async () => {
		// The reply, not the recorded history, crosses the threshold without overflowing the window.
		harness = await createHarness({ replyTokens: MODEL.contextWindow - 10_000 });
		const { session } = harness;
		const estimate = session.getContextThresholdEstimate();
		expect(estimate?.thresholdTokens ?? 0).toBeGreaterThan(0);
		expect(estimate?.thresholdTokens ?? 0).toBeLessThan(MODEL.contextWindow - 10_000);

		appendHistory(harness, 200);
		await session.prompt("reply above the threshold");

		expect(harness.compactEvents.map((event) => `${event.reason}/${event.phase}`)).toEqual(["threshold/after-run"]);
	});

	it("reports the requested phase for an explicit compaction", async () => {
		harness = await createHarness();
		const { session } = harness;
		appendHistory(harness, 200);

		await session.compact();

		expect(harness.compactEvents.map((event) => `${event.reason}/${event.phase}`)).toEqual(["manual/requested"]);
	});
});
