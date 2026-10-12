import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import contextFold, { contextFoldEnabled } from "./index.ts";
import { planFold, recallBlock, renderOutline, searchHidden } from "./fold.ts";

// Real Pi SessionManager/projection from the verified product runtime (check-personal sets ROTOM_PI).
async function loadPi() {
	let packageDir = dirname(realpathSync(process.env.ROTOM_PI!));
	let pkg: any;
	for (;;) {
		const path = join(packageDir, "package.json");
		if (existsSync(path)) { pkg = JSON.parse(readFileSync(path, "utf8")); if (pkg.name === "@earendil-works/pi-coding-agent") break; }
		const parent = dirname(packageDir); assert.notEqual(parent, packageDir); packageDir = parent;
	}
	const pi = await import(pathToFileURL(join(packageDir, pkg.exports["."].import)).href);
	const piAi = await import(pathToFileURL(resolve(packageDir, "../pi-ai/dist/index.js")).href);
	return { pi, piAi };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[], stopReason = "toolUse") => ({ role: "assistant", content, api: "faux", provider: "faux", model: "faux", usage, stopReason, timestamp: Date.now() });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, toolName: string, text: string) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const big = (label: string) => `${label} ${"output line\n".repeat(400)}`;

function apply(manager: any, drafts: any[]) {
	for (const draft of drafts) {
		if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
		else manager.appendCustomEntry(draft.customType, draft.data);
	}
}

async function history() {
	const { pi } = await loadPi();
	const manager = pi.SessionManager.inMemory("/fixture");
	const ids: Record<string, string> = {};
	ids.user1 = manager.appendMessage({ role: "user", content: "fix the parser", timestamp: Date.now() });
	ids.a1 = manager.appendMessage(assistant([{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" }, call("c1", "read", { path: "src/parser.ts" })]));
	ids.t1 = manager.appendMessage(result("c1", "read", big("PARSER-SOURCE-V1")));
	ids.a2 = manager.appendMessage(assistant([call("c2", "bash", { command: "npm test" }), call("c3", "read", { path: "README.md" })]));
	ids.t2 = manager.appendMessage(result("c2", "bash", big("TEST-FAILURE-OUTPUT")));
	ids.t3 = manager.appendMessage(result("c3", "read", big("README-CONTENT")));
	ids.a3 = manager.appendMessage(assistant([call("c4", "edit", { path: "src/parser.ts", edits: [] })]));
	ids.t4 = manager.appendMessage(result("c4", "edit", "Successfully replaced 1 block(s) in src/parser.ts."));
	ids.a4 = manager.appendMessage(assistant([{ type: "text", text: "Parser fixed." }], "stop"));
	ids.user2 = manager.appendMessage({ role: "user", content: "now add docs", timestamp: Date.now() });
	ids.a5 = manager.appendMessage(assistant([call("c5", "read", { path: "docs/a.md" })]));
	ids.t5 = manager.appendMessage(result("c5", "read", big("DOCS-A")));
	ids.a6 = manager.appendMessage(assistant([call("c6", "read", { path: "docs/b.md" })]));
	ids.t6 = manager.appendMessage(result("c6", "read", big("DOCS-B")));
	return { pi, manager, ids };
}

const projectionOf = (manager: any) => manager.buildSessionProjection().entries;

test("ROTOM_CONTEXT_FOLD is an explicit opt-in and the extension registers nothing when off", () => {
	assert.equal(contextFoldEnabled({}), false);
	assert.equal(contextFoldEnabled({ ROTOM_CONTEXT_FOLD: "0" }), false);
	assert.equal(contextFoldEnabled({ ROTOM_CONTEXT_FOLD: "1" }), true);
	for (const value of ["", "true", "2"]) assert.throws(() => contextFoldEnabled({ ROTOM_CONTEXT_FOLD: value }), /must be 0 or 1/u);
	const previous = process.env.ROTOM_CONTEXT_FOLD;
	delete process.env.ROTOM_CONTEXT_FOLD;
	try {
		const calls: string[] = [];
		contextFold(new Proxy({}, { get: (_target, key) => () => calls.push(String(key)) }) as any);
		assert.deepEqual(calls, []);
	} finally {
		if (previous !== undefined) process.env.ROTOM_CONTEXT_FOLD = previous;
	}
});

test("fold keeps the first assistant verbatim, puts the summary in its result and omits the rest of the range", async () => {
	const { pi, manager, ids } = await history();
	const plan = planFold(projectionOf(manager), manager.getBranch(), { from: ids.a1, to: ids.a3, summary: "Read parser, tests failed on X, edited src/parser.ts.", currentEntryId: undefined });
	assert.ok(plan.ok, plan.ok ? "" : plan.error);
	apply(manager, plan.drafts);
	const messages = manager.buildSessionProjection().messages;
	const llm = pi.convertToLlm(messages);
	assert.deepEqual(llm.map((message: any) => message.role), ["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult", "assistant", "toolResult"]);
	assert.equal(messages[1].content[0].thinkingSignature, "sig-1", "the kept assistant must keep its signed thinking");
	assert.equal(messages[1].content[1].id, "c1");
	assert.match(messages[2].content[0].text, /^\[context fold b1 · 3 tool step\(s\) folded/u);
	assert.equal(messages[2].toolCallId, "c1");
	const sent = JSON.stringify(llm);
	for (const hidden of ["PARSER-SOURCE-V1", "TEST-FAILURE-OUTPUT", "README-CONTENT"]) assert.doesNotMatch(sent, new RegExp(hidden, "u"));
	assert.match(sent, /fix the parser/u);
	assert.match(sent, /Parser fixed\./u);

	// Persisted entries are the whole state: a reopened session projects identically.
	const reopened = pi.SessionManager.inMemory("/fixture", undefined, [manager.getHeader(), ...manager.getEntries()]);
	assert.deepEqual(reopened.buildSessionProjection().messages, messages);
});

test("fold rejects ranges that cross user messages, start at text replies, exceed the current step or do not shrink", async () => {
	const { manager, ids } = await history();
	const projection = projectionOf(manager);
	const branch = manager.getBranch();
	const summary = "short";
	const attempt = (from: string, to: string, extra: Partial<{ summary: string; currentEntryId: string }> = {}) => planFold(projection, branch, { from, to, summary, currentEntryId: undefined, ...extra });
	assert.match((attempt(ids.a1, ids.a5) as any).error, /crosses a user message/u);
	assert.match((attempt(ids.a4, ids.a4) as any).error, /tool step/u);
	assert.match((attempt(ids.t1, ids.a3) as any).error, /not a visible completed step/u);
	assert.match((attempt(ids.a3, ids.a1) as any).error, /at or after from/u);
	assert.match((attempt(ids.a5, ids.a6, { currentEntryId: ids.a6 }) as any).error, /not a visible completed step/u);
	assert.match((attempt(ids.a3, ids.a3, { summary: "x".repeat(200) }) as any).error, /at most half/u);
	assert.match((attempt(ids.a1, ids.a1, { summary: " " }) as any).error, /must not be empty/u);
});

test("nested folds subsume older blocks; recall returns originals with later-change notes; search covers hidden history", async () => {
	const { manager, ids } = await history();
	const first = planFold(projectionOf(manager), manager.getBranch(), { from: ids.a2, to: ids.a2, summary: "tests failed", currentEntryId: undefined });
	assert.ok(first.ok);
	apply(manager, first.drafts);
	const second = planFold(projectionOf(manager), manager.getBranch(), { from: ids.a1, to: ids.a3, summary: "parser work done", currentEntryId: undefined });
	assert.ok(second.ok, second.ok ? "" : second.error);
	assert.equal(second.block, "b2");
	apply(manager, second.drafts);
	const sent = JSON.stringify(manager.buildSessionProjection().messages);
	assert.doesNotMatch(sent, /tests failed/u, "the subsumed holder is omitted");
	assert.match(sent, /context fold b2/u);

	const outline = renderOutline(projectionOf(manager), manager.getBranch(), { currentEntryId: undefined, offset: 0, limit: 80 });
	assert.match(outline.text, new RegExp(`${ids.a1}  step  read\\(src/parser.ts\\).*\\[fold b2: 7 messages hidden\\]`, "u"));
	assert.match(outline.text, new RegExp(`${ids.user2}  user  "now add docs"  \\(boundary`, "u"));

	const recall = recallBlock(manager.getBranch(), "b2", 0);
	assert.ok(recall.ok);
	assert.match(recall.text, /^\[recall b2 · chars 0-12000 of \d+ · historical originals, not current state\]/u);
	assert.match(recall.text, /PARSER-SOURCE-V1/u);
	assert.ok(recall.nextOffset);
	const rest = recallBlock(manager.getBranch(), "b2", recall.nextOffset!);
	assert.ok(rest.ok);
	assert.match(rest.text, /Successfully replaced 1 block/u);
	assert.equal(rest.nextOffset, undefined);
	assert.equal(recallBlock(manager.getBranch(), "b9", 0).ok, false);

	// A later edit of a recalled path is reported; a path that was only read is not.
	// Edits after the recalled read are reported by exact path, including edits inside the block.
	assert.match(recall.text, new RegExp(`Note: src/parser\\.ts was modified later by step ${ids.a3}; read it again`, "u"));
	assert.doesNotMatch(recall.text, /README\.md was modified/u, "a path that was only read is not reported");
	manager.appendMessage(assistant([call("c7", "write", { path: "README.md", content: "new" })]));
	const later = recallBlock(manager.getBranch(), "b2", 0);
	assert.ok(later.ok);
	assert.match(later.text, /Note: README\.md was modified later by step \w+; read it again/u);

	const search = searchHidden(projectionOf(manager), manager.getBranch(), "test-failure-output");
	assert.ok(search.ok);
	assert.match(search.text, new RegExp(`1 match\\(es\\).*\\n(b1|b2) · ${ids.t2}: `, "u"));
	assert.match(searchHidden(projectionOf(manager), manager.getBranch(), "DOCS-A").text as string, /0 match/u, "visible history is not searched");
});

test("context nudge is appended once per 10% bucket from 50% and never to its own results", () => {
	const previous = process.env.ROTOM_CONTEXT_FOLD;
	process.env.ROTOM_CONTEXT_FOLD = "1";
	try {
		const handlers = new Map<string, any>();
		contextFold({ registerTool() {}, on(name: string, handler: any) { handlers.set(name, handler); } } as any);
		const onResult = handlers.get("tool_result");
		const event = (toolName = "bash") => ({ toolName, content: [{ type: "text", text: "ok" }] });
		const at = (percent: number | null, toolName?: string) => onResult(event(toolName), { getContextUsage: () => ({ tokens: percent === null ? null : 1, percent, contextWindow: 100 }) });
		assert.equal(at(49), undefined);
		assert.match(at(51).content[1].text, /~51% of the context window/u);
		assert.equal(at(58), undefined);
		assert.equal(at(null), undefined);
		assert.equal(at(65, "context"), undefined);
		assert.ok(at(61));
		assert.equal(at(40), undefined, "after a fold shrinks context the bucket resets");
		assert.ok(at(52));
	} finally {
		if (previous === undefined) delete process.env.ROTOM_CONTEXT_FOLD; else process.env.ROTOM_CONTEXT_FOLD = previous;
	}
});

test("SDK + faux provider: a fold issued mid-run changes the very next provider request and survives reopen", { timeout: 30_000 }, async (t) => {
	const { pi, piAi } = await loadPi();
	const root = await mkdtemp(join(tmpdir(), "context-fold-sdk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessions = join(root, "sessions");
	await mkdir(cwd); await mkdir(agentDir);
	const fixture = join(root, "fixture-tool.ts");
	await writeFile(fixture, `export default (pi) => pi.registerTool({ name: "fixture_read", label: "fixture", description: "fixture", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, execute: async (_id, p) => ({ content: [{ type: "text", text: "BIG-" + p.n + " " + "x".repeat(4000) }], details: {} }) });\n`);
	const previous = process.env.ROTOM_CONTEXT_FOLD;
	process.env.ROTOM_CONTEXT_FOLD = "1";
	t.after(() => { if (previous === undefined) delete process.env.ROTOM_CONTEXT_FOLD; else process.env.ROTOM_CONTEXT_FOLD = previous; });

	const faux = piAi.fauxProvider({ provider: "context-fold-faux", models: [{ id: "fixture", contextWindow: 64_000, maxTokens: 1_024 }] });
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const services = await pi.createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [resolve(import.meta.dirname, "index.ts"), fixture] } });
	const sessionManager = pi.SessionManager.create(cwd, sessions);
	const created = await pi.createAgentSessionFromServices({ services, sessionManager, model: faux.getModel(), sessionStartEvent: { type: "session_start", reason: "startup" } });
	assert.deepEqual(created.extensionsResult.errors, []);
	await created.session.bindExtensions({ mode: "print", onError: (error: unknown) => { throw error; } });
	t.after(() => created.session.dispose());
	assert.ok(created.session.getActiveToolNames().includes("context"), "the tool is resident once enabled");

	const stepId = (callId: string) => sessionManager.getBranch().find((entry: any) => entry.message?.role === "assistant" && entry.message.content.some((part: any) => part.id === callId))?.id;
	const requests: string[] = [];
	const tool = (name: string, args: any, id: string) => piAi.fauxAssistantMessage([piAi.fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
	faux.setResponses([
		() => tool("fixture_read", { n: 1 }, "r1"),
		() => tool("fixture_read", { n: 2 }, "r2"),
		() => tool("context", { action: "fold", from: stepId("r1"), to: stepId("r2"), summary: "Read fixtures 1 and 2; nothing notable." }, "f1"),
		(context: any) => { requests.push(JSON.stringify(context.messages)); return tool("context", { action: "recall", block: "b1" }, "q1"); },
		(context: any) => { requests.push(JSON.stringify(context.messages)); return piAi.fauxAssistantMessage("done"); },
	]);
	await created.session.prompt("inspect fixtures");

	assert.equal(requests.length, 2);
	assert.match(requests[0], /context fold b1/u);
	assert.doesNotMatch(requests[0], /BIG-1|BIG-2/u, "the folded step must be gone from the next request in the same run");
	assert.match(requests[1], /\[recall b1 · chars 0-\d+ of \d+ · historical originals, not current state\][\s\S]*BIG-2/u, "recall appends originals at the tail");
	// Compare as persisted JSON: reopening drops undefined-valued fields, nothing else.
	const reopened = pi.SessionManager.open(sessionManager.getSessionFile());
	assert.equal(JSON.stringify(reopened.buildSessionProjection().messages), JSON.stringify(sessionManager.buildSessionProjection().messages));
});
