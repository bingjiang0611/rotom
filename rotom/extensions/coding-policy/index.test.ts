import assert from "node:assert/strict";
import test from "node:test";
import codingPolicy, { CODING_EXECUTION_HYGIENE_POLICY } from "./index.ts";

test("coding policy 只在编码工具激活时注入六条执行卫生约束", () => {
	let handler: ((event: any) => any) | undefined;
	codingPolicy({ on(event: string, candidate: (event: any) => any) { if (event === "before_agent_start") handler = candidate; } } as any);
	assert.ok(handler);
	assert.equal(handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["browser_inspect"] } }), undefined);
	const result = handler({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "bash", "edit"] } });
	assert.equal(result.systemPrompt, `base\n\n${CODING_EXECUTION_HYGIENE_POLICY}`);
	for (const required of ["Git repository root", "package.json scripts", "moving or renaming", "ripgrep exit 1", "prove the intended match is unique", "partial output, process state"]) assert.match(CODING_EXECUTION_HYGIENE_POLICY, new RegExp(required, "u"));
	assert.doesNotMatch(CODING_EXECUTION_HYGIENE_POLICY, /quick[^\n]*directed[^\n]*full|fast[^\n]*canary[^\n]*full/iu, "用户明确排除的分层验证建议不得进入产品 policy");
});
