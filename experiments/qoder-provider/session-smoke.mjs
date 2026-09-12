import assert from 'node:assert/strict';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MODEL } from '../../rotom/extensions/qoder/provider.mjs';
import { BINDING_TYPE, installQoderExtension } from '../../rotom/extensions/qoder/session-policy.mjs';

// Public SDK only; synthetic cwd, no discovered instructions, tools or credentials.
const entry = process.env.ROTOM_PI;
if (!entry || !isAbsolute(entry) || !(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('Set canonical ROTOM_PI');
if (!process.execArgv.includes('--experimental-import-meta-resolve')) throw new Error('Use --experimental-import-meta-resolve');
if (process.argv.slice(2).some(arg => !['--live', '--extended'].includes(arg))) throw new Error('Only --live and --extended are supported');
const extended = process.argv.includes('--extended');
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const openAI = await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions', parent));
const sdk = await import(import.meta.resolve('@earendil-works/pi-coding-agent', parent));
const live = process.argv.includes('--live');
const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-session-')));
const marker = `HOST_RESULT_${randomUUID()}`, nonce = randomUUID(), abandoned = `ABANDONED_${randomUUID()}`;
const summary = { mode: live ? 'live' : 'offline', checks: {}, rounds: [], diagnostics: [], requests: 0, toolExecutions: 0, usage: { input: 0, output: 0, cacheRead: 0 }, cost: 'unknown' };
let phase = 'tool', session, inspectNext, fixtureFingerprint = 'a'.repeat(64);
const usage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const finish = frame(chunk({}, 'stop')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n';
const fetchImpl = async (url, init) => {
  assert.ok(++summary.requests <= (extended ? (live ? 12 : 14) : (live ? 6 : 10)), 'request budget');
  const payload = JSON.parse(init.body);
  if (!live) assert.ok(!init.body.includes('a'.repeat(64)) && !init.body.includes(BINDING_TYPE));
  assert.ok(payload.max_tokens <= 4096);
  if (inspectNext) { inspectNext(payload); inspectNext = undefined; }
  if (live) return globalThis.fetch(url, init); // Never retry a real dispatch.
  let delta = { content: phase === 'abandoned' ? 'OK' : marker };
  if (phase === 'tool' || phase === 'truncated') {
    if (!payload.messages.some(m => m.role === 'tool')) {
      delta = { tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: 'rotom_probe_echo', arguments: JSON.stringify({ nonce }) } }] };
    } else assert.ok(payload.messages.some(m => m.role === 'tool' && m.content === marker));
  }
  if (phase === 'abort') return new Response(new ReadableStream({ start(out) { out.enqueue(new TextEncoder().encode(frame(chunk({ content: 'begin' })))); } }), { headers: { 'content-type': 'text/event-stream' } });
  return new Response(frame(chunk(delta)) + (phase === 'truncated' ? '' : finish), { headers: { 'content-type': 'text/event-stream' } });
};
let provider;
const providerOptions = { piAI, openAI, fetchImpl, onDiagnostic: data => { if (summary.diagnostics.length < 12) summary.diagnostics.push({ phase, ...data }); }, ...live ? {} : { getCredential: async () => ({ accessToken: 'fixture', fingerprint: fixtureFingerprint }) } };
const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 } });
const modelRuntime = await sdk.ModelRuntime.create({ credentials: new piAI.InMemoryCredentialStore(), modelsPath: null, modelsStore: new piAI.InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: 'You are a synthetic protocol test assistant. Follow the user exactly. No filesystem or shell tools are available.',
  extensionFactories: [async pi => { provider = await installQoderExtension(pi, providerOptions); }],
});
const tool = {
  name: 'rotom_probe_echo', label: 'Synthetic echo', description: 'Pure test function returning a host-only marker. No side effects.',
  parameters: piAI.Type.Object({ nonce: piAI.Type.String() }, { additionalProperties: false }),
  async execute(_id, args) {
    assert.deepEqual(args, { nonce }); assert.equal(++summary.toolExecutions, 1);
    return { content: [{ type: 'text', text: marker }], details: {} };
  },
};
async function openSession(manager) {
  // A disposed SDK session's ExtensionAPI is stale. Recreate extension instances
  // just as Pi does on /resume, rather than reusing their session-bound closures.
  await resourceLoader.reload();
  const result = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: MODEL, thinkingLevel: 'off',
    tools: [tool.name], customTools: [tool], settingsManager, resourceLoader, sessionManager: manager,
  });
  assert.deepEqual(result.session.getActiveToolNames(), ['rotom_probe_echo']);
  result.session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      summary.rounds.push({ phase, inputTokens: event.message.usage.input + event.message.usage.cacheRead, stopReason: event.message.stopReason, ...(event.message.errorMessage ? { errorCode: event.message.errorMessage.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'native_stream_error' } : {}) });
      for (const key of Object.keys(summary.usage)) summary.usage[key] += event.message.usage[key];
    }
  });
  return result.session;
}
function last() { return session.messages.filter(m => m.role === 'assistant').at(-1); }
function checkAnswer() {
  assert.equal(last().stopReason, 'stop');
  assert.equal(last().content.filter(c => c.type === 'text').map(c => c.text).join('').trim(), marker);
}
try {
  await resourceLoader.reload();
  assert.equal(resourceLoader.getExtensions().errors.length, 0);
  assert.equal(resourceLoader.getAgentsFiles().agentsFiles.length, 0);
  const manager = sdk.SessionManager.create(dir, dir);
  session = await openSession(manager);
  await session.prompt(`Call rotom_probe_echo exactly once with nonce ${nonce}. After the tool result reply with exactly its text. Do not call again.`);
  checkAnswer(); assert.equal(summary.toolExecutions, 1);
  assert.ok(session.messages.some(m => m.role === 'assistant' && m.stopReason === 'toolUse'));
  summary.checks.nativeToolLoop = 'pass';
  assert.equal(manager.getEntries().filter(e => e.type === 'custom' && e.customType === BINDING_TYPE).length, 1);
  assert.ok(!JSON.stringify(session.messages).includes(BINDING_TYPE));
  summary.checks.accountBinding = 'pass';
  const base = manager.getLeafId(), file = session.sessionFile;
  assert.ok(file);
  if (!live || extended) {
    phase = 'abandoned';
    await session.prompt(`Remember temporary branch marker ${abandoned}. Reply only OK; do not call a tool.`);
    assert.equal(last().stopReason, 'stop');
    const navigation = await session.navigateTree(base, { summarize: false });
    assert.equal(navigation.cancelled, false);
    assert.ok(!JSON.stringify(session.messages).includes(abandoned));
    phase = 'recall';
    inspectNext = payload => { assert.ok(!JSON.stringify(payload.messages).includes(abandoned)); assert.ok(JSON.stringify(payload.messages).includes(marker)); };
    await session.prompt('Reply with exactly the prior HOST_RESULT marker from the tool result. Do not call any tool.');
    checkAnswer(); summary.checks.branchIsolation = 'pass';
  }
  session.dispose();
  session = await openSession(sdk.SessionManager.open(file, dir));
  assert.ok(!JSON.stringify(session.messages).includes(abandoned));
  assert.ok(JSON.stringify(session.messages).includes(marker));
  summary.checks.diskResume = 'pass';
  assert.equal(session.sessionManager.getEntries().filter(e => e.type === 'custom' && e.customType === BINDING_TYPE).length, 1);
  // Synthetic persisted padding makes the cut point deterministic; this is not
  // evidence of a long conversation or measured context-window capacity.
  const resumed = session.sessionManager;
  resumed.appendMessage({ role: 'user', content: 'Synthetic compaction padding. ' + 'padding '.repeat(80), timestamp: Date.now() });
  session.dispose(); session = await openSession(sdk.SessionManager.open(file, dir));
  phase = 'compact';
  const compaction = await session.compact('Preserve the exact HOST_RESULT marker from the tool result and state that no further tool invocation is needed.');
  assert.ok(compaction.summary.includes(marker));
  for (const key of Object.keys(summary.usage)) summary.usage[key] += compaction.usage?.[key] ?? 0;
  assert.ok(session.messages.some(m => m.role === 'compactionSummary'));
  phase = 'recall';
  await session.prompt('Reply with exactly the prior HOST_RESULT marker preserved in the summary. Do not call any tool.');
  checkAnswer(); summary.checks.manualCompactionReplay = 'pass';

  phase = 'abort';
  const controller = new AbortController(); let deltas = 0;
  const stream = provider.streamSimple(MODEL, { messages: [{ role: 'user', content: 'Write integers from 1 to 10000, one per line. Do not stop early.', timestamp: Date.now() }] }, { maxTokens: 256, signal: controller.signal });
  for await (const event of stream) if (event.type === 'text_delta') { deltas++; controller.abort(); }
  const aborted = await stream.result();
  assert.ok(deltas > 0); assert.equal(aborted.stopReason, 'aborted');
  summary.checks.midstreamAbort = 'pass';
  phase = 'recall';
  await session.prompt('Reply with exactly the prior HOST_RESULT marker. Do not call any tool.');
  checkAnswer(); summary.checks.requestAfterAbort = 'pass';

  if (extended) {
    phase = 'long-context';
    const before = session.sessionManager.getEntries().filter(e => e.type === 'compaction').length;
    // Exercise Pi's real threshold path with a lowered reserve, not overflow
    // recovery or an assertion that the service supports its advertised maximum.
    settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 64 } });
    const padding = Array.from({ length: 1500 }, (_, i) => `Record ${String(i).padStart(5, '0')}: synthetic filler value ${i}.`).join('\n');
    await session.prompt(`Ignore these synthetic records; preserve the previous HOST_RESULT marker for future recall.\n${padding}\nReply with exactly the prior HOST_RESULT marker, no tool calls.`);
    checkAnswer();
    if (live) assert.ok(summary.rounds.at(-1).inputTokens >= 10000);
    // Offline fixtures deliberately report tiny usage; use a deterministic
    // threshold to exercise the same SDK mechanism without spoofing real usage.
    if (!live) {
      settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 31980, keepRecentTokens: 16 } });
      await session.prompt('Preserve and repeat the previous HOST_RESULT marker.');
    }
    assert.ok(session.sessionManager.getEntries().filter(e => e.type === 'compaction').length > before);
    settingsManager.applyOverrides({ compaction: { enabled: false } });
    phase = 'recall';
    await session.prompt('Reply with exactly the prior HOST_RESULT marker retained by auto-compaction, no tools.');
    checkAnswer(); summary.checks.longContextAutoCompactionReplay = 'pass';
  }

  if (!live) {
    session.dispose(); phase = 'cross-provider';
    const foreign = sdk.SessionManager.inMemory(dir);
    foreign.appendMessage({ role: 'user', content: 'Get a synthetic host marker.', timestamp: Date.now() });
    foreign.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'synthetic-other-provider', model: 'synthetic-other-model',
      content: [{ type: 'toolCall', id: 'foreign|call:1', name: tool.name, arguments: { nonce } }], stopReason: 'toolUse', timestamp: Date.now(),
      usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    foreign.appendMessage({ role: 'toolResult', toolCallId: 'foreign|call:1', toolName: tool.name, content: [{ type: 'text', text: marker }], isError: false, timestamp: Date.now() });
    session = await openSession(foreign);
    inspectNext = payload => {
      const call = payload.messages.find(m => m.role === 'assistant' && m.tool_calls)?.tool_calls[0];
      const result = payload.messages.find(m => m.role === 'tool');
      assert.ok(call?.id); assert.equal(call.id, result?.tool_call_id);
    };
    await session.prompt('Reply with exactly the prior HOST_RESULT marker from the tool result. Do not call any tool.');
    checkAnswer(); assert.equal(summary.toolExecutions, 1);
    summary.checks.syntheticCrossProviderToolReplay = 'pass';

    session.dispose(); phase = 'changed-account';
    fixtureFingerprint = 'b'.repeat(64);
    session = await openSession(sdk.SessionManager.open(file, dir));
    const beforeBlocked = summary.requests;
    await session.prompt('Synthetic ownership test: this prompt must not be dispatched.');
    assert.equal(last().stopReason, 'error');
    assert.match(last().errorMessage, /Qoder: account_changed_start_new_session/);
    assert.equal(summary.requests, beforeBlocked);
    summary.checks.resumedAccountSwitchBlocked = 'pass';
    fixtureFingerprint = 'a'.repeat(64);

    session.dispose(); phase = 'truncated';
    session = await openSession(sdk.SessionManager.inMemory(dir));
    await session.prompt(`Call rotom_probe_echo with nonce ${nonce}.`);
    assert.equal(last().stopReason, 'error');
    assert.equal(summary.toolExecutions, 1);
    summary.checks.truncatedToolNeverExecuted = 'pass';
  }
  summary.pass = true;
} catch (error) {
  summary.pass = false; summary.failedPhase = phase;
  summary.errorLocation = error?.stack?.match(/session-smoke\.mjs:(\d+):\d+/)?.[1] ?? 'unknown';
  summary.errorCode = error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : error?.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'sdk_error';
  // No raw SDK/provider errors: they can contain prompt or network data.
  process.exitCode = 1;
} finally {
  session?.dispose(); await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 2));
