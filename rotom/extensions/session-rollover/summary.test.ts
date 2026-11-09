import assert from "node:assert/strict";
import test from "node:test";
import { COPY } from "./copy.ts";
import { buildTakeoverSummary } from "./summary.ts";

const userEntry = (id: string, content: any) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content, timestamp: 0 } }) as any;
const assistantEntry = (id: string, content: any[]) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content, timestamp: 0 } }) as any;
const toolResultEntry = (id: string, text: string) =>
	({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 0 } }) as any;

const words = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `${tag}${index}`).join(" ");

const SUMMARY_BUDGET = 200;
const build = (branch: any[], firstKeptEntryId: string) =>
	buildTakeoverSummary({ branch, firstKeptEntryId, reserveTokens: SUMMARY_BUDGET * 4 });

test("the summary is the retrieval note when no request was removed with the cut", () => {
	const branch = [assistantEntry("a1", [{ type: "text", text: "only reasoning and answers" }])];
	const summary = build(branch, "a1");
	assert.equal(summary, COPY.intro("a1"));
	assert.ok(summary.includes("@a1"), "the note names the cut point");
	assert.ok(summary.includes("context_recall"), "the note explains retrieval");
	assert.equal(summary.includes(COPY.currentRequestOpen), false, "no request quote without a removed request");
});

test("a request still inside the kept range is not quoted back", () => {
	const branch = [userEntry("u1", "first request"), assistantEntry("a1", [{ type: "text", text: "answer" }]), userEntry("u2", "kept request")];
	// `u2` is at or after the cut point, so the model still sees it verbatim.
	assert.equal(build(branch, "u2"), COPY.intro("u2"));
	assert.equal(build(branch, "a1"), COPY.intro("a1"));
});

test("a request removed with the cut is quoted verbatim with its entry id", () => {
	const branch = [userEntry("u1", "exact requirement: keep the ledger at 42"), assistantEntry("a1", [{ type: "text", text: "answer" }]), assistantEntry("a2", [{ type: "text", text: "later answer" }])];
	const summary = build(branch, "a2");
	assert.ok(summary.includes(COPY.currentRequest("u1", "exact requirement: keep the ledger at 42")));
	assert.ok(summary.includes(COPY.currentRequestOpen) && summary.includes(COPY.currentRequestClose));
	assert.equal(summary.includes("later answer"), false, "assistant text is never copied into the summary");
});

test("tool results, tool calls, thinking and images never reach the summary", () => {
	const branch = [
		userEntry("u1", [{ type: "text", text: "read the notes" }, { type: "image", data: "AAAA", mimeType: "image/png" }]),
		assistantEntry("a1", [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "secret-path" } },
			{ type: "text", text: "Here is the summary." },
		]),
		toolResultEntry("r1", "secret-tool-output"),
		assistantEntry("a2", [{ type: "text", text: "kept tail" }]),
	];
	const summary = build(branch, "a2");
	assert.ok(summary.includes("read the notes"));
	for (const forbidden of ["private reasoning", "secret-path", "secret-tool-output", "AAAA", "Here is the summary."]) {
		assert.equal(summary.includes(forbidden), false, forbidden);
	}
});

test("an over-long request is cut in the middle, stays in budget and names the entry", () => {
	const long = words(2_000, "request");
	const branch = [userEntry("u1", long), assistantEntry("a2", [{ type: "text", text: "kept tail" }])];
	const summary = build(branch, "a2");
	const quoted = summary.slice(summary.indexOf(COPY.currentRequestOpen));
	const label = `[user @u1]\n`;
	const text = quoted.slice(quoted.indexOf(label) + label.length, quoted.indexOf(COPY.currentRequestClose));
	assert.ok(Math.ceil(text.length / 4) <= SUMMARY_BUDGET, `the quoted request fits the budget (${Math.ceil(text.length / 4)})`);
	assert.ok(quoted.length < long.length, "the long request was shortened");
	assert.ok(quoted.includes("@u1"), "the marker names the entry that still holds it");
	assert.match(quoted, /characters omitted from the middle/);
	const head = long.slice(0, 40);
	const tail = long.slice(-40);
	assert.ok(quoted.includes(head), "the head stays a verbatim prefix");
	assert.ok(quoted.includes(tail), "the tail stays a verbatim suffix");
});

test("an unlocatable cut point still quotes the request instead of dropping it", () => {
	const branch = [userEntry("u1", "exact requirement: keep the ledger at 42")];
	const summary = build(branch, "missing-entry");
	assert.ok(summary.includes("exact requirement: keep the ledger at 42"));
});

test("a request with no visible text adds nothing", () => {
	const branch = [userEntry("u1", [{ type: "image", data: "AAAA", mimeType: "image/png" }]), assistantEntry("a2", [{ type: "text", text: "kept tail" }])];
	assert.equal(build(branch, "a2"), COPY.intro("a2"));
});
