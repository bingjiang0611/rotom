// The replay judge must read prose, not payloads. Synthetic entries only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureReplayPlan } from "./eval/replay-plan.mjs";
import {
	binaryPlaceholder, IMAGE_PLACEHOLDER, readableText, replayJudgeBlock, replayJudgeContext,
	REPLAY_JUDGE_BINARY_RUN_CHARS, REPLAY_JUDGE_BUDGET_CHARS, REPLAY_JUDGE_PROMPT_VERSION, REPLAY_JUDGE_TRUNCATED,
} from "./eval/replay-judge.mjs";

const message = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
const bigBase64 = (size = 400_000) => "iVBORw0KGgo".repeat(Math.ceil(size / 11)).slice(0, size);

test("images and long binary runs become placeholders, prose stays", () => {
	const entries = [
		message("user", "先看现在改到哪一步了"),
		message("assistant", [{ type: "text", text: "我先查 git 状态。" }, { type: "toolCall", name: "bash", arguments: { command: "git status --short" } }]),
		message("toolResult", [{ type: "text", text: " M a.ts" }], { isError: false }),
		message("assistant", [{ type: "image", data: bigBase64(50_000) }, { type: "text", text: "" }]),
		message("user", [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "看这张截图" }]),
	];
	const context = replayJudgeContext(entries);
	assert.equal(/[A-Za-z0-9+/]{256,}/u.test(context.text), false, "no base64 reaches the judge");
	assert.ok(context.text.includes(IMAGE_PLACEHOLDER), "the image is named as omitted");
	assert.ok(context.text.includes("先看现在改到哪一步了"));
	assert.ok(context.text.includes("git status --short"));
	assert.ok(context.text.includes("工具结果（成功）：M a.ts".replace("M", "M")));
	assert.ok(context.text.includes("看这张截图"), "text next to an image is kept");
	assert.ok(context.chars > 0 && context.chars === context.text.length);
});

test("a wrapped base64 blob counts by payload, not by line", () => {
	const wrapped = Array.from({ length: 400 }, () => bigBase64(76)).join("\n");
	const context = replayJudgeContext([message("user", `看看这个：\n${wrapped}\n就这样`)]);
	assert.equal(context.text.includes("iVBORw0KGgo"), false);
	assert.ok(context.text.includes("看看这个"));
	assert.ok(context.text.includes("就这样"));
	assert.match(context.text, /\[二进制数据已省略 \d+ 字符\]/u);
});

test("the budget is filled from the cut backwards and never overflows", () => {
	const entries = [1, 2, 3, 4, 5].map((index) => message("user", `第${index}条：${"x".repeat(40)}`));
	const budget = 120;
	const context = replayJudgeContext(entries, budget);
	assert.ok(context.chars <= budget, `chars ${context.chars} must fit ${budget}`);
	assert.ok(context.text.includes("第5条"), "the newest entry is kept");
	assert.equal(context.text.includes("第1条"), false, "older entries fall out of the budget");
	// Truncation inside a block: no throw, the marker is present, the length holds.
	const tight = replayJudgeContext(entries, 60);
	assert.ok(tight.chars <= 60);
	assert.ok(tight.text.includes(REPLAY_JUDGE_TRUNCATED));
	assert.ok(tight.text.includes("第5条"));
	// A zero budget is legal and yields nothing rather than throwing.
	assert.deepEqual(replayJudgeContext(entries, 0), { text: "", chars: 0, redactions: [], redactionTotal: 0 });
});

test("redaction runs before truncation, so a hidden key never reaches the judge", () => {
	const secret = "sk-ant-" + "k".repeat(30);
	const entries = [message("user", `{"blob":"${"b".repeat(20_000)}","apiKey":"${secret}"}`)];
	const context = replayJudgeContext(entries, 400);
	assert.equal(context.text.includes(secret), false);
	assert.equal(context.text.includes("kkkk"), false);
	assert.ok(context.redactions.some((row) => row.type === "anthropic-key"));
	assert.ok(context.chars <= 400);
	// Counting happens once per render, not per fill attempt.
	assert.equal(replayJudgeContext(entries, 400).redactionTotal, context.redactionTotal);
});

test("tool lines keep the name, bound the arguments and mark failures", () => {
	// Words and punctuation, not a long run: this must hit the length bound, not
	// the binary-run rule.
	const longArgs = { command: "npm run build -- --watch ".repeat(200) };
	const block = replayJudgeBlock(message("assistant", [{ type: "toolCall", name: "bash", arguments: longArgs }]));
	assert.ok(block.includes("工具调用 bash"));
	assert.ok(block.length < 400, "arguments are cut to a readable length");
	assert.ok(block.includes(REPLAY_JUDGE_TRUNCATED));
	const failed = replayJudgeBlock(message("toolResult", [{ type: "text", text: "fatal: nope" }], { isError: true }));
	assert.ok(failed.includes("失败"));
	assert.ok(failed.includes("fatal: nope"));
	// Entries with nothing readable produce no block at all.
	assert.equal(replayJudgeBlock(message("assistant", [{ type: "thinking", thinking: "内部推理" }])), "");
	assert.equal(replayJudgeBlock({ type: "model_change", provider: "a", modelId: "b" }), "");
});

test("only long binary runs are replaced; short tokens survive", () => {
	assert.equal(readableText("commit 4f3a9c2 和 sk-learn"), "commit 4f3a9c2 和 sk-learn");
	const short = "A".repeat(REPLAY_JUDGE_BINARY_RUN_CHARS - 1);
	assert.equal(readableText(short), short);
	assert.equal(readableText("A".repeat(REPLAY_JUDGE_BINARY_RUN_CHARS)), binaryPlaceholder(REPLAY_JUDGE_BINARY_RUN_CHARS));
});

test("the confirmation dialog counts the characters the judge really receives", () => {
	const entries = [message("user", "先查状态"), message("assistant", [{ type: "image", data: bigBase64(120_000) }]), message("toolResult", [{ type: "text", text: "ok" }])];
	const items = [{ key: "a", check: { mode: "model" }, expected: "先查状态再改", entries }];
	const plan = measureReplayPlan({ items, repeats: 1, arms: 1 });
	const context = replayJudgeContext(entries);
	assert.equal(plan.cases[0].originalChars, context.chars + "先查状态再改".length);
	assert.equal(plan.originalChars, plan.cases[0].originalChars);
	// The same input measured twice reports the same number.
	assert.equal(measureReplayPlan({ items, repeats: 1, arms: 1 }).originalChars, plan.originalChars);
	// A rule point sends nothing, so it contributes no judge characters.
	assert.equal(measureReplayPlan({ items: [{ key: "a", check: { mode: "rule", rule: "nonempty-handoff" }, expected: "x", entries }] }).originalChars, 0);
});

test("the prompt version is v2 and the budget is a named contract", () => {
	assert.equal(REPLAY_JUDGE_PROMPT_VERSION, "rotom-replay-judge/v2");
	assert.equal(REPLAY_JUDGE_BUDGET_CHARS, 12_000);
	// Sending more than the budget is impossible: the context is the whole input.
	assert.ok(replayJudgeContext([message("user", "x".repeat(50_000))]).chars <= REPLAY_JUDGE_BUDGET_CHARS);
});
