import assert from "node:assert/strict";
import test from "node:test";
import codingPolicy, { codingResultPhases, CODING_EXECUTION_HYGIENE_POLICY } from "./index.ts";

test("coding policy 只在编码工具激活时注入执行与证据范围约束", () => {
	let handler: ((event: any) => any) | undefined;
	codingPolicy({ on(event: string, candidate: (event: any) => any) { if (event === "before_agent_start") handler = candidate; } } as any);
	assert.ok(handler);
	for (const selectedTools of [[], ["read"], ["browser_inspect"], ["ask_user_question"]]) {
		assert.equal(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools } }), undefined);
	}
	assert.equal(handler({ systemPrompt: "base" }), undefined);
	const result = handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash", "edit"] } });
	assert.equal(result.systemPrompt, `base\n\n${CODING_EXECUTION_HYGIENE_POLICY}`);
	for (const required of ["Git repository root", "package.json scripts", "Reuse observed paths", "moving or renaming", "ripgrep exit 1", "prove the intended match is unique", "block index/location hint", "partial output, process state", "never replay an applied mutation", "Preserve exit status", "not whole-machine command arguments"]) assert.match(CODING_EXECUTION_HYGIENE_POLICY, new RegExp(required, "u"));
	for (const required of ["verified scenario and artifact/version", "unverified cases/limits", "commit/install/push status separately", "unproven business outcomes remain unknown", "Do not execute extra external actions", "full-file parsing, full-content reading, and targeted sampling", "complete the source's pagination"]) {
		assert.ok(result.systemPrompt.includes(required), `missing evidence boundary: ${required}`);
	}
	for (const tool of ["bash", "edit", "write"]) {
		assert.deepEqual(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: [tool] } }), result);
	}
	assert.doesNotMatch(CODING_EXECUTION_HYGIENE_POLICY, /quick[^\n]*directed[^\n]*full|fast[^\n]*canary[^\n]*full/iu, "用户明确排除的分层验证建议不得进入产品 policy");
});

test("then_run receipts preserve applied mutations and failed validation without replay or status laundering", () => {
	let handler: (event: any, ctx: any) => any;
	codingPolicy({ on(name: string, fn: any) { if (name === "tool_result") handler = fn; } } as any);
	const input = { path: "src/sample.ts", edits: [{ oldText: "before", newText: "after" }], then_run: { command: "fixture check" } };
	const content = [{ type: "text", text: "Successfully replaced 1 block(s) in src/sample.ts.\n\n[then_run:failed]\nprivate validation output" }];
	const event = { toolName: "edit", input, content, isError: true, details: { existing: "preserved" } };
	const result = handler!(event, { cwd: "/must-not-read-or-write" });
	assert.deepEqual(result.details, { existing: "preserved", codingPhases: { mutation: "applied", followup: "failed", source: "tool-reported" } });
	assert.equal(result.content[0], content[0]);
	assert.match(result.content[1].text, /Do not replay/u);
	assert.equal(result.isError, undefined, "keep the original error; never turn a failed check into ok");
	assert.deepEqual(event.details, { existing: "preserved" });
	assert.equal(content.length, 1);
	const passed = handler!({ ...event, isError: false, content: [{ type: "text", text: content[0].text.replace("then_run:failed", "then_run:succeeded") }] }, {});
	assert.equal(passed.details.codingPhases.followup, "succeeded");
	assert.equal(passed.content, undefined);
	assert.equal(codingResultPhases({ ...event, toolName: "write", input: { path: "sample.txt", then_run: { command: "fixture check" } }, content: [{ type: "text", text: "Successfully wrote to sample.txt\n\n[then_run:failed]\n" }] })?.mutation, "applied");
	for (const changed of [
		{ toolName: "bash" }, { input: { ...input, then_run: undefined } },
		{ input: { ...input, path: "different.ts" } }, { isError: false },
		{ content: [{ type: "text", text: "diagnostic: " + content[0].text }] },
		{ content: [{ type: "text", text: "Could not find oldText.\n\n[then_run:failed]\n" }] },
		{ content: [{ type: "text", text: content[0].text.replace("1 block(s)", "2 block(s)") }] },
	]) assert.equal(codingResultPhases({ ...event, ...changed }), undefined);
});
