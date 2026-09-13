import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists the aborted response before running the requested manual compaction", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage(`second response:${"x".repeat(4000)}`);
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({ summary: "manual summary" });
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["manual"]);
		const entries = harness.sessionManager.getEntries();
		const abortedResponseIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
		);
		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
		expect(abortedResponseIndex).toBeGreaterThan(-1);
		expect(compactionIndex).toBeGreaterThan(abortedResponseIndex);
		expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("normalizes a provider error caused by the compaction abort without retrying it", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 2 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async (_context, options) => {
				markSecondResponseStarted();
				await new Promise<never>((_resolve, reject) => {
					const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
				throw new Error("unreachable");
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "manual summary" });
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(2);
		const abortedResponse = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.errorMessage?.includes("aborted"),
			);
		expect(abortedResponse).toMatchObject({
			type: "message",
			message: { stopReason: "aborted" },
		});
	});

	it("does not hide an unrelated provider error that races with the compaction abort", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 2 },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			},
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async (_context, options) => {
				markSecondResponseStarted();
				await new Promise<never>((_resolve, reject) => {
					const abort = () => reject(new Error("provider failed independently"));
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
				throw new Error("unreachable");
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "manual summary" });
		await promptPromise;

		const providerError = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.errorMessage === "provider failed independently",
			);
		expect(providerError).toMatchObject({
			type: "message",
			message: { stopReason: "error" },
		});
	});
});
