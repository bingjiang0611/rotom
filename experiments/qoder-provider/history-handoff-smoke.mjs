// Offline: real SDK model switching, tool loop and disk resume; no live credentials.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installQoderExtension } from '../../rotom/extensions/qoder/session-policy.mjs';
import { CATALOG_URL } from '../../rotom/extensions/qoder/catalog-auth.mjs';
import { LEGACY_URL } from '../../rotom/extensions/qoder/legacy.mjs';
import { decodeProbeBody } from './probe-wire.mjs';

assert.equal(process.argv.length, 2, 'offline only');
const entry = process.env.ROTOM_PI;
assert(entry && isAbsolute(entry) && (await lstat(entry)).isFile() && await realpath(entry) === entry);
assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const sdk = await import(import.meta.resolve('@earendil-works/pi-coding-agent', parent));
const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-handoff-')));
const summary = { mode: 'offline', pass: false, dispatches: 0, toolExecutions: 0, checks: [] };
let session, provider;
const item = { id: 'own-reasoning', encrypted_content: 'own-ciphertext', target_hash: 'a'.repeat(64) };
try {
  const runtime = await sdk.ModelRuntime.create({ credentials: new piAI.InMemoryCredentialStore(), modelsPath: null, modelsStore: new piAI.InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const faux = piAI.fauxProvider({ provider: 'handoff-fixture', models: [{ id: 'source', contextWindow: 32000, maxTokens: 4096 }] });
  runtime.registerNativeProvider(faux.provider);
  const source = faux.getModel();
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic handoff test.',
    extensionFactories: [async pi => { provider = await installQoderExtension(pi, { piAI, authMode: 'qodercli',
      getCredential: async () => ({ accessToken: 'fixture', uid: 'fixture', org: '', machineId: 'fixture-machine', fingerprint: 'a'.repeat(64) }),
      fetchImpl: async (url, init) => {
        if (url === CATALOG_URL) return Response.json({ assistant: [{ key: 'ultimate', display_name: 'Ultimate', source: 'system', enable: true, format: 'openai', max_input_tokens: 400000, is_vl: true, context_config: { '400K': { token_count: 400000 } }, is_reasoning: true, thinking_config: { enabled: { efforts: { high: { is_default: true } } } } }] });
        assert.equal(url, LEGACY_URL); assert(++summary.dispatches <= 3);
        const wire = decodeProbeBody(init.body);
        assert.equal(wire.parameters.reasoning_effort, 'high');
        assert.doesNotMatch(JSON.stringify(wire), /FOREIGN_OPAQUE|FOREIGN_TOOL|FOREIGN_REDACTED/);
        const foreign = wire.messages.find(m => m.role === 'assistant' && m.tool_calls?.some(t => t.id === 'foreign-call'));
        assert(foreign); assert(foreign.content.includes('Visible previous answer'));
        assert.equal(foreign.reasoning_item, undefined);
        assert.equal(wire.messages.find(m => m.role === 'tool' && m.tool_call_id === 'foreign-call')?.content, 'Previous result');
        if (summary.dispatches > 1) {
          const own = wire.messages.find(m => m.role === 'assistant' && m.tool_calls?.some(t => t.id === 'own-call'));
          assert.deepEqual(own.reasoning_item, item);
          assert.equal(wire.messages.find(m => m.role === 'tool' && m.tool_call_id === 'own-call')?.content, 'Current result');
        }
        const delta = summary.dispatches === 1 ? { reasoning_item: item, tool_calls: [{ index: 0, id: 'own-call', type: 'function', function: { name: 'handoff_probe', arguments: '{}' } }] } : { content: 'OK' };
        const chunk = { choices: [{ index: 0, delta, finish_reason: summary.dispatches === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
        return new Response(`data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      },
    }); }],
  });
  const tool = { name: 'handoff_probe', label: 'Handoff probe', description: 'Synthetic result only.', parameters: piAI.Type.Object({}),
    async execute() { assert.equal(++summary.toolExecutions, 1); return { content: [{ type: 'text', text: 'Current result' }], details: {} }; },
  };
  const manager = sdk.SessionManager.create(dir, dir);
  const foreign = { role: 'assistant', provider: source.provider, model: source.id, api: source.api, stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'thinking', thinking: '', thinkingSignature: 'FOREIGN_OPAQUE' }, { type: 'thinking', thinking: 'FOREIGN_REDACTED', redacted: true, thinkingSignature: 'FOREIGN_OPAQUE' },
      { type: 'text', text: 'Visible previous answer' }, { type: 'toolCall', id: 'foreign-call', name: tool.name, arguments: {}, thoughtSignature: 'FOREIGN_TOOL' }],
  };
  manager.appendModelChange(source.provider, source.id);
  manager.appendMessage({ role: 'user', content: 'Previous task', timestamp: Date.now() });
  manager.appendMessage(foreign);
  manager.appendMessage({ role: 'toolResult', toolCallId: 'foreign-call', toolName: tool.name, content: [{ type: 'text', text: 'Previous result' }], isError: false, timestamp: Date.now() });
  const original = JSON.stringify(foreign);
  const open = async (manager, model) => {
    await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0);
    const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, tools: [tool.name], customTools: [tool], settingsManager: settings, resourceLoader: loader, sessionManager: manager });
    await session.bindExtensions({ mode: 'rpc', uiContext: { notify() {}, setStatus() {} } });
    return session;
  };
  session = await open(manager, source);
  await session.setModel(provider.getModels().find(m => m.id === 'ultimate'));
  session.setThinkingLevel('high');
  await session.prompt('Continue with the current tool then answer OK.');
  assert.equal(session.messages.filter(m => m.role === 'assistant').at(-1).stopReason, 'stop');
  assert.equal(summary.dispatches, 2); assert.equal(summary.toolExecutions, 1);
  const unchanged = manager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant' && e.message.provider === source.provider).message;
  assert.equal(JSON.stringify(unchanged), original);
  summary.checks.push('native switch to Ultimate high', 'foreign signatures absent on COSY wire', 'own opaque signature and tool pairing preserved', 'source history unchanged');
  const file = manager.getSessionFile(); assert(file);
  assert((await readFile(file, 'utf8')).includes('FOREIGN_TOOL'));
  session.dispose(); session = await open(sdk.SessionManager.open(file, dir));
  assert.equal(session.model.id, 'ultimate'); assert.equal(session.thinkingLevel, 'high');
  await session.prompt('Reply OK without calling a tool.');
  assert.equal(session.messages.filter(m => m.role === 'assistant').at(-1).stopReason, 'stop');
  assert.equal(summary.dispatches, 3); assert.equal(summary.toolExecutions, 1);
  summary.checks.push('disk resume retains source signatures and replays compatible history'); summary.pass = true;
} catch (error) {
  summary.assistantErrorCode = session?.messages.filter(m => m.role === 'assistant').at(-1)?.errorMessage?.match(/Qoder: ([a-z0-9_]+)/)?.[1];
  summary.errorLocation = error?.stack?.match(/history-handoff-smoke\.mjs:(\d+):\d+/)?.[1] ?? 'unknown';
  summary.errorCode = error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : error?.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'sdk_error';
  process.exitCode = 1;
} finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(summary, null, 2));
