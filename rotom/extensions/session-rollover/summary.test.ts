import assert from "node:assert/strict";
import test from "node:test";
import { buildRolloverSummary, tailExcerpt } from "./summary.ts";
import { COPY } from "./copy.ts";

const userEntry = (id: string, content: any) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content, timestamp: 0 } }) as any;
const assistantEntry = (id: string, content: any[]) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content, timestamp: 0 } }) as any;
const toolResultEntry = (id: string, text: string) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 } }) as any;

const words = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `${tag}${index}`).join(" ");

test("excerpt keeps the last user input and assistant text verbatim with their entry ids", () => {
	const branch = [
		userEntry("u1", "first requirement"),
		assistantEntry("a1", [{ type: "text", text: "first answer" }]),
		userEntry("u2", "exact requirement: keep the ledger at 42"),
		assistantEntry("a2", [{ type: "text", text: "Recorded exactly: the ledger is at 42." }]),
		userEntry("u3", "and the untracked draft input"),
	];
	const excerpt = tailExcerpt(branch, 1_000);
	assert.ok(excerpt);
	assert.ok(excerpt!.includes(`[user @u3]\nand the untracked draft input`));
	assert.ok(excerpt!.includes("[assistant @a2]\nRecorded exactly: the ledger is at 42."));
	assert.ok(!excerpt!.includes("first requirement"), "only the tail is quoted");
	assert.ok(!excerpt!.includes(COPY.omitted([]).slice(0, 5)), "no truncation marker when everything fits");
});

test("excerpt excludes tool results, tool calls, thinking and attachments", () => {
	const branch = [
		userEntry("u1", [{ type: "text", text: "read the notes" }, { type: "image", data: "AAAA", mimeType: "image/png" }]),
		assistantEntry("a1", [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "secret-path" } },
			{ type: "text", text: "Here is the summary." },
		]),
		toolResultEntry("r1", "secret-tool-output"),
	];
	const excerpt = tailExcerpt(branch, 1_000)!;
	assert.ok(excerpt.includes("read the notes"));
	assert.ok(excerpt.includes("Here is the summary."));
	for (const forbidden of ["private reasoning", "secret-path", "secret-tool-output", "AAAA"]) {
		assert.equal(excerpt.includes(forbidden), false, forbidden);
	}
});

test("an over-budget excerpt is cut in the middle and names the cut entries", () => {
	const head = words(400, "head");
	const tail = words(400, "tail");
	const branch = [userEntry("u1", head), assistantEntry("a1", [{ type: "text", text: tail }])];
	const budget = 200;
	const excerpt = tailExcerpt(branch, budget)!;
	assert.ok(Math.ceil(excerpt.length / 4) <= budget, "the excerpt stays within the budget");
	const lines = excerpt.split("\n");
	const headText = lines[lines.indexOf("[user @u1]") + 1] as string;
	assert.ok(head.startsWith(headText), "the head stays a verbatim prefix");
	const tailText = lines[lines.indexOf("[assistant @a1]") + 1] as string;
	assert.ok(tailText.length > 0, "the tail keeps some of its final words");
	assert.ok(tail.endsWith(tailText), "the tail stays a verbatim suffix");
	assert.ok(excerpt.includes("@u1") && excerpt.includes("@a1"), "the marker names both cut entries");
	assert.ok(excerpt.includes("context_recall"), "the marker points at the retrieval tool");
});

test("a summary without usable tail text is the retrieval instructions alone", () => {
	const branch = [assistantEntry("a1", [{ type: "thinking", thinking: "only reasoning" }])];
	assert.equal(tailExcerpt(branch, 1_000), undefined);
	assert.equal(buildRolloverSummary(branch, 16_384), COPY.intro);
});

test("the summary budget is a quarter of reserveTokens", () => {
	const long = words(4_000, "filler");
	const branch = [userEntry("u1", long), assistantEntry("a1", [{ type: "text", text: long }])];
	const reserveTokens = 4_000;
	const summary = buildRolloverSummary(branch, reserveTokens);
	const excerpt = summary.slice(COPY.intro.length + 2);
	assert.ok(Math.ceil(excerpt.length / 4) <= reserveTokens / 4, "excerpt fits reserveTokens / 4");
	assert.ok(excerpt.length < long.length * 2, "the long text was shortened");
	assert.ok(summary.startsWith(COPY.intro));
});
