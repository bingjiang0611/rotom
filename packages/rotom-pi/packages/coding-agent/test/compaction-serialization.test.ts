import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = `START${"x".repeat(4990)}ERROR`;
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

		expect(result).toContain('[Tool result name="read" id="tc1" isError=false]:');
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(2000));
		expect(result).toContain(`START${"x".repeat(995)}`);
		expect(result).toContain(`${"x".repeat(995)}ERROR`);
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

		expect(result).toBe(`[Tool result name="read" id="tc1" isError=false]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("keeps empty errors and correlates results with parallel calls", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "bash", arguments: { command: "check-a" } },
					{ type: "toolCall", id: "b", name: "bash", arguments: { command: "check-b" } },
				],
				api: "anthropic-messages",
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
				timestamp: 0,
			},
			{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [], isError: true, timestamp: 0 },
			{
				role: "toolResult",
				toolCallId: "a",
				toolName: "bash",
				content: [{ type: "text", text: "dispatch unknown" }],
				isError: false,
				timestamp: 0,
			},
		];
		const result = serializeConversation(messages);
		expect(result).toContain('bash[id="a"](command="check-a")');
		expect(result).toContain('bash[id="b"](command="check-b")');
		expect(result).toContain('[Tool result name="bash" id="b" isError=true]: [No text content]');
		expect(result).toContain('[Tool result name="bash" id="a" isError=false]: dispatch unknown');
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
});
