import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildView, candidates, commitDrafts, planCompression, status, search } from "./blocks.ts";
import { recall } from "./recall.ts";
let piRoot = process.env.ROTOM_PI ? dirname(process.env.ROTOM_PI) : resolve(import.meta.dirname, "../../runtime/pi/node_modules/@earendil-works/pi-coding-agent");
while (!existsSync(join(piRoot, "package.json")) || JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  const parent = dirname(piRoot);
  if (parent === piRoot) throw new Error("Cannot locate selected Pi package");
  piRoot = parent;
}
const { SessionManager, estimateTokens, DefaultResourceLoader, SettingsManager, ModelRuntime, createAgentSession } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { fauxAssistantMessage, fauxToolCall, fauxProvider } = await import(pathToFileURL(resolve(piRoot, "../pi-ai/dist/index.js")).href);

function fixture(manager = SessionManager.inMemory(process.cwd())) {
  manager.appendMessage({ role: "user", content: "Keep requirements exact", timestamp: 1 });
  const ids: string[] = [];
  for (let n = 0; n < 14; n++) {
    ids.push(manager.appendMessage(fauxAssistantMessage([fauxToolCall("read", { path: `file-${n}` }, { id: `c${n}` })], { stopReason: "toolUse" })));
    manager.appendMessage({ role: "toolResult", toolCallId: `c${n}`, toolName: "read", content: [{ type: "text", text: `secret-${n} ` + "original details ".repeat(300) }], isError: false, timestamp: n + 2 });
  }
  return { manager, ids };
}
const view = (m: any) => buildView(m.getBranch(), m.buildSessionProjection());
function apply(m: any, drafts: any[]) {
  for (const d of drafts) {
    if (d.type === "custom") m.appendCustomEntry(d.customType, d.data);
    else m.appendContextEdit(d.targetId, d.replacement);
  }
}
function fold(m: any, start: string, end: string, id: string, summary = "Decisions and paths retained.") {
  const plan = planCompression(view(m), { start, end, summary }, estimateTokens, id);
  apply(m, commitDrafts(view(m), plan));
  return plan;
}

test("incremental projection shrinks, preserves raw originals, and rejects protected/empty/nonshrinking ranges", () => {
  const { manager: m, ids } = fixture();
  const raw = m.getBranch().filter(e => e.type === "message");
  const before = m.buildSessionProjection().messages.reduce((n, x) => n + estimateTokens(x), 0);
  const ranges = candidates(view(m), estimateTokens);
  assert.equal(ranges[0].start, `@${ids[0]}`);
  fold(m, `@${ids[0]}`, `@${ids[2]}`, "b1");
  assert.equal(view(m).states.get("b1"), "active");
  assert.deepEqual(m.getBranch().filter(e => e.type === "message"), raw);
  assert.ok(m.buildSessionProjection().messages.reduce((n, x) => n + estimateTokens(x), 0) < before);
  assert.throws(() => planCompression(view(m), { start: `@${ids[12]}`, end: `@${ids[13]}`, summary: "x" }, estimateTokens, "bad"), /protected/);
  assert.throws(() => planCompression(view(m), { start: `@${ids[3]}`, end: `@${ids[4]}`, summary: " " }, estimateTokens, "bad"));
  assert.throws(() => planCompression(view(m), { start: `@${ids[3]}`, end: `@${ids[4]}`, summary: "long ".repeat(10000) }, estimateTokens, "bad"), /smaller/);
  assert.throws(() => fold(m, `@${ids[0]}`, `@${ids[1]}`, "bad"));
});

test("three-tier graph, rewrite, one-level/full recall and search use real original entries", () => {
  const { manager: m, ids } = fixture();
  for (let n = 0; n < 4; n++) fold(m, `@${ids[n * 2]}`, `@${ids[n * 2 + 1]}`, `b${n}`, "retained details ".repeat(20));
  const merge = (blocks: string[], id: string, summary: string) => {
    const p = planCompression(view(m), { blocks, summary }, estimateTokens, id);
    apply(m, commitDrafts(view(m), p));
  };
  merge(["b0", "b1"], "b4", "first pair ".repeat(10));
  merge(["b2", "b3"], "b5", "second pair ".repeat(10));
  merge(["b4", "b5"], "b6", "all pairs");
  assert.equal(view(m).blocks.get("b6")!.tier, 3);
  assert.equal(view(m).states.get("b4"), "superseded");
  const one = recall(view(m), "b6", "one", 0, false);
  assert.match(JSON.stringify(one), /first pair/);
  assert.doesNotMatch(JSON.stringify(one), /secret-0/);
  let offset = 0, all = "", pages = 0;
  do {
    const result = recall(view(m), "b6", "full", offset, false);
    all += JSON.stringify(result.content); pages++;
    if (result.details.nextOffset === null) break;
    offset = result.details.nextOffset;
  } while (pages < 100);
  assert.ok(pages > 1); assert.match(all, /secret-0/); assert.match(all, /secret-7/);
  assert.ok(search(view(m), "secret-7", 0).matches.length);
  merge(["b6"], "b7", "all");
  assert.equal(view(m).blocks.get("b7")!.tier, 3);
  assert.equal(view(m).states.get("b6"), "superseded");
});

test("disk resume, fork, native compaction and interrupted writes preserve evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-layers-test-"));
  try {
    const { manager: m, ids } = fixture(SessionManager.create(dir, dir));
    const oldLeaf = m.getLeafId()!;
    const p = fold(m, `@${ids[0]}`, `@${ids[2]}`, "b1");
    const path = m.getSessionFile()!;
    const reopened = SessionManager.open(path);
    assert.equal(view(reopened).states.get("b1"), "active");
    assert.match(JSON.stringify(recall(view(reopened), "b1", "full", 0, false)), /secret-0/);
    m.branch(oldLeaf);
    assert.equal(view(m).blocks.size, 0);
    assert.throws(() => recall(view(m), "b1", "full", 0, false));
    apply(m, commitDrafts(view(m), p).slice(0, 2));
    assert.equal(view(m).states.get("b1"), "partial");
    assert.match(JSON.stringify(recall(view(m), "b1", "full", 0, false)), /secret-0/);
    reopened.appendCompaction("Native checkpoint", ids[10], 5000);
    assert.equal(view(reopened).states.get("b1"), "archived");
    assert.match(JSON.stringify(recall(view(reopened), "b1", "full", 0, false)), /secret-0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stale snapshots and incomplete tool pairs are rejected; images are paged without flattening", () => {
  const { manager: m, ids } = fixture();
  const p = planCompression(view(m), { start: `@${ids[0]}`, end: `@${ids[1]}`, summary: "short" }, estimateTokens, "b1");
  m.appendContextEdit(ids[0], { content: [{ type: "text", text: "changed" }] });
  assert.throws(() => commitDrafts(view(m), p), /changed/);
  const imageId = m.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "cGl4ZWxz" }], timestamp: 10 });
  const header = recall(view(m), `@${imageId}`, "full", 0, true);
  assert.equal(header.details.nextOffset, 1);
  assert.throws(() => recall(view(m), `@${imageId}`, "full", 1, false), /does not support images/);
  assert.equal(recall(view(m), `@${imageId}`, "full", 1, true).content[1].type, "image");
  const broken = SessionManager.inMemory(process.cwd());
  broken.appendMessage({ role: "user", content: "task", timestamp: 1 });
  const brokenId = broken.appendMessage(fauxAssistantMessage([fauxToolCall("read", {}, { id: "no-result" })], { stopReason: "toolUse" }));
  for (let n = 0; n < 6; n++) broken.appendMessage(fauxAssistantMessage("after"));
  assert.equal(view(broken).units.find(u => u.ref === `@${brokenId}`)!.eligible, false);
});

test("real SDK loader: queued tool -> turn boundary -> next request projection, cancellation and opt-out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-layers-sdk-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: [resolve(import.meta.dirname, "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  let session: any;
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const ext = loader.getExtensions().extensions[0];
    assert.equal(ext.tools.size, 3);
    for (const { definition } of ext.tools.values()) assert.equal(definition.exposure, "model-only");
    const { manager: m, ids } = fixture();
    const faux = fauxProvider({ provider: "layers-test", models: [{ id: "test", contextWindow: 30000, maxTokens: 1024 }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const created = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(),
      tools: ["context_status", "context_compress", "context_recall"], resourceLoader: loader, settingsManager: settings, sessionManager: m,
      sessionStartEvent: { type: "session_start", reason: "startup" } });
    session = created.session;
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: (e: unknown) => errors.push(e) });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("context_compress", { start: `@${ids[0]}`, end: `@${ids[2]}`, summary: "files reviewed; preserve exact details via recall" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("context_status", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Compress finished work and inspect the receipt.");
    assert.deepEqual(errors, []);
    assert.equal([...view(m).states.values()].filter(s => s === "active").length, 1);
    const result = session.messages.findLast((x: any) => x.role === "toolResult" && x.toolName === "context_status");
    assert.match(JSON.stringify(result), /applied/);
    const block = [...view(m).blocks.values()][0];
    assert.match(JSON.stringify(recall(view(m), block.id, "full", 0, false)), /secret-0/);

    // Exercise the actual loaded handlers, not a reimplementation of cancellation.
    const ctx = { sessionManager: m, model: faux.getModel(), getContextUsage: () => ({ tokens: 100000, contextWindow: 200000, percent: 50 }), signal: undefined } as any;
    await ext.tools.get("context_compress")!.definition.execute("cancel", { start: `@${ids[4]}`, end: `@${ids[5]}`, summary: "cancelled" }, undefined, undefined, ctx);
    await assert.rejects(() => ext.tools.get("context_compress")!.definition.execute("overlap", { start: `@${ids[4]}`, end: `@${ids[5]}`, summary: "duplicate" }, undefined, undefined, ctx), /already queued/);
    const boundary = await ext.handlers.get("turn_end")![0]({ entries: [], outcome: "aborted" } as any, ctx) as any;
    assert.ok(boundary.entries.every((e: any) => e.type !== "context_edit"));
    assert.match(JSON.stringify(boundary), /not-applied/);
    const initial = status(view(m), estimateTokens);
    assert.ok(initial.items.length > 0);
    const branchLength = m.getBranch().length;
    const nudgeHandler = ext.handlers.get("context")![0];
    const reminder = await nudgeHandler({ messages: session.messages } as any, ctx) as any;
    assert.match(reminder.messages.at(-1).content, /Context is approximately/);
    assert.equal(m.getBranch().length, branchLength, "reminder must not persist business content");
    assert.equal(await nudgeHandler({ messages: session.messages } as any, ctx), undefined, "unchanged pressure must not repeat reminders");
    await ext.tools.get("context_compress")!.definition.execute("reset-growth", { start: `@${ids[4]}`, end: `@${ids[5]}`, summary: "new interval" }, undefined, undefined, ctx);
    const committed = await ext.handlers.get("turn_end")![0]({ entries: [], outcome: "completed" } as any, ctx) as any;
    apply(m, committed.entries);
    const smaller = { ...ctx, getContextUsage: () => ({ tokens: 80000, contextWindow: 200000, percent: 40 }) };
    assert.ok(await nudgeHandler({ messages: session.messages } as any, smaller), "successful folding must reset the old high-water mark");
    session.setActiveToolsByName(["context_status"]);
    assert.equal(await nudgeHandler({ messages: session.messages } as any, { ...ctx, getContextUsage: () => ({ tokens: 180000, contextWindow: 200000, percent: 90 }) }), undefined, "explicit exclusions must win");
    process.env.ROTOM_CONTEXT_LAYERS = "0";
    await loader.reload();
    assert.equal(loader.getExtensions().extensions[0].tools.size, 0);
  } finally { delete process.env.ROTOM_CONTEXT_LAYERS; session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("every interrupted commit prefix retains originals and never claims a completed fold", () => {
  for (let cut = 1; cut <= 6; cut++) {
    const { manager: m, ids } = fixture();
    const plan = planCompression(view(m), { start: `@${ids[0]}`, end: `@${ids[2]}`, summary: "retained provenance" }, estimateTokens, "partial");
    const drafts = commitDrafts(view(m), plan);
    apply(m, drafts.slice(0, cut));
    assert.equal(view(m).states.get("partial"), "partial");
    assert.match(JSON.stringify(recall(view(m), "partial", "full", 0, false)), /secret-0/);
    assert.ok(m.getBranch().some(e => e.type === "message" && e.id === ids[0]));
  }
});

test("recall pages preserve Unicode, tool error evidence and images without exposing reasoning signatures", () => {
  const m = SessionManager.inMemory(process.cwd());
  const body = "a".repeat(11999) + "😀" + "b".repeat(12001);
  const id = m.appendMessage({ role: "user", content: body, timestamp: 1 });
  const textParts: string[] = [];
  let offset = 0;
  for (;;) {
    const page = recall(view(m), `@${id}`, "full", offset, false);
    for (const part of page.content.slice(1)) if (part.type === "text" && !part.text.startsWith("[Historical entry")) {
      assert.equal(part.text.isWellFormed(), true);
      textParts.push(part.text);
    }
    if (page.details.nextOffset === null) break;
    offset = page.details.nextOffset;
  }
  assert.equal(textParts.join(""), body);
  const privateId = m.appendMessage(fauxAssistantMessage([{ type: "thinking", thinking: "private-thought", thinkingSignature: "private-signature" }, { type: "text", text: "public-evidence" }]));
  const result = JSON.stringify(recall(view(m), `@${privateId}`, "full", 0, false));
  assert.match(result, /public-evidence/); assert.doesNotMatch(result, /private-thought|private-signature/);
  const errorId = m.appendMessage({ role: "toolResult", toolCallId: "failure", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }], timestamp: 1 });
  assert.match(JSON.stringify(recall(view(m), `@${errorId}`, "full", 0, false)), /isError/);
});

test("non-contiguous/mixed-tier blocks, duplicate selectors and history foreign edits fail closed", () => {
  const { manager: m, ids } = fixture();
  fold(m, `@${ids[0]}`, `@${ids[1]}`, "a", "details ".repeat(20));
  fold(m, `@${ids[4]}`, `@${ids[5]}`, "b", "details ".repeat(20));
  for (const blocks of [["a", "a"], ["a", "b"], ["missing"]]) assert.throws(() => planCompression(view(m), { blocks, summary: "short" }, estimateTokens, "bad"));
  assert.throws(() => planCompression(view(m), { start: `@${ids[2]}`, end: `@${ids[3]}`, blocks: ["a"], summary: "short" }, estimateTokens, "bad"));
  m.appendContextEdit(ids[2], { content: [{ type: "text", text: "foreign policy" }] });
  assert.throws(() => fold(m, `@${ids[2]}`, `@${ids[3]}`, "bad"));
});
