import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codingPolicy from "./index.ts";
import { PI_RUNTIME_DRIFT_MARKER, piRuntimeDriftDiagnosis } from "./pi-runtime-drift.ts";
import { REPAIR_HINT_PREFIX, toolErrorRepairHint } from "./repair-hints.ts";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "dev-agent-repair-hints-"));
}

test("read ENOENT 附带最深存在目录与近似文件名，不重复同一路径", () => {
	const root = workspace();
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "turn-recorder.ts"), "export const a = 1;\n");
	const missing = join(root, "src", "turn-recorde.ts");

	const hint = toolErrorRepairHint("read", { path: missing }, [{ type: "text", text: `ENOENT: no such file or directory, access '${missing}'` }], root);
	assert.ok(hint);
	assert.match(hint, new RegExp(`^${REPAIR_HINT_PREFIX}`, "u"));
	assert.match(hint, new RegExp(`deepest existing directory is '${join(root, "src")}'`, "u"));
	assert.match(hint, /Similar existing names there: turn-recorder\.ts/u);

	const missingDirectory = join(root, "srcs", "deep", "file.ts");
	const directoryHint = toolErrorRepairHint("read", { path: missingDirectory }, [{ type: "text", text: `ENOENT: no such file or directory, access '${missingDirectory}'` }], root);
	assert.ok(directoryHint);
	assert.match(directoryHint, /path segment 'srcs' under it does not exist/u);
	assert.match(directoryHint, /Similar existing names there: src/u);

	assert.equal(toolErrorRepairHint("read", { path: join(root, "src", "turn-recorder.ts") }, [{ type: "text", text: "Operation aborted" }], root), undefined);
	assert.equal(toolErrorRepairHint("bash", { command: "ls /nope" }, [{ type: "text", text: "ENOENT: no such file or directory, access '/nope'" }], root), undefined);
});

test("edit 不唯一时给出真实 occurrence 行号，不匹配时给出分歧行", () => {
	const root = workspace();
	const file = join(root, "app.ts");
	writeFileSync(file, ["const a = 1;", "duplicate();", "const b = 2;", "duplicate();", "const c = 3;"].join("\n"));

	const ambiguous = toolErrorRepairHint(
		"edit",
		{ path: "app.ts", edits: [{ oldText: "duplicate();", newText: "x();" }] },
		[{ type: "text", text: "Found 2 occurrences of edits[0] in app.ts. Each oldText must be unique. Please provide more context to make it unique." }],
		root,
	);
	assert.ok(ambiguous);
	assert.match(ambiguous, /it starts at lines 2, 4 \(1-based\)/u);

	const diverging = toolErrorRepairHint(
		"edit",
		{ path: file, edits: [{ oldText: "const a = 1;\nduplicate();\nconst b = 3;", newText: "" }] },
		[{ type: "text", text: `Could not find edits[0] in ${file}. The oldText must match exactly including all whitespace and newlines.` }],
		root,
	);
	assert.ok(diverging);
	assert.match(diverging, /first 2 oldText lines match at line 1, then line 3 diverges/u);
	assert.match(diverging, /oldText has 'const b = 3;' while the file has 'const b = 2;'/u);

	const unknown = toolErrorRepairHint(
		"edit",
		{ path: file, edits: [{ oldText: "totally absent line", newText: "" }] },
		[{ type: "text", text: `Could not find edits[0] in ${file}. The oldText must match exactly including all whitespace and newlines.` }],
		root,
	);
	assert.ok(unknown);
	assert.match(unknown, /does not occur anywhere in the file \(5 lines\)/u);
});

test("edit 缩进不一致时指出仅缩进差异的候选行，重叠时给出两段行范围", () => {
	const root = workspace();
	const file = join(root, "indent.ts");
	writeFileSync(file, ["function f() {", "\t\treturn 1;", "}"].join("\n"));

	const indentation = toolErrorRepairHint(
		"edit",
		{ path: file, oldText: "return 1;\n}", newText: "return 2;\n}" },
		[{ type: "text", text: `Could not find the exact text in ${file}. The old text must match exactly including all whitespace and newlines.` }],
		root,
	);
	assert.ok(indentation);
	assert.match(indentation, /only matches after trimming indentation, at line 2/u);

	const overlapFile = join(root, "overlap.ts");
	writeFileSync(overlapFile, ["one", "two", "three", "four"].join("\n"));
	const overlap = toolErrorRepairHint(
		"edit",
		{ path: overlapFile, edits: [{ oldText: "one\ntwo", newText: "" }, { oldText: "two\nthree", newText: "" }] },
		[{ type: "text", text: `edits[0] and edits[1] overlap in ${overlapFile}. Merge them into one edit or target disjoint regions.` }],
		root,
	);
	assert.ok(overlap);
	assert.match(overlap, /edits\[0\] covers lines 1-2 and edits\[1\] covers lines 2-3/u);
});

test("hint 只附加不覆盖，且已附加过的错误不再二次附加", () => {
	const root = workspace();
	const missing = join(root, "nope.ts");
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	codingPolicy({ on(event: string, handler: (event: any, ctx?: any) => any) { handlers.set(event, handler); } } as any);
	const toolResult = handlers.get("tool_result");
	assert.ok(toolResult);

	const content = [{ type: "text", text: `ENOENT: no such file or directory, access '${missing}'` }];
	const result = toolResult({ toolName: "read", input: { path: missing }, content, isError: true }, { cwd: root });
	assert.equal(result.content.length, 2);
	assert.deepEqual(result.content[0], content[0], "原始错误正文必须保持原样");
	assert.equal(result.isError, undefined, "hint 不得改写 isError");
	assert.equal(toolResult({ toolName: "read", input: { path: missing }, content: result.content, isError: true }, { cwd: root }), undefined);
	assert.equal(toolResult({ toolName: "read", input: { path: missing }, content, isError: false }, { cwd: root }), undefined);
});

test("pi bundle 在会话运行期间被重建时改写为可诊断结论，其他模块错误保持原样", () => {
	const root = workspace();
	const bundle = join(root, "dist", "bundle");
	const chunks = join(bundle, "chunks");
	mkdirSync(chunks, { recursive: true });
	writeFileSync(join(bundle, "cli.js"), "");
	const entryPath = join(bundle, "cli.js");
	const missingChunk = join(chunks, "anthropic-messages-QAQLEQIY.js");

	const diagnosis = piRuntimeDriftDiagnosis(`Cannot find module '${missingChunk}' imported from ${bundle}`, { entryPath, processStartMs: Date.UTC(2026, 8, 7, 1, 0, 0) });
	assert.ok(diagnosis);
	assert.match(diagnosis, new RegExp(PI_RUNTIME_DRIFT_MARKER, "u"));
	assert.match(diagnosis, /缺失 chunk 'anthropic-messages-QAQLEQIY\.js'/u);
	assert.match(diagnosis, /本进程启动于 2026-09-07T01:00:00\.000Z/u);
	assert.match(diagnosis, /重试同一请求不会恢复/u);
	assert.match(diagnosis, /原始错误：Cannot find module/u, "原始错误必须保留");
	assert.equal(piRuntimeDriftDiagnosis(diagnosis, { entryPath }), undefined, "已诊断过的消息不得二次改写");

	writeFileSync(missingChunk, "");
	assert.equal(piRuntimeDriftDiagnosis(`Cannot find module '${missingChunk}'`, { entryPath }), undefined, "chunk 仍存在时不得归因为 bundle 漂移");
	assert.equal(piRuntimeDriftDiagnosis(`Cannot find module '${join(root, "src", "app.ts")}'`, { entryPath }), undefined);
	assert.equal(piRuntimeDriftDiagnosis("Codex error: Our servers are currently overloaded.", { entryPath }), undefined);
});

test("message_end 只改写 assistant 错误消息的 errorMessage", () => {
	const root = workspace();
	const chunks = join(root, "dist", "bundle", "chunks");
	mkdirSync(chunks, { recursive: true });
	const handlers = new Map<string, (event: any, ctx?: any) => any>();
	codingPolicy({ on(event: string, handler: (event: any, ctx?: any) => any) { handlers.set(event, handler); } } as any);
	const messageEnd = handlers.get("message_end");
	assert.ok(messageEnd);

	const errorMessage = `Cannot find module '${join(chunks, "anthropic-messages-QAQLEQIY.js")}'`;
	const message = { role: "assistant", stopReason: "error", errorMessage, model: "claude-opus-5", content: [] };
	const replaced = messageEnd({ message });
	assert.equal(replaced.message.role, "assistant");
	assert.equal(replaced.message.model, "claude-opus-5");
	assert.match(replaced.message.errorMessage, new RegExp(PI_RUNTIME_DRIFT_MARKER, "u"));
	assert.equal(message.errorMessage, errorMessage, "原消息对象不得被就地修改");

	assert.equal(messageEnd({ message: { role: "assistant", stopReason: "stop", errorMessage } }), undefined);
	assert.equal(messageEnd({ message: { role: "toolResult", stopReason: "error", errorMessage } }), undefined);
	assert.equal(messageEnd({ message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed" } }), undefined);
});
