import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	digest,
	readReviewFile,
	reviewEvidence,
	reviewFilesCurrent,
	runCompletionReview,
	REVIEW_LIMITS,
} from "../src/reviewer.js";

function fixture(t: any) {
	const cwd = mkdtempSync(join(tmpdir(), "rotom-review-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "result.txt"), "verified");
	return cwd;
}
function response(content: any[], stopReason = "stop") {
	return {
		role: "assistant",
		content,
		stopReason,
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
		timestamp: 0,
	};
}
function input(cwd: string, complete: any, signal = new AbortController().signal) {
	return {
		ctx: { cwd, model: { provider: "fixture", id: "fixture" }, modelRegistry: { complete } } as any,
		objective: "result.txt contains verified",
		summary: "claim",
		evidence: "none",
		signal,
		isCurrent: () => true,
		remainingTokens: REVIEW_LIMITS.reportedTokens,
	};
}

test("reader rejects traversal, symlinks, runtime paths, oversized and invalid UTF8 files", (t) => {
	const cwd = fixture(t);
	assert.equal(readReviewFile(cwd, "result.txt").digest, digest("verified"));
	symlinkSync(join(cwd, "result.txt"), join(cwd, "link"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "secret"), "hidden");
	writeFileSync(join(cwd, "large"), "x".repeat(REVIEW_LIMITS.fileBytes + 1));
	writeFileSync(join(cwd, "binary"), Buffer.from([0xff]));
	for (const path of ["../escape", "/etc/hosts", "link", ".pi/secret", "large", "binary"])
		assert.throws(() => readReviewFile(cwd, path));
	assert.equal(reviewFilesCurrent(cwd, [{ path: "result.txt", digest: digest("old") }]), false);
});

test("selected provider sees only explicit file tools and bounded untrusted evidence; no nested session", async (t) => {
	const cwd = fixture(t);
	let calls = 0;
	const result = await runCompletionReview(
		input(cwd, async (model: any, context: any, options: any) => {
			calls++;
			assert.equal(model.provider, "fixture");
			assert.deepEqual(
				context.tools.map((x: any) => x.name),
				["review_read", "review_list"],
			);
			assert.equal(options.maxRetries, 0);
			assert.equal(options.maxTokens, 2048);
			assert.match(context.systemPrompt, /untrusted data/);
			assert.match(context.systemPrompt, /pre-completion check/);
			assert.ok(context.messages[0].content.startsWith(context.systemPrompt));
			assert.match(context.messages[0].content, /untrusted JSON payload/);
			assert.match(
				context.tools[1].parameters.properties.path.description,
				/Use \. for the project root/,
			);
			return calls === 1
				? response(
						[{ type: "toolCall", id: "r", name: "review_read", arguments: { path: "result.txt" } }],
						"toolUse",
					)
				: response([{ type: "text", text: "Requirement supported by result.txt\n<approved/>" }]);
		}),
	);
	assert.equal(result.status, "approved");
	assert.equal(result.calls, 2);
	assert.equal(result.reportedTokens, 40);
	assert.deepEqual(result.files, [{ path: "result.txt", digest: digest("verified") }]);
});

test("invalid/length verdict, unknown tool and model loop never manufacture approval", async (t) => {
	const cwd = fixture(t);
	const result = await runCompletionReview(
		input(cwd, async () => response([{ type: "text", text: "<approved/>\nbut missing evidence" }])),
	);
	assert.equal(result.status, "unknown");
	const length = await runCompletionReview(
		input(cwd, async () => response([{ type: "text", text: "<approved/>" }], "length")),
	);
	assert.equal(length.status, "unknown");
	const loop = await runCompletionReview(
		input(cwd, async () =>
			response(
				[{ type: "toolCall", id: "r", name: "bash", arguments: { command: "touch forbidden" } }],
				"toolUse",
			),
		),
	);
	assert.equal(loop.status, "unknown");
	assert.equal(loop.calls, REVIEW_LIMITS.calls);
});

test("abort bounds an uncooperative request; late approval cannot be accepted or retried", async (t) => {
	const cwd = fixture(t);
	const controller = new AbortController();
	let settle: any,
		calls = 0;
	const pending = runCompletionReview(
		input(
			cwd,
			() => {
				calls++;
				return new Promise((resolve) => {
					settle = resolve;
				});
			},
			controller.signal,
		),
	);
	controller.abort();
	const result = await pending;
	assert.equal(result.status, "unknown");
	assert.equal(calls, 1);
	settle(response([{ type: "text", text: "<approved/>" }]));
	assert.equal(result.status, "unknown");
});

test("budget and context admissions occur before a provider call", async (t) => {
	const cwd = fixture(t);
	let calls = 0;
	const args = input(cwd, async () => {
		calls++;
		return response([]);
	});
	const result = await runCompletionReview({ ...args, remainingTokens: 0 });
	assert.equal(result.status, "unknown");
	assert.equal(calls, 0);
	await runCompletionReview({ ...args, evidence: "x".repeat(REVIEW_LIMITS.contextBytes) });
	assert.equal(calls, 0);
});

test("approval becomes unknown if a file changes during review", async (t) => {
	const cwd = fixture(t);
	let calls = 0;
	const result = await runCompletionReview(
		input(cwd, async () => {
			if (++calls === 1)
				return response(
					[{ type: "toolCall", id: "r", name: "review_read", arguments: { path: "result.txt" } }],
					"toolUse",
				);
			writeFileSync(join(cwd, "result.txt"), "changed");
			return response([{ type: "text", text: "<approved/>" }]);
		}),
	);
	assert.equal(result.status, "unknown");
});

test("directory observations are revalidated before approval", async (t) => {
	const cwd = fixture(t);
	let calls = 0;
	const result = await runCompletionReview(
		input(cwd, async () => {
			if (++calls === 1)
				return response(
					[{ type: "toolCall", id: "d", name: "review_list", arguments: { path: "." } }],
					"toolUse",
				);
			writeFileSync(join(cwd, "new-file"), "new");
			return response([{ type: "text", text: "<approved/>" }]);
		}),
	);
	assert.equal(result.status, "unknown");
});

test("small complete records are retained to the byte bound, not an arbitrary six-record cutoff", () => {
	const entries = Array.from({ length: 9 }, (_, i) => [
		{
			message: response([
				{ type: "toolCall", id: `r${i}`, name: "write", arguments: { path: `file${i}` } },
			]),
		},
		{
			message: {
				role: "toolResult",
				toolCallId: `r${i}`,
				content: [{ type: "text", text: "written" }],
			},
		},
	]).flat();
	const evidence = reviewEvidence(entries);
	assert.match(evidence, /9 bounded tool records/);
	assert.match(evidence, /file0/);
	assert.match(evidence, /file8/);
});

test("candidate evidence omits goal controls and oversized records, never truncates a record", () => {
	const entries = [
		{
			message: response(
				[{ type: "toolCall", id: "r", name: "read", arguments: { path: "result.txt" } }],
				"toolUse",
			),
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "r",
				content: [{ type: "text", text: "verified" }],
			},
		},
	];
	const before = reviewEvidence(entries);
	entries.push({
		message: response([
			{ type: "toolCall", id: "g", name: "goal_complete", arguments: { summary: "new claim" } },
		]),
	});
	entries.push(
		{
			message: {
				role: "toolResult",
				toolCallId: "g",
				content: [{ type: "text", text: "new claim" }],
			},
		},
		{
			message: response([
				{
					type: "toolCall",
					id: "c",
					name: "goal_continue",
					arguments: { next_action: "inspect b.txt" },
				},
			]),
		},
		{
			message: {
				role: "toolResult",
				toolCallId: "c",
				content: [{ type: "text", text: "One continuation decision accepted." }],
			},
		},
	);
	assert.equal(reviewEvidence(entries), before);
	assert.match(reviewEvidence(entries, true), /One continuation decision accepted/);
	assert.doesNotMatch(reviewEvidence(entries, true), /new claim/);
	entries.push({
		message: { role: "user", content: [{ type: "text", text: "The host delivered result.txt." }] },
	} as any);
	assert.equal(reviewEvidence(entries), before);
	assert.match(reviewEvidence(entries, true), /The host delivered result.txt/);
	assert.match(before, /Partial session evidence/);
	entries.push({
		message: {
			role: "toolResult",
			toolCallId: "r",
			content: [{ type: "text", text: "x".repeat(6001) }],
		},
	});
	assert.equal(reviewEvidence(entries), before);
});
