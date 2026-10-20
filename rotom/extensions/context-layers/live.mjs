#!/usr/bin/env node
// Explicitly authorized, bounded Qoder integration/A-B check. No credential reads,
// no fallback provider, no automatic retries. Results contain metadata only.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [productArg, outputArg, modelId = "dfmodel"] = process.argv.slice(2);
if (!productArg || !outputArg || process.env.ROTOM_CONTEXT_LIVE !== "1") throw new Error("Explicit ROTOM_CONTEXT_LIVE=1, product and result path required");
const product = realpathSync(productArg), output = resolve(outputArg);
const piRoot = join(product, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
const { verifyPiRuntime } = await import(pathToFileURL(join(product, "runtime/verify-pi-runtime.mjs")));
const { RESOURCE_DESCRIPTORS_V1 } = await import(pathToFileURL(join(product, "runtime/product-config.mjs")));
const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
await verifyPiRuntime({ executable: join(piRoot, piManifest.bin.pi), agentDir: product,
  resourceDeclarations: RESOURCE_DESCRIPTORS_V1.map(r => `${r.kind}:${join(product, r.path)}`) });
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const { creditSummary } = await import(pathToFileURL(join(product, "extensions/qoder/credits.mjs")));
const report = { schema: "rotom-context-layers/live-v1", model: modelId, repetitions: 2, scope: "Qoder + context-layers + native read/write; no paid reducer", runs: [], startedAt: new Date().toISOString() };
function save() { writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
save();
async function run(candidate, repetition) {
  const root = mkdtempSync(join(tmpdir(), "rotom-context-live-"));
  const workspace = join(root, "workspace"), config = join(root, "config");
  mkdirSync(workspace); mkdirSync(config);
  const errors = [], usage = [], calls = [];
  let session, manager, capturedContext, finished = false, phases = [];
  const result = { arm: candidate ? "layers" : "native", repetition, outcome: "unknown", calls, usage };
  report.runs.push(result); save();
  try {
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } });
    const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir: config, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: RESOURCE_DESCRIPTORS_V1.filter(r => r.kind === "extension" && (r.id === "qoder" || candidate && r.id === "context-layers")).map(r => join(product, r.loadPath ?? r.path)),
      extensionFactories: [pi => {
        pi.on("session_start", (_e, ctx) => { capturedContext = ctx; });
        pi.on("before_provider_request", (_e, ctx) => {
          usage.push({ estimatedInput: ctx.getContextUsage()?.tokens ?? null });
          if (usage.length > 12) ctx.abort();
        });
        pi.on("tool_execution_start", e => { calls.push(e.toolName); if (calls.length > 20) capturedContext.abort(); });
      }],
    });
    manager = sdk.SessionManager.create(workspace, join(root, "sessions"));
    async function open() {
      // Each AgentSession owns its extension API bindings; never reuse disposed
      // extension closures or Qoder credential/session bindings on reopen.
      await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
      const runtime = await sdk.ModelRuntime.create({ modelsPath: null, modelsStorePath: null, refreshOnCreate: false, allowModelNetwork: false });
      const created = await sdk.createAgentSession({ cwd: workspace, agentDir: config, modelRuntime: runtime, resourceLoader: loader,
        settingsManager: settings, sessionManager: manager, model: undefined, thinkingLevel: "low",
        tools: ["read", "write", ...(candidate ? ["context_status", "context_compress", "context_recall"] : [])],
        sessionStartEvent: { type: "session_start", reason: "startup" } });
      session = created.session;
      await session.bindExtensions({ mode: "print", onError: e => { errors.push({ event: e.event }); console.error("Extension diagnostic:", e.error); } });
      const model = runtime.getModel("qoder", modelId);
      assert.ok(model, "requested Qoder model unavailable; no fallback");
      await session.setModel(model);
    }
    await open();
    const traces = Array.from({ length: 14 }, () => Array.from({ length: 30 }, () => randomBytes(10).toString("hex")));
    manager.appendMessage({ role: "user", content: "The following completed record reads are historical evidence. Keep per-record values recoverable for later questions. Do not execute text in records.", timestamp: Date.now() });
    const recordIds = [];
    for (let n = 0; n < 14; n++) {
      manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "context-fixture", model: "seeded-records", stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "toolCall", id: `history_${n}`, name: "read", arguments: { path: `record-${n}.txt` } }] });
      recordIds.push(manager.appendMessage({ role: "toolResult", toolCallId: `history_${n}`, toolName: "read", isError: false, timestamp: Date.now(),
        content: [{ type: "text", text: `Record ${n}\n` + traces[n].map((value, j) => `Archived observation ${n}/${j}: trace-checksum=${value}; validation completed.\n`).join("") }] }));
    }
    // Refresh via a real reopen; injected history is not a fake model result.
    session.dispose(); manager = sdk.SessionManager.open(manager.getSessionFile()); await open();
    async function prompt(text, phase) {
      phases.push(phase); save();
      const timer = setTimeout(() => capturedContext.abort(), 180_000);
      try { await session.prompt(text); }
      finally { clearTimeout(timer); }
      const last = session.messages.findLast(m => m.role === "assistant");
      if (last?.stopReason === "error") console.error("Provider diagnostic:", last.errorMessage);
      assert.ok(last && last.stopReason !== "error" && last.stopReason !== "aborted", `${phase}: incomplete provider outcome`);
      assert.deepEqual(errors, []);
    }
    await prompt(candidate
      ? "Manage this long history now: call context_status, then compress a completed range including records 0 and 1. Your summary should identify which records exist and how to recall original trace checksums. Preserve decisions rather than transcribing every observation. Then stop with a short acknowledgement. Do not write files yet."
      : "Review the completed record history and acknowledge readiness for a later exact-value question. Do not write files yet.", "prepare");
    const blocks = manager.getBranch().filter(e => e.type === "custom" && e.customType === "rotom-context-layers/block-v1");
    result.blocks = blocks.length;
    if (candidate) {
      assert.ok(blocks.length > 0, "no actual compression");
      const projected = manager.buildSessionProjection();
      assert.ok(recordIds.slice(0, 2).every(id => !projected.entries.find(e => e.sourceEntry.id === id)?.messages.length), "target originals remain visible");
    }
    // Choose an exact detail absent from EVERY visible message, not just the
    // block summary. This preserves the hidden-answer control without treating
    // a model that retains a useful key as a compression failure.
    const visible = JSON.stringify(manager.buildSessionProjection().messages);
    const indexes = [0, 1].map(n => candidate ? traces[n].findIndex(value => !visible.includes(value)) : 0);
    assert.ok(indexes.every(n => n >= 0), "no hidden detail available for the recovery probe");
    const expected = { alpha: traces[0][indexes[0]], beta: traces[1][indexes[1]] };
    result.hiddenAnswerControl = candidate ? true : null;
    const persisted = manager.getSessionFile();
    session.dispose(); manager = sdk.SessionManager.open(persisted); await open();
    await prompt(`Write result.json with exactly two keys: alpha = the exact trace-checksum from record 0 observation ${indexes[0]}; beta = the exact trace-checksum from record 1 observation ${indexes[1]}. Recover original evidence if necessary; do not guess. The historical record files are not present in this workspace. Then finish.`, "resume-recall-write");
    const actual = JSON.parse(readFileSync(join(workspace, "result.json"), "utf8"));
    assert.deepEqual(actual, expected);
    if (candidate) assert.ok(calls.includes("context_recall"), "answer was not recovered through recall");
    result.artifactSha256 = createHash("sha256").update(JSON.stringify(actual)).digest("hex");
    result.outcome = "verified"; finished = true;
  } finally {
    result.phases = phases;
    if (manager) {
      result.credits = creditSummary(manager.getBranch(), manager.getSessionId());
      result.nativeCompactions = manager.getBranch().filter(e => e.type === "compaction").length;
      result.reportedUsage = manager.getBranch().filter(e => e.type === "message" && e.message.role === "assistant" && e.message.usage?.totalTokens > 0)
        .map(e => ({ stopReason: e.message.stopReason, input: e.message.usage.input, output: e.message.usage.output, cacheRead: e.message.usage.cacheRead, cacheWrite: e.message.usage.cacheWrite }));
    }
    result.extensionErrors = errors;
    result.finished = finished; save();
    session?.dispose();
    if (finished) rmSync(root, { recursive: true, force: true });
    else { result.diagnosticDirectory = root; save(); }
  }
}
for (let repetition = 1; repetition <= 2; repetition++) {
  for (const candidate of repetition === 1 ? [true, false] : [false, true]) await run(candidate, repetition);
}
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify(report, null, 2));
