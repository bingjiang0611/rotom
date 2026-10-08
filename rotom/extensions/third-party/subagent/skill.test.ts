import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { subagentPolicyApi } from "./policy.ts";

const skill = readFileSync(new URL("../../../skills/pi-subagents/SKILL.md", import.meta.url), "utf8");
const upstream = readFileSync(new URL("../node_modules/pi-subagents/skills/pi-subagents/SKILL.md", import.meta.url), "utf8");
const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]));

function frontmatter(text: string): string {
	const match = /^---\n[\s\S]*?\n---\n/u.exec(text);
	assert.ok(match);
	return match[0];
}

test("product skill preserves discovery metadata while dropping upstream-only instructions", () => {
	assert.equal(frontmatter(skill), frontmatter(upstream), "只精简正文，不改变 skill identity 或触发描述");
	assert.ok(Buffer.byteLength(skill) < Buffer.byteLength(upstream) / 2, "精简指南文件应小于上游文件的一半 bytes");
	assert.doesNotMatch(skill, /references\/|mission|schedule|refine|watchdog\.configure|project\.open|worktree\.discard|\/parallel-review|\/review-loop|interview/iu);
	assert.equal(examples.length, 1);
	for (const input of examples) {
		assert.equal(input.action, undefined);
		assert.equal(input.async, true);
		assert.equal(input.context, "fresh");
		assert.equal(input.cwd, "/absolute/path/to/repo");
	}
	for (const boundary of ["单任务直接", "只有多步骤或并行编排", "writer 前拒绝", "同一 cwd/worktree 只有一个 writer", "不重放写入", "不能将 `unknown` 写成成功"]) assert.ok(skill.includes(boundary), boundary);
});

test("single-task skill example is forwarded once without synthesizing a workflow", async () => {
	const input = examples[0];
	assert.deepEqual(Object.keys(input).sort(), ["agent", "async", "context", "cwd", "output", "task"]);
	assert.equal(input.agent, "scout");
	assert.equal(input.output, false);
	assert.match(input.task, /Do not edit files or launch subagents/u);
	const calls: unknown[] = [];
	let tool: any;
	// Exercise the product wrapper, not a real child: this proves argument
	// forwarding and receipt semantics, not model behavior or child completion.
	const receipt = { content: [], details: { asyncId: "fixture-run", mode: "single", results: [] } };
	const api = subagentPolicyApi({ on() {}, registerTool(definition: any) { tool = definition; } } as any);
	api.registerTool({ name: "subagent", execute(_id: string, args: unknown) { calls.push(args); return receipt; } } as any);
	const result = await tool.execute("fixture", input);
	assert.deepEqual(calls, [{ ...input, mission: false }]);
	assert.equal(input.mission, undefined, "do not mutate the caller's request");
	assert.equal(result.details.asyncId, "fixture-run");
	assert.equal(result.details.subagentPhase, "launch");
	assert.match(result.content[0].text, /launch receipt only/u);
});
