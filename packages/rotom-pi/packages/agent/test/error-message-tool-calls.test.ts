import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * A provider stream can die after it emitted text and a complete tool call. That message ends the
 * turn with `stopReason: "error"`, and the whole message may then be retried by the bounded budget
 * (Qoder does exactly this). Tool effects must not replay, so this locks in that nothing in such a
 * message is dispatched.
 */
const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
		...(errorMessage ? { errorMessage } : {}),
	};
}

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });
const toLlm = (messages: AgentMessage[]): Message[] => messages.filter((m) => ["system", "user", "assistant", "toolResult"].includes(m.role)) as Message[];

describe("error-ended assistant messages", () => {
	it("never executes their tool calls", async () => {
		const executed: string[] = [];
		const tool: AgentTool<ReturnType<typeof Type.Object>, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: Type.Object({ value: Type.String() }),
			async execute(_id, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model, convertToLlm: toLlm };
		const streamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "error",
					message: assistant(
						[
							{ type: "text", text: "writing the file" },
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "written" } },
						],
						"error",
						"Qoder: stream_failed",
					),
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([user("write it")], context, config, undefined, streamFn);
		for await (const event of stream) events.push(event);

		expect(executed).toEqual([]);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
		const messages = await stream.result();
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		expect(last.role === "assistant" && last.stopReason).toBe("error");
	});
});
