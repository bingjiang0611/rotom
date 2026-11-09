import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation, serializeMessagesForSummary } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results, keeping the head and the tail", () => {
		const longContent = `${"h".repeat(2500)}${"t".repeat(2499)}E`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(
			`[Tool result]: ${"h".repeat(1000)}\n\n[... 3000 characters truncated ...]\n\n${"t".repeat(999)}E`,
		);
		// Failures and test totals come last in command output; the tail must survive.
		expect(result.endsWith("E")).toBe(true);
	});

	it("should bound tool call arguments, keeping the head and the tail", () => {
		const content = "c".repeat(6000);
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "big.ts", content } }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result.startsWith('[Assistant tool calls]: write(path="big.ts", content="')).toBe(true);
		expect(result).toContain("characters truncated ...]");
		expect(result.endsWith('c")')).toBe(true);
		expect(result.length).toBeLessThan(2200);
	});

	it("should keep short tool call arguments intact", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts", offset: 10 } }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		expect(serializeConversation(messages)).toBe('[Assistant tool calls]: read(path="a.ts", offset=10)');
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("should omit thinking", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
					{ type: "text", text: "visible reply" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe('[Assistant]: visible reply\n\n[Assistant tool calls]: read(path="a.ts")');
	});
});

describe("serializeMessagesForSummary", () => {
	it("labels extension messages apart from user messages", () => {
		const result = serializeMessagesForSummary([
			{ role: "user", content: "don't stop until M6 is done", timestamp: 1 },
			{
				role: "custom",
				customType: "goal-contract",
				content: "Goal mode is inactive.",
				display: false,
				timestamp: 2,
			},
		]);

		expect(result).toBe(
			"[User]: don't stop until M6 is done\n\n[Extension message (goal-contract)]: Goal mode is inactive.",
		);
	});
});
