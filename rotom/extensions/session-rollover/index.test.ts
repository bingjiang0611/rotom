import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assistantWithUsage,
	branchEntries,
	compactionEntries,
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	longReply,
	projectionMessages,
	THRESHOLD,
} from "./test-helpers.ts";

/** Records the compaction events a later extension sees, and can cancel them like the offload does. */
const PROBE = `export default (pi) => {
	pi.on("session_before_compact", (event) => {
		(globalThis.__rolloverProbe ??= []).push(event.reason);
		if (event.reason === "threshold" && globalThis.__cancelThreshold === true) return { cancel: true };
		return undefined;
	});
	pi.registerTool({
		name: "probe_compact",
		label: "Request an extension compaction",
		description: "Ask Pi for an extension-requested compaction",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, _signal, _update, ctx) {
			// ctx.compact() aborts the running turn, so it cannot be awaited from inside the tool call
			// that runs in it. Expose its completion promise instead and let the test await that.
			globalThis.__probeCompactDone = new Promise((resolve) => {
				ctx.compact({ onComplete: () => resolve("done"), onError: (error) => resolve("error: " + String(error)) });
			});
			return { content: [{ type: "text", text: "requested" }], details: {} };
		},
	});
};`;

/** Loaded before the rollover extension, so it sees events even when ours answers them. */
const EARLY_PROBE = `export default (pi) => {
	pi.on("session_before_compact", (event) => {
		(globalThis.__rolloverEarly ??= []).push(event.reason);
	});
};`;

/** Reply sized to cross the threshold (window - reserve) while staying inside the window. */
function thresholdReply(timestamp = Date.now() + 1_000): any {
	return assistantWithUsage(longReply(THRESHOLD - 800), 0, timestamp);
}

function probeSeen(): string[] {
	return (globalThis as any).__rolloverProbe ?? [];
}

function compactionReasons(h: any): string[] {
	return h.events.filter((event: any) => event.type === "compaction_start").map((event: any) => event.reason);
}

function earlySeen(): string[] {
	return (globalThis as any).__rolloverEarly ?? [];
}

function resetProbes(): void {
	(globalThis as any).__rolloverProbe = [];
	(globalThis as any).__rolloverEarly = [];
	(globalThis as any).__cancelThreshold = false;
}

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-rollover-"));
		resetProbes();
		try {
			await run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test("registers one handler, and only for ROTOM_SESSION_ROLLOVER=1", withDir(async (dir) => {
	const off = await createHarness({ dir, rollover: undefined });
	try {
		assert.deepEqual(off.handlerNames.sort(), [], "no handlers without the switch");
	} finally {
		off.dispose();
	}
	const on = await createHarness({ dir, rollover: "1" });
	try {
		assert.deepEqual(on.handlerNames.sort(), ["session_before_compact"], "the summary-free design has no input handler");
	} finally {
		on.dispose();
	}
}));

test("takes over the in-turn threshold compaction without a summary call", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: THRESHOLD + 500, probeSource: PROBE, earlyProbeSource: EARLY_PROBE });
	try {
		const sessionId = h.session.sessionManager.getSessionId();
		h.faux.setResponses([assistantWithUsage("reply", 10)]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1, "exactly one entry is written");
		const entry = compactions[0];
		assert.deepEqual(entry.details, { kind: "rotom-rollover", version: 2 });
		assert.equal(entry.fromHook, true, "the entry comes from an extension");
		assert.equal(entry.tokensBefore, THRESHOLD + 500, "the prepared cut point's token count is kept");
		assert.equal(h.faux.state.callCount, 1, "no summarization request is made");
		assert.deepEqual(compactionReasons(h), ["threshold"], "the in-turn pre-request path is the one under test");
		assert.deepEqual(earlySeen(), ["threshold"]);
		assert.deepEqual(probeSeen(), ["threshold"], "a later handler still sees the event");

		assert.equal(h.session.sessionManager.getSessionId(), sessionId, "the session id is unchanged");
		const branch = branchEntries(h.session);
		const kept = branch.slice(branch.findIndex((item: any) => item.id === entry.firstKeptEntryId));
		assert.ok(kept.length > 1, "the prepared cut keeps the recent tail");
		assert.match(entry.summary, new RegExp(`@${entry.firstKeptEntryId}`), "the note names the cut point");
		assert.match(entry.summary, /context_recall/, "the note explains retrieval");
		assert.match(entry.summary, /Keep the recorded requirement exact/, "the removed request is quoted back");
		assert.match(entry.summary, /<current-request>/, "the quote is labelled");

		const projected = projectionMessages(h.session);
		assert.equal(projected[0]?.role, "compactionSummary", "the model first sees the takeover entry");
		assert.equal(projected.filter((message: any) => message.role === "compactionSummary").length, 1);
		assert.equal(JSON.stringify(projected).includes("Recorded earlier answer."), false, "the cleared range is gone from the projection");
		assert.equal(JSON.stringify(branch).includes("Recorded earlier answer."), true, "the branch keeps every original entry");
	} finally {
		h.dispose();
	}
}));

test("takes over the after-run threshold compaction and quotes the newest request", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true });
	try {
		h.faux.setResponses([thresholdReply()]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1, "the after-run path is taken over too");
		assert.deepEqual(compactionReasons(h), ["threshold"], "the reply crosses the threshold without overflowing the window");
		assert.equal(compactions[0].details?.kind, "rotom-rollover");
		assert.equal(h.faux.state.callCount, 1, "still no summary request");
		assert.match(compactions[0].summary, /Carry on with the ledger task\./, "the request that produced the overflow-sized reply is quoted");
	} finally {
		h.dispose();
	}
}));

test("a second takeover reuses the branch instead of nesting the first summary", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true });
	try {
		h.faux.setResponses([thresholdReply()]);
		await h.session.prompt("first request");
		assert.equal(compactionEntries(h.session).length, 1);

		h.faux.setResponses([thresholdReply(Date.now() + 2_000)]);
		await h.session.prompt("second request");
		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 2, "the long second turn crosses the threshold again");
		const second = compactions[1].summary as string;
		assert.match(second, /second request/, "the newest request is quoted");
		assert.equal(second.match(/cleared from the context without a summary/g)?.length, 1, "the note is not repeated inside itself");
		assert.equal(second.includes("first request"), false, "an older request is not re-quoted");
	} finally {
		h.dispose();
	}
}));

test("takes over overflow recovery and lets Pi retry the turn once", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true });
	try {
		h.faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "This model's maximum context length is 12000 tokens." }),
			assistantWithUsage("reply after recovery", 10),
		]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1, "overflow recovery writes the takeover entry");
		assert.equal(compactions[0].details?.kind, "rotom-rollover");
		assert.equal(h.faux.state.callCount, 2, "the aborted turn is retried once");
		assert.equal(h.session.messages.findLast((message: any) => message.role === "assistant")?.content[0]?.text, "reply after recovery");
	} finally {
		h.dispose();
	}
}));

test("keeps the native summary for manual and extension-requested compaction", withDir(async (dir) => {
	const h = await createHarness({
		dir,
		rollover: "1",
		recall: true,
		tools: ["context_recall", "probe_compact"],
		historyTokens: THRESHOLD + 500,
		probeSource: PROBE,
	});
	try {
		h.faux.setResponses([fauxAssistantMessage("NATIVE MANUAL SUMMARY")]);
		await h.session.compact();
		assert.deepEqual(probeSeen(), ["manual"], "a manual compaction still reaches later handlers");
		assert.equal(h.faux.state.callCount, 1, "the native path calls the model");

		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe_compact", {}, { id: "compact-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("NATIVE EXTENSION SUMMARY"),
			assistantWithUsage("reply", 10),
		]);
		await h.session.prompt("Ask for an extension compaction.");
		// The extension compaction aborts the turn and finishes on its own schedule.
		assert.equal(await (globalThis as any).__probeCompactDone, "done", "the extension compaction completed");
		assert.deepEqual(probeSeen(), ["manual", "extension"], "the extension-requested compaction is not taken over");

		for (const entry of compactionEntries(h.session)) {
			assert.equal(entry.details?.kind, undefined, "native compactions keep their own details");
		}
		assert.equal(compactionEntries(h.session).length, 2);
	} finally {
		h.dispose();
	}
}));

test("keeps the native summary when context_recall is not an active tool", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", tools: [], historyTokens: THRESHOLD + 500, probeSource: PROBE });
	try {
		h.faux.setResponses([assistantWithUsage("reply", 10), fauxAssistantMessage("NATIVE SUMMARY"), fauxAssistantMessage("NATIVE PREFIX")]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1, "the native path still compacts");
		assert.equal(compactions[0].details?.kind, undefined, "without the retrieval tool there is no takeover");
		assert.ok(h.faux.state.callCount > 1, "the native summary path calls the model");
	} finally {
		h.dispose();
	}
}));

test("a later cancel defers the takeover to the next compaction", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: THRESHOLD + 500, probeSource: PROBE });
	try {
		(globalThis as any).__cancelThreshold = true;
		h.faux.setResponses([assistantWithUsage("reply", 10)]);

		await h.session.prompt("Carry on with the ledger task.");

		assert.equal(compactionEntries(h.session).length, 0, "a cancelling handler wins over the takeover");
		assert.equal(h.faux.state.callCount, 1, "the prompt is still dispatched");
	} finally {
		h.dispose();
	}
}));

test("cleared tool results stay retrievable with context_recall after the takeover", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: THRESHOLD + 500, seedToolResult: true });
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("context_recall", { query: "secret-old-result-42" }, { id: "recall-1" })], { stopReason: "toolUse" }),
			assistantWithUsage("found the recorded result", 10),
		]);

		await h.session.prompt("Find the recorded result again.");

		assert.equal(compactionEntries(h.session).length, 1);
		assert.equal(
			projectionMessages(h.session).some((message: any) => message.role === "toolResult" && message.toolName === "read"),
			false,
			"the cleared tool result is gone from the projection",
		);
		const toolResult = h.session.messages.findLast((message: any) => message.role === "toolResult" && message.toolName === "context_recall");
		assert.ok(toolResult, "the recall tool ran");
		assert.match(JSON.stringify(toolResult.content), /secret-old-result-42/);
	} finally {
		h.dispose();
	}
}));

test("cleared tool arguments and images stay retrievable after the takeover", withDir(async (dir) => {
	const h = await createHarness({
		dir,
		rollover: "1",
		recall: true,
		imageInput: true,
		historyTokens: THRESHOLD + 500,
		seedToolResult: true,
		seedImage: true,
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("context_recall", { query: "notes.txt" }, { id: "recall-args" })], { stopReason: "toolUse" }),
			// The first page of a retrieved entry is text only; the image sits on the next page.
			fauxAssistantMessage([fauxToolCall("context_recall", { ref: `@${h.seeded.image}`, offset: 2 }, { id: "recall-image" })], { stopReason: "toolUse" }),
			assistantWithUsage("recovered both", 10),
		]);

		await h.session.prompt("Recover the recorded arguments and the screenshot.");

		assert.equal(compactionEntries(h.session).length, 1);
		const results = h.session.messages.filter((message: any) => message.role === "toolResult");
		assert.equal(results.length, 2, "both retrievals ran");
		assert.match(JSON.stringify(results[0].content), /notes\.txt/, "a cleared tool argument is found by search");
		assert.ok(
			results[1].content.some((part: any) => part.type === "image"),
			"a cleared image is returned by ref",
		);
	} finally {
		h.dispose();
	}
}));

test("ROTOM_CONTEXT_LAYERS=0 leaves no retrieval tool, so the native summary runs", withDir(async (dir) => {
	process.env.ROTOM_CONTEXT_LAYERS = "0";
	const h = await createHarness({ dir, rollover: "1", recall: true, tools: [], historyTokens: THRESHOLD + 500 });
	try {
		assert.equal(h.toolDefinitions.has("context_recall"), false, "the opt-out installs no retrieval tool");
		h.faux.setResponses([assistantWithUsage("reply", 10), fauxAssistantMessage("NATIVE SUMMARY"), fauxAssistantMessage("NATIVE PREFIX")]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0].details?.kind, undefined, "without the tool the extension declines the takeover");
	} finally {
		h.dispose();
		delete process.env.ROTOM_CONTEXT_LAYERS;
	}
}));

test("reopening the session keeps the takeover projection", withDir(async (dir) => {
	const first = await createHarness({ dir, rollover: "1", recall: true });
	let sessionFile: string;
	let entryId: string;
	try {
		first.faux.setResponses([thresholdReply()]);
		await first.session.prompt("Carry on with the ledger task.");
		sessionFile = first.session.sessionManager.getSessionFile();
		entryId = compactionEntries(first.session)[0].id;
	} finally {
		first.dispose();
	}

	const resumed = await createHarness({ dir, rollover: "1", recall: true, resumeFrom: sessionFile });
	try {
		const compactions = compactionEntries(resumed.session);
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0].id, entryId, "the same entry is read back");
		assert.equal(compactions[0].details?.kind, "rotom-rollover");
		const projected = projectionMessages(resumed.session).filter((message: any) => message.role !== "system");
		assert.equal(projected[0]?.role, "compactionSummary", "the reopened projection starts at the takeover entry");
		assert.match(JSON.stringify(projected[0]), /context_recall/, "the reopened projection uses the retrieval note");
	} finally {
		resumed.dispose();
	}
}));
