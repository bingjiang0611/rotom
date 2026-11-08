import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { search, BLOCK_ENTRY, RECALL_TOOL } from "./blocks.ts";
import { recall } from "./recall.ts";
import { COPY } from "./copy.ts";
import { fixture, view, SessionManager, DefaultResourceLoader, SettingsManager, ModelRuntime, createAgentSession, fauxAssistantMessage, fauxToolCall, fauxProvider } from "./test-helpers.ts";

test("tool surface is one sequential model-only recall tool; opt-out and explicit selection both apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-layers-surface-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: [resolve(import.meta.dirname, "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  let session: any;
  let restricted: any;
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const ext = loader.getExtensions().extensions[0];
    assert.deepEqual([...ext.tools.keys()], [RECALL_TOOL]);
    const definition = ext.tools.get(RECALL_TOOL)!.definition;
    assert.equal(definition.exposure, "model-only");
    assert.equal(definition.executionMode, "sequential");
    assert.deepEqual(ext.handlers.get("turn_end"), undefined, "retrieval-only extension must not write at turn boundaries");

    const { manager: m, ids } = fixture(undefined, 6);
    const faux = fauxProvider({ provider: "layers-test", models: [{ id: "test", contextWindow: 30000, maxTokens: 1024 }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const created = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(),
      tools: [RECALL_TOOL], resourceLoader: loader, settingsManager: settings, sessionManager: m,
      sessionStartEvent: { type: "session_start", reason: "startup" } });
    session = created.session;
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: (e: unknown) => errors.push(e) });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(RECALL_TOOL, { query: "secret-3" }, { id: "search-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("found it"),
    ]);
    await session.prompt("Find the recorded detail for row three.");
    assert.deepEqual(errors, []);
    const result = session.messages.findLast((x: any) => x.role === "toolResult" && x.toolName === RECALL_TOOL);
    const details = JSON.parse(result.content[0].text);
    assert.equal(details.coverage, "matching-parts");
    assert.equal(details.matches[0].role, "toolResult:read");
    assert.match(details.matches[0].excerpt, /secret-3/);
    assert.ok(details.matches[0].excerpt.length <= 320, "excerpts are bounded");

    // Explicit tool selection still wins over the extension default surface.
    restricted = (await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(),
      tools: ["read"], resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
      sessionStartEvent: { type: "session_start", reason: "startup" } })).session;
    assert.equal(restricted.getActiveToolNames().includes(RECALL_TOOL), false);
    restricted.dispose(); restricted = undefined;

    process.env.ROTOM_CONTEXT_LAYERS = "0";
    await loader.reload();
    assert.equal(loader.getExtensions().extensions[0].tools.size, 0);
  } finally { delete process.env.ROTOM_CONTEXT_LAYERS; session?.dispose(); restricted?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("query and ref are mutually exclusive in runtime, and mode only applies to ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-layers-args-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: [resolve(import.meta.dirname, "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  try {
    await loader.reload();
    const { manager: m, ids } = fixture(undefined, 6);
    const execute = (args: unknown) => loader.getExtensions().extensions[0].tools.get(RECALL_TOOL)!.definition
      .execute("call", args, undefined, undefined, { sessionManager: m, model: undefined } as any);
    const schema = loader.getExtensions().extensions[0].tools.get(RECALL_TOOL)!.definition.parameters as any;
    assert.deepEqual(schema.required ?? [], [], "neither selector may be schema-required; both are checked at runtime");
    await assert.rejects(() => execute({}), new RegExp(COPY.selector));
    await assert.rejects(() => execute({ query: "secret-1", ref: `@${ids[1]}` }), new RegExp(COPY.selector));
    await assert.rejects(() => execute({ query: "secret-1", mode: "full" }), new RegExp(COPY.modeWithQuery));
    const found = await execute({ query: "secret-1" });
    assert.equal(JSON.parse((found as any).content[0].text).matches.length, 1);
    const page = await execute({ ref: `@${ids[1]}`, mode: "full" });
    assert.equal((page as any).details.coverage, "requested-view");
    await assert.rejects(() => execute({ ref: "missing-block" }), new RegExp(COPY.unknownBlock));
    await assert.rejects(() => execute({ ref: `@${ids[1]}`, offset: 99 }), new RegExp(COPY.offset));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("search covers original text, tool names, tool arguments and legacy summaries, and never reasoning or siblings", () => {
  const { manager: m, ids } = fixture(undefined, 8);
  const blockId = m.appendCustomEntry(BLOCK_ENTRY, { version: 1, id: "legacy-1", tier: 1, carrier: ids[0], direct: [ids[0]],
    covered: [ids[0]], children: [], summary: "Legacy gamma summary about the deployment checklist", before: 100, after: 10 });
  m.appendMessage(fauxAssistantMessage([{ type: "thinking", thinking: "private-thought-token", thinkingSignature: "sig" }, { type: "text", text: "public line" }]));
  const mainLeaf = m.getLeafId();
  m.branch(ids[1]);
  m.appendMessage({ role: "user", content: "sibling-only-token", timestamp: 99 });
  m.branch(mainLeaf);
  const current = view(m);
  assert.equal(m.getBranch().some(e => e.type === "custom" && e.customType === BLOCK_ENTRY), true, blockId);

  const textHit = search(current, "public line", 0);
  assert.equal(textHit.matches.length, 1);
  assert.equal(textHit.matches[0].role, "assistant");
  assert.equal(search(current, "PUBLIC LINE", 0).matches.length, 1, "search is case-insensitive");
  assert.deepEqual(search(current, "file-5", 0).matches.map(h => h.ref), [`@${ids[5]}`], "tool arguments are searchable");
  assert.equal(search(current, "read", 0).matches.length, 8, "tool names are searchable once per call");
  assert.deepEqual(search(current, "deployment checklist", 0).matches.map(h => h.ref), ["legacy-1"]);
  assert.equal(search(current, "GAMMA SUMMARY", 0).matches[0].role, "summary");
  assert.equal(search(current, "private-thought-token", 0).matches.length, 0, "provider reasoning is never searchable");
  assert.equal(search(current, "sibling-only-token", 0).matches.length, 0, "search stays on the current branch");
  assert.equal(search(current, "secret-7", 0).matches[0].role, "toolResult:read");
});

test("search paginates with complete/nextOffset and rejects an offset past the result", () => {
  const { manager: m } = fixture(undefined, 40);
  const current = view(m);
  const first = search(current, "secret-", 0);
  assert.equal(first.matches.length, 24);
  assert.equal(first.complete, false);
  assert.equal(first.coverage, "matching-parts");
  const second = search(current, "secret-", first.nextOffset!);
  assert.equal(second.matches.length, 16);
  assert.equal(second.complete, true);
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.matches, ...second.matches].map(h => h.ref).length, 40);
  const empty = search(current, "secret-", 40);
  assert.deepEqual(empty.matches, [], "offset at the match count returns an empty final page");
  assert.equal(empty.complete, true);
  assert.throws(() => search(current, "secret-", 41), new RegExp(COPY.offset));
});

test("recall pages Unicode, keeps tool error evidence, images and arguments, and hides reasoning signatures", () => {
  const m = SessionManager.inMemory(process.cwd());
  const body = "a".repeat(11999) + "😀" + "b".repeat(12001);
  const id = m.appendMessage({ role: "user", content: body, timestamp: 1 });
  const textParts: string[] = [];
  let offset = 0;
  for (;;) {
    const page = recall(view(m), `@${id}`, "full", offset, false);
    for (const part of page.content.slice(1)) {
      if (part.type === "text" && !part.text.startsWith("[Historical entry")) {
        assert.equal(part.text.isWellFormed(), true);
        textParts.push(part.text);
      }
    }
    if (page.details.nextOffset === null) break;
    offset = page.details.nextOffset;
  }
  assert.equal(textParts.join(""), body);
  const privateId = m.appendMessage(fauxAssistantMessage([{ type: "thinking", thinking: "private-thought", thinkingSignature: "private-signature" }, { type: "text", text: "public-evidence" }]));
  const result = JSON.stringify(recall(view(m), `@${privateId}`, "full", 0, false));
  assert.match(result, /public-evidence/);
  assert.doesNotMatch(result, /private-thought|private-signature/);
  const callsId = m.appendMessage(fauxAssistantMessage([fauxToolCall("read", { path: "kept/argument.txt" }, { id: "call-1" })], { stopReason: "toolUse" }));
  assert.match(JSON.stringify(recall(view(m), `@${callsId}`, "full", 0, false)), /kept\/argument.txt/, "tool call arguments stay recoverable");
  const errorId = m.appendMessage({ role: "toolResult", toolCallId: "failure", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }], timestamp: 1 });
  assert.match(JSON.stringify(recall(view(m), `@${errorId}`, "full", 0, false)), /isError/);
  const imageId = m.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" }], timestamp: 10 });
  const header = recall(view(m), `@${imageId}`, "full", 0, true);
  assert.equal(header.details.nextOffset, 1);
  assert.throws(() => recall(view(m), `@${imageId}`, "full", 1, false), /does not support images/);
  assert.equal(recall(view(m), `@${imageId}`, "full", 1, true).content[1].type, "image");
  assert.throws(() => recall(view(m), "@unknown", "full", 0, false), new RegExp(COPY.missing));
});

test("corrupt and unknown block records are rejected instead of inferred", () => {
  const bad = (data: unknown) => {
    const m = SessionManager.inMemory(process.cwd());
    m.appendMessage({ role: "user", content: "task", timestamp: 1 });
    m.appendCustomEntry(BLOCK_ENTRY, data);
    assert.throws(() => view(m), new RegExp(COPY.corrupt));
  };
  bad({ version: 2, id: "x", carrier: "a", covered: ["a"], children: [], direct: [], summary: "s", tier: 1 });
  bad({ version: 1, id: "x", tier: 1, carrier: "a", direct: [], covered: [], children: [], summary: "s" });
  bad({ version: 1, id: "x", tier: 1, carrier: "a", direct: [], covered: ["a"], children: ["missing"], summary: "s" });
  const ok = SessionManager.inMemory(process.cwd());
  const id = ok.appendMessage({ role: "user", content: "task", timestamp: 1 });
  ok.appendCustomEntry(BLOCK_ENTRY, { version: 1, id: "x", tier: 1, carrier: id, direct: [id], covered: [id], children: [], summary: "s", before: 10, after: 2 });
  assert.equal(view(ok).states.get("x"), "partial");
});
