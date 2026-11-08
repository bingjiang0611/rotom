import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { entryWasAppended } from "./index.ts";
import {
	assistantWithUsage,
	compactionEntries,
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	longReply,
	THRESHOLD,
	userTextCount,
	WATERMARK,
} from "./test-helpers.ts";

/** Records every compaction event a later extension sees; a first cancel must hide it. */
const PROBE = `export default (pi) => {
	pi.on("session_before_compact", (event) => {
		const seen = (globalThis.__rolloverProbe ??= []);
		seen.push(event.reason + "/" + event.phase);
		if (event.reason === "rollover" && globalThis.__cancelRollover === true) return { cancel: true };
		return undefined;
	});
	pi.on("session_compact", (event) => {
		(globalThis.__rolloverCompacts ??= []).push(event.reason);
	});
};`;

/** Loaded before the rollover extension, so it sees events the rollover handler cancels. */
const EARLY_PROBE = `export default (pi) => {
	pi.on("session_before_compact", (event) => {
		(globalThis.__rolloverEarly ??= []).push(event.reason + "/" + event.phase);
	});
};`;

function earlySeen(): string[] {
	return (globalThis as any).__rolloverEarly ?? [];
}

function probeSeen(): string[] {
	return (globalThis as any).__rolloverProbe ?? [];
}

function compactSeen(): string[] {
	return (globalThis as any).__rolloverCompacts ?? [];
}

function withDir(run: (dir: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-rollover-"));
		(globalThis as any).__rolloverProbe = [];
		(globalThis as any).__rolloverEarly = [];
		(globalThis as any).__rolloverCompacts = [];
		(globalThis as any).__cancelRollover = false;
		try {
			await run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test("registers handlers only for ROTOM_SESSION_ROLLOVER=1", withDir(async (dir) => {
	const off = await createHarness({ dir, rollover: undefined });
	try {
		assert.deepEqual(off.handlerNames.sort(), [], "no handlers without the switch");
	} finally {
		off.dispose();
	}
	const on = await createHarness({ dir, rollover: "1" });
	try {
		assert.deepEqual(on.handlerNames.sort(), ["input", "session_before_compact"]);
	} finally {
		on.dispose();
	}
}));

test("an eligible submission rolls over once and dispatches the input once", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: WATERMARK + 500, probeSource: PROBE });
	try {
		const sessionId = h.session.sessionManager.getSessionId();
		const entriesBefore = h.session.sessionManager.getBranch().length;
		h.faux.setResponses([assistantWithUsage("reply", 10)]);

		await h.session.prompt("Carry on with the ledger task.");

		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1);
		const entry = compactions[0];
		assert.equal(entry.details.kind, "rotom-rollover");
		assert.equal(entry.firstKeptEntryId, entry.id, "the entry keeps nothing");
		assert.equal(entry.fromHook, false);
		assert.match(entry.summary, /context_recall/);
		assert.match(entry.summary, /Keep the recorded requirement exact/, "the excerpt quotes the tail verbatim");
		assert.deepEqual(probeSeen(), ["rollover/rollover"]);
		assert.deepEqual(compactSeen(), ["rollover"]);

		assert.equal(h.session.sessionManager.getSessionId(), sessionId, "the session id is unchanged");
		assert.equal(userTextCount(h.session, "Carry on with the ledger task."), 1, "the input is recorded once");
		assert.equal(h.faux.state.callCount, 1, "exactly one model request is dispatched");
		assert.ok(h.session.sessionManager.getBranch().length > entriesBefore, "old entries stay on the branch");
		const projected = h.session.sessionManager.buildSessionProjection().messages;
		assert.equal(projected[0]?.role, "compactionSummary", "the model first sees the rollover entry");
		assert.deepEqual(
			projected.filter((message: any) => message.role === "user").map((message: any) => message.content[0].text),
			["Carry on with the ledger task."],
			"only the new input follows the rollover entry",
		);
		assert.equal(JSON.stringify(projected).includes("Recorded earlier answer."), false, "the old answer is gone");
		assert.equal(JSON.stringify(h.session.sessionManager.getBranch()).includes("Recorded earlier answer."), true, "the branch keeps it");
	} finally {
		h.dispose();
	}
}));

test("an eligible session does not compact right after the rollover", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: WATERMARK + 500 });
	try {
		h.faux.setResponses([assistantWithUsage("first reply", 10)]);
		await h.session.prompt("first");
		assert.equal(compactionEntries(h.session).length, 1);

		h.faux.setResponses([assistantWithUsage("second reply", 10)]);
		await h.session.prompt("second");
		assert.equal(compactionEntries(h.session).length, 1, "no native threshold compaction followed");
		assert.equal(probeSeen().includes("threshold/after-run"), false);
	} finally {
		h.dispose();
	}
}));

test("an eligible after-run threshold compaction is deferred and the next submission rolls over", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, probeSource: PROBE, earlyProbeSource: EARLY_PROBE });
	try {
		h.faux.setResponses([fauxAssistantMessage(longReply(THRESHOLD + 500))]);
		await h.session.prompt("first");

		assert.equal(compactionEntries(h.session).length, 0, "the after-run compaction is deferred");
		assert.deepEqual(earlySeen(), ["threshold/after-run"], "the after-run threshold event does fire");
		assert.deepEqual(probeSeen(), [], "the cancelling handler runs before later handlers");
		assert.equal(h.faux.state.callCount, 1, "no summary request was made");

		h.faux.setResponses([assistantWithUsage("second reply", 10)]);
		await h.session.prompt("second");
		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0].details.kind, "rotom-rollover");
	} finally {
		h.dispose();
	}
}));

test("a second submission above the water mark rolls over again", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: WATERMARK + 500 });
	try {
		h.faux.setResponses([fauxAssistantMessage(longReply(THRESHOLD + 500))]);
		await h.session.prompt("first");
		assert.equal(compactionEntries(h.session).length, 1, "the first submission rolls over");

		h.faux.setResponses([assistantWithUsage("second reply", 10)]);
		await h.session.prompt("second");
		assert.equal(compactionEntries(h.session).length, 2, "the estimate survives the rollover entry");
		assert.ok(compactionEntries(h.session).every((entry: any) => entry.details.kind === "rotom-rollover"));
	} finally {
		h.dispose();
	}
}));

test("an ineligible after-run threshold compaction keeps its existing path", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", tools: [], probeSource: PROBE });
	try {
		// A split turn needs a second summary for its prefix before the entry is written.
		h.faux.setResponses([
			fauxAssistantMessage(longReply(THRESHOLD + 500)),
			fauxAssistantMessage("SUMMARY"),
			fauxAssistantMessage("PREFIX"),
		]);
		await h.session.prompt("first");

		assert.deepEqual(probeSeen(), ["threshold/after-run"], "a later handler still sees the event");
		const compactions = compactionEntries(h.session);
		assert.equal(compactions.length, 1, "native compaction proceeds without the recall tool");
		assert.notEqual(compactions[0].details?.kind, "rotom-rollover");
	} finally {
		h.dispose();
	}
}));

test("a rollover cancelled by another handler submits normally without an entry", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: WATERMARK + 500, probeSource: PROBE });
	try {
		(globalThis as any).__cancelRollover = true;
		h.faux.setResponses([assistantWithUsage("reply", 10)]);

		await h.session.prompt("Carry on with the ledger task.");

		assert.equal(compactionEntries(h.session).length, 0);
		assert.equal(userTextCount(h.session, "Carry on with the ledger task."), 1);
		assert.equal(h.faux.state.callCount, 1, "the input is dispatched once");
		const request = h.faux.state.callCount;
		assert.equal(request, 1);
	} finally {
		h.dispose();
	}
}));

test("cleared tool results are retrievable with context_recall after a rollover", withDir(async (dir) => {
	const h = await createHarness({
		dir,
		rollover: "1",
		recall: true,
		historyTokens: WATERMARK + 500,
		seedToolResult: true,
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("context_recall", { query: "secret-old-result-42" }, { id: "recall-1" })], { stopReason: "toolUse" }),
			assistantWithUsage("found the recorded result", 10),
		]);
		await h.session.prompt("Find the recorded result again.");

		assert.equal(compactionEntries(h.session).length, 1);
		const toolResult = h.session.messages.findLast((message: any) => message.role === "toolResult" && message.toolName === "context_recall");
		assert.ok(toolResult, "the recall tool ran");
		assert.match(JSON.stringify(toolResult.content), /secret-old-result-42/);
	} finally {
		h.dispose();
	}
}));

test("a failed append is reconciled by reading the branch back", () => {
	const rollover = { type: "compaction", id: "new", details: { kind: "rotom-rollover" } };
	const native = { type: "compaction", id: "native", details: undefined };
	assert.equal(entryWasAppended(() => "new", (id) => (id === "new" ? (rollover as any) : undefined), "old"), true);
	assert.equal(entryWasAppended(() => "native", (id) => (id === "native" ? (native as any) : undefined), "old"), false);
	assert.equal(entryWasAppended(() => "old", () => undefined, "old"), false, "an unchanged leaf means nothing was appended");
});
