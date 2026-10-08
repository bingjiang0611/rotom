import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Model, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";
import { parseSessionEntries, SessionManager } from "../src/core/session-manager.ts";

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

	it.each(["initial", "update", "split", "branch"])(
		"carries evidence and authorization instructions through %s summaries",
		async (route) => {
			const state: AgentMessage[] = [
				{
					role: "user",
					content: "Do not commit. The cause is localized; implement the fix, then verify.",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "check",
					toolName: "bash",
					content: [{ type: "text", text: `${"progress ".repeat(500)}SyntaxError remains` }],
					isError: true,
					timestamp: 0,
				},
			];
			if (route === "split") {
				await compact(
					{
						firstKeptEntryId: "keep",
						messagesToSummarize: [],
						turnPrefixMessages: state,
						isSplitTurn: true,
						tokensBefore: 2000,
						fileOps: { read: new Set(), written: new Set(), edited: new Set() },
						settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
					},
					createModel(false),
					"test-key",
				);
			} else if (route === "branch") {
				await generateBranchSummary(
					state.map((message, i) => ({
						type: "message",
						id: `e${i}`,
						parentId: i ? `e${i - 1}` : null,
						timestamp: "2026-01-01T00:00:00Z",
						message,
					})),
					{ model: createModel(false), apiKey: "test-key" },
				);
			} else {
				await generateSummary(
					state,
					createModel(false),
					2000,
					"test-key",
					undefined,
					undefined,
					undefined,
					route === "update"
						? "Old checks passed before subsequent edits. External write outcome unknown."
						: undefined,
				);
			}
			const request = JSON.stringify(completeSimpleMock.mock.calls[0][1]);
			expect(request).toContain("authorization boundaries");
			expect(request).toContain("later edits can invalidate earlier checks");
			expect(request).toContain("unknown write needs read-only verification, not replay");
			expect(request).toContain("Make next steps consistent with the recorded state");
			expect(request).toContain("replace superseded facts with newer evidence");
			expect(request).toContain("Do not commit");
			expect(request).toContain("isError=true");
			expect(request).toContain("SyntaxError remains");
			if (route === "update") expect(request).toContain("External write outcome unknown");
		},
	);

	it("preserves a checkpoint through native JSONL reload and a subsequent summary request", async () => {
		// This proves transport/persistence, not that a model generates or obeys this checkpoint.
		const checkpoint =
			"## Constraints & Preferences\nDo not commit.\n## Progress\nCause localized; fix edited after old passing checks. SyntaxError unresolved. External write unknown. Hypothesis unverified.\n## Next Steps\nRepair and rerun checks on current edits; read-only verification of the write, no replay.";
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			content: [{ type: "text", text: checkpoint }],
		});
		const summary = await generateSummary(messages, createModel(false), 2000, "test-key");
		const manager = SessionManager.inMemory("/synthetic");
		manager.appendMessage(messages[0]);
		const kept = manager.appendMessage({ role: "user", content: "Continue from the checkpoint", timestamp: 1 });
		manager.appendCompaction(summary, kept, 1000);
		const encoded = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
		const restored = SessionManager.inMemory("/synthetic", undefined, parseSessionEntries(encoded));
		const context = restored.buildSessionContext();
		const saved = context.messages.find((message) => message.role === "compactionSummary");
		expect(saved).toMatchObject({ summary: checkpoint });
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			checkpoint,
		);
		expect(JSON.stringify(completeSimpleMock.mock.calls[1][1])).toContain("External write unknown");
		expect(restored.getEntries()).toHaveLength(manager.getEntries().length);
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
