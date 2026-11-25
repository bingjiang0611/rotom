/**
 * After an automatic compaction fails, threshold compaction waits before trying again instead of
 * starting another summary request on every following message. Reproduces the observed failure:
 * a summary model whose requests kept failing was retried every few seconds, 33 times in one
 * session. The failing summarizer here is a stream function that throws; no network is used.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AUTO_COMPACTION_BACKOFF_BASE_MS,
	AUTO_COMPACTION_BACKOFF_MAX_MS,
	AutoCompactionBackoff,
} from "../../../src/core/compaction/auto-compaction-backoff.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

const usage = (totalTokens: number) => ({
	input: totalTokens,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(100),
		timestamp: now - 500,
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** A summarizer that fails until `succeed` is set; counts the summary requests it receives. */
function useSummarizer(harness: Harness): { requests: () => number; succeed: () => void } {
	let requests = 0;
	let healthy = false;
	harness.session.agent.streamFunction = (model) => {
		requests++;
		if (!healthy) throw new Error("summary request dropped before any response");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: usage(10),
				},
			});
		});
		return stream;
	};
	return {
		requests: () => requests,
		succeed: () => {
			healthy = true;
		},
	};
}

describe("automatic compaction backoff after a failure", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const summarizer = useSummarizer(harness);
		return { harness, summarizer, session: harness.session as unknown as SessionWithCompactionInternals };
	}

	it("does not retry threshold compaction on the next message after a failure", async () => {
		const { harness, summarizer, session } = await setup();
		await expect(session._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(summarizer.requests()).toBe(1);
		// The messages that follow within the minute used to start a new summary request each.
		for (let message = 0; message < 10; message++) {
			vi.advanceTimersByTime(5_000);
			await session._runAutoCompaction("threshold", false);
		}
		expect(summarizer.requests()).toBe(1);
		// A deferred attempt is silent: no start or end event for an attempt that never ran.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("waits one, two, four minutes between failed attempts and resumes after a success", async () => {
		const { harness, summarizer, session } = await setup();
		await session._runAutoCompaction("threshold", false);
		vi.advanceTimersByTime(AUTO_COMPACTION_BACKOFF_BASE_MS);
		await session._runAutoCompaction("threshold", false);
		expect(summarizer.requests()).toBe(2);
		vi.advanceTimersByTime(AUTO_COMPACTION_BACKOFF_BASE_MS);
		await session._runAutoCompaction("threshold", false);
		expect(summarizer.requests()).toBe(2);
		vi.advanceTimersByTime(AUTO_COMPACTION_BACKOFF_BASE_MS);
		await session._runAutoCompaction("threshold", false);
		expect(summarizer.requests()).toBe(3);
		vi.advanceTimersByTime(4 * AUTO_COMPACTION_BACKOFF_BASE_MS);
		summarizer.succeed();
		await session._runAutoCompaction("threshold", false);
		expect(summarizer.requests()).toBe(4);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		// After a success the next threshold crossing compacts at once again (a split turn may send
		// two summary requests, so count compactions rather than requests).
		seedCompactableSession(harness);
		await session._runAutoCompaction("threshold", false);
		expect(summarizer.requests()).toBeGreaterThan(4);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
	});

	it("still runs overflow recovery during the wait, because that turn cannot continue without it", async () => {
		const { summarizer, session } = await setup();
		await session._runAutoCompaction("threshold", false);
		await session._runAutoCompaction("overflow", false);
		expect(summarizer.requests()).toBe(2);
	});

	it("does not start a wait when the user or an extension cancelled the compaction", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const session = harness.session as unknown as SessionWithCompactionInternals;
		await session._runAutoCompaction("threshold", false);
		await session._runAutoCompaction("threshold", false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
	});
});

describe("AutoCompactionBackoff", () => {
	it("doubles the wait up to fifteen minutes and clears it on success", () => {
		let now = 0;
		const backoff = new AutoCompactionBackoff(() => now);
		expect(backoff.allowsThreshold()).toBe(true);
		expect([1, 2, 3, 4, 5, 6].map(() => backoff.recordFailure())).toEqual(
			[1, 2, 4, 8, 15, 15].map((minutes) => minutes * 60_000),
		);
		expect(AUTO_COMPACTION_BACKOFF_MAX_MS).toBe(15 * 60_000);
		expect(backoff.allowsThreshold()).toBe(false);
		now += AUTO_COMPACTION_BACKOFF_MAX_MS;
		expect(backoff.allowsThreshold()).toBe(true);
		backoff.recordSuccess();
		expect(backoff.recordFailure()).toBe(AUTO_COMPACTION_BACKOFF_BASE_MS);
	});
});
