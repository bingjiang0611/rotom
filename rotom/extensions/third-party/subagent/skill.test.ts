import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareProductSubagentArguments } from "./policy.ts";

const skill = readFileSync(new URL("../../../skills/pi-subagents/SKILL.md", import.meta.url), "utf8");
const upstream = readFileSync(new URL("../node_modules/pi-subagents/skills/pi-subagents/SKILL.md", import.meta.url), "utf8");

function frontmatter(text: string): string {
	const match = /^---\n[\s\S]*?\n---\n/u.exec(text);
	assert.ok(match);
	return match[0];
}

test("product skill preserves discovery metadata while dropping upstream-only instructions", () => {
	assert.equal(frontmatter(skill), frontmatter(upstream), "只精简正文，不改变 skill identity 或触发描述");
	assert.ok(Buffer.byteLength(skill) < Buffer.byteLength(upstream) / 2, "精简指南文件应小于上游文件的一半 bytes");
	assert.doesNotMatch(skill, /references\/|mission|schedule|refine|watchdog\.configure|project\.open|worktree\.discard|\/parallel-review|\/review-loop|interview/iu);
});

test("skill launch example uses product arguments and returns a mocked one-child handoff", async () => {
	const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/gu)];
	assert.equal(examples.length, 1);
	const input = JSON.parse(examples[0][1]);
	const prepared = prepareProductSubagentArguments(input);
	assert.equal(prepared.action, undefined);
	assert.equal(prepared.mission, false);
	assert.equal(prepared.async, true);
	assert.equal(prepared.context, "fresh");
	assert.equal(prepared.cwd, "/absolute/path/to/repo");
	assert.deepEqual(Object.keys(input).sort(), ["async", "context", "cwd", "workflowScript"]);

	// Only execute our source-controlled example with an injected runs stub: no
	// model, child process, filesystem access or real delegation is performed.
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const calls: Array<{ key: string; options: Record<string, unknown> }> = [];
	const handoff = { runId: "fixture-run", output: "fixture findings" };
	const result = await new AsyncFunction("runs", input.workflowScript)({
		run(key: string, options: Record<string, unknown>) {
			calls.push({ key, options });
			return Promise.resolve(handoff);
		},
	});
	assert.deepEqual(result, handoff);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].key, "scan");
	assert.equal(calls[0].options.agent, "scout");
	assert.equal(calls[0].options.output, false);
	assert.match(String(calls[0].options.task), /Do not edit files or launch subagents/u);
});
