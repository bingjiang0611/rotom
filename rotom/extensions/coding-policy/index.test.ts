import assert from "node:assert/strict";
import test from "node:test";
import codingPolicy, { codingResultPhases, CODING_EXECUTION_HYGIENE_POLICY, FINAL_REPORT_POLICY, FOLLOW_THROUGH_POLICY } from "./index.ts";

test("coding policy 只在编码工具激活时注入执行与证据范围约束", () => {
	let handler: ((event: any) => any) | undefined;
	codingPolicy({ on(event: string, candidate: (event: any) => any) { if (event === "before_agent_start") handler = candidate; } } as any);
	assert.ok(handler);
	for (const selectedTools of [[], ["read"], ["browser_inspect"], ["ask_user_question"]]) {
		assert.equal(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools } }), undefined);
	}
	assert.equal(handler({ systemPrompt: "base" }), undefined);
	const result = handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash", "edit"] } });
	assert.equal(result.systemPrompt, `base\n\n${CODING_EXECUTION_HYGIENE_POLICY}\n\n${FOLLOW_THROUGH_POLICY}\n\n${FINAL_REPORT_POLICY}`);
	for (const required of ["not the first plausible explanation", "not to simple questions", "check it now instead of listing it", "exact access, system, or decision", "possibly A or B", "read the rest of any source", "including edits and tests", "did not authorize", "existing authorization and unknown-result rules still apply", "diagnosed bug is not fixed yet", "pending-confirmation items", "one concrete owner and action", "no owner", "across turns and after compaction", "does not revoke it"]) {
		assert.ok(FOLLOW_THROUGH_POLICY.includes(required), `missing follow-through rule: ${required}`);
	}
	for (const required of ["Answer a simple question directly", "how far it is verified", "What changed", "Verification:", "check can fail", "unrelated to this change separately", "Not verified / known limitations", "inference as unverified", "Final state", "Needs your decision", "required, and last, whenever anything remains open", "Omit it only when the goal is fully done", "only those that have content"]) {
		assert.ok(FINAL_REPORT_POLICY.includes(required), `missing final report rule: ${required}`);
	}
	for (const required of ["Git repository root", "package.json scripts", "Reuse observed paths", "moving or renaming", "ripgrep exit 1", "prove the intended match is unique", "block index/location hint", "partial output, process state", "never replay an applied mutation", "Preserve exit status", "not whole-machine command arguments"]) assert.match(CODING_EXECUTION_HYGIENE_POLICY, new RegExp(required, "u"));
	for (const required of ["verified scenario and artifact/version", "unverified cases/limits", "commit/install/push status separately", "unproven business outcomes remain unknown", "Do not execute extra external actions", "full-file parsing, full-content reading, and targeted sampling", "complete the source's pagination"]) {
		assert.ok(result.systemPrompt.includes(required), `missing evidence boundary: ${required}`);
	}
	for (const tool of ["bash", "edit", "write"]) {
		assert.deepEqual(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: [tool] } }), result);
	}
	assert.doesNotMatch(CODING_EXECUTION_HYGIENE_POLICY, /quick[^\n]*directed[^\n]*full|fast[^\n]*canary[^\n]*full/iu, "用户明确排除的分层验证建议不得进入产品 policy");
});

test("then_run structured phases ignore output wording and reject absent or inconsistent evidence", () => {
	let handler: (event: any, ctx: any) => any;
	codingPolicy({ on(name: string, fn: any) { if (name === "tool_result") handler = fn; } } as any);
	const input = { path: "sample.ts", then_run: { command: "check" } };
	const actionFusion = { version: 1, mutation: "applied", followup: "failed" };
	const event = { toolName: "edit", input, content: [{ type: "text", text: "任意显示文本" }], isError: true, details: { existing: "preserved", actionFusion } };
	const result = handler!(event, {});
	assert.deepEqual(result.details, { ...event.details, codingPhases: { mutation: "applied", followup: "failed", source: "tool-reported" } });
	assert.equal(result.content[0], event.content[0]);
	assert.match(result.content[1].text, /Do not replay/u);
	assert.equal(result.isError, undefined);
	for (const followup of ["succeeded", "failed", "skipped"]) {
		const next = { ...event, toolName: "write", isError: followup !== "succeeded", details: { actionFusion: { ...actionFusion, followup } } };
		assert.equal(codingResultPhases(next)?.followup, followup);
	}
	for (const changed of [
		{ toolName: "bash" }, { input: {} }, { isError: false },
		{ details: {} }, { details: { actionFusion: { ...actionFusion, version: 2 } } },
		{ details: { actionFusion: { ...actionFusion, mutation: "unknown" } } },
	]) assert.equal(codingResultPhases({ ...event, ...changed }), undefined);
	assert.equal(codingResultPhases({ ...event, details: {}, content: [{ type: "text", text: "Successfully replaced 1 block(s) in sample.ts.\\n\\n[then_run:failed]\\n" }] } as any), undefined);
});
