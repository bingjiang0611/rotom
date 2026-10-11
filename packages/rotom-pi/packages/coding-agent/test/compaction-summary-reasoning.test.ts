import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("honors caller-supplied routing session and tool choice without prompt caching", async () => {
		await completeSummarization(createModel(false), normalizeContext({ systemPrompt: "Summarize", messages: [] }), {
			sessionId: "current-routing-session",
			cacheRetention: "long",
			toolChoice: "auto",
		});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			sessionId: "current-routing-session",
			cacheRetention: "none",
			toolChoice: "auto",
		});
	});

	it("preserves the previous summary without an empty history request for a split turn", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			previousSummary: "previous checkpoint",
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(preparation, createModel(false), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.summary).toContain("previous checkpoint");
		const requestContext = completeSimpleMock.mock.calls[0][1] as TranscriptContext;
		const prompt = JSON.stringify(requestContext.messages);
		// Regression test for #9652: clear boundaries and continuation wording avoid the reasoning-extraction false positive.
		expect(prompt).toContain("# Conversation\\n[User]: Summarize this.");
		expect(prompt).toContain("# Instructions\\nThe messages above are earlier context from an ongoing conversation.");
	});

	it("rejects tool calls from conversation summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
	});

	it("rejects tool calls from split-turn summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"Turn prefix summarization attempted to call a tool",
		);
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummaryWithUsage(messages, createModel(false), 2000, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("leaves Anthropic refusal fallback handling to pi-ai model metadata", async () => {
		await generateSummary(
			messages,
			createModel(true, 8192, {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: "claude-opus-4-8",
						cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
			}),
			2000,
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("does not set Anthropic refusal fallback for models without allowed fallback targets", async () => {
		await generateSummary(messages, createModel(true), 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});

describe("split-turn compaction requests", () => {
	const splitPreparation: CompactionPreparation = {
		firstKeptEntryId: "entry-keep",
		messagesToSummarize: messages,
		turnPrefixMessages: [{ role: "user", content: "Current turn.", timestamp: Date.now() }],
		isSplitTurn: true,
		tokensBefore: 100,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
	};
	const isTurnPrefix = (context: TranscriptContext) => JSON.stringify(context.messages).includes("Current turn.");
	const summaryText = (text: string): AssistantMessage => ({
		...mockSummaryResponse,
		content: [{ type: "text", text }],
	});

	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	it("starts the history and turn-prefix summaries together and keeps their merge order", async () => {
		const pending: Array<{ turnPrefix: boolean; resolve: (message: AssistantMessage) => void }> = [];
		completeSimpleMock.mockImplementation(
			(_model: Model<any>, context: TranscriptContext) =>
				new Promise<AssistantMessage>((resolve) => pending.push({ turnPrefix: isTurnPrefix(context), resolve })),
		);

		const result = compact(splitPreparation, createModel(false), "test-key");
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		// Finish the turn prefix first: the merged summary must still put history before it.
		pending.find((call) => call.turnPrefix)!.resolve(summaryText("turn prefix summary"));
		pending.find((call) => !call.turnPrefix)!.resolve(summaryText("history summary"));

		const compaction = await result;
		expect(compaction.summary).toMatch(
			/^history summary\n\n---\n\n\*\*Turn Context \(split turn\):\*\*\n\nturn prefix summary/,
		);
		expect(compaction.summaryCalls?.map((call) => [call.kind, call.attempts])).toEqual([
			["history", 1],
			["turn_prefix", 1],
		]);
	});

	it("aborts the sibling request when one summary fails and reports the first failure", async () => {
		let turnPrefixSignal: AbortSignal | undefined;
		completeSimpleMock.mockImplementation((_model: Model<any>, context: TranscriptContext, options) => {
			if (!isTurnPrefix(context)) {
				return Promise.resolve({ ...mockSummaryResponse, stopReason: "error", errorMessage: "history failed" });
			}
			turnPrefixSignal = options.signal;
			return new Promise<AssistantMessage>((resolve) =>
				options.signal.addEventListener("abort", () => resolve({ ...mockSummaryResponse, stopReason: "aborted" })),
			);
		});

		await expect(compact(splitPreparation, createModel(false), "test-key")).rejects.toThrow("history failed");
		expect(turnPrefixSignal?.aborted).toBe(true);
	});

	it("aborts both requests when the caller cancels", async () => {
		const signals: AbortSignal[] = [];
		completeSimpleMock.mockImplementation((_model: Model<any>, _context: TranscriptContext, options) => {
			signals.push(options.signal);
			return new Promise<AssistantMessage>((resolve) =>
				options.signal.addEventListener("abort", () => resolve({ ...mockSummaryResponse, stopReason: "aborted" })),
			);
		});
		const controller = new AbortController();

		const result = compact(splitPreparation, createModel(false), "test-key", undefined, undefined, controller.signal);
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		controller.abort();

		// As before, compact() returns the aborted summaries; the session checks its own signal.
		await result;
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it("records when the first thinking and text blocks stream", async () => {
		const streamFn = () => {
			const stream = createAssistantMessageEventStream();
			const partial = summaryText("summary");
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				stream.push({ type: "thinking_start", contentIndex: 0, partial });
				stream.push({ type: "text_start", contentIndex: 1, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		};

		const result = await compact(
			{ ...splitPreparation, isSplitTurn: false, turnPrefixMessages: [] },
			createModel(false),
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		const [call] = result.summaryCalls ?? [];
		expect(call).toMatchObject({ kind: "history", attempts: 1 });
		expect(call.firstThinkingMs).toBeGreaterThanOrEqual(0);
		expect(call.firstTextMs).toBeGreaterThanOrEqual(call.firstThinkingMs!);
		expect(call.durationMs).toBeGreaterThanOrEqual(call.firstTextMs!);
	});
});
