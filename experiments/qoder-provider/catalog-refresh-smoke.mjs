// Real AgentSession/ModelRegistry with synthetic credentials and upstream only.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import { MODEL } from '../../rotom/extensions/qoder/provider.mjs';
import { installQoderExtension } from '../../rotom/extensions/qoder/session-policy.mjs';
import { CATALOG_TTL_MS } from '../../rotom/extensions/qoder/catalog.mjs';
import { CATALOG_URL } from '../../rotom/extensions/qoder/catalog-auth.mjs';
import { CHAT_URL } from '../../rotom/extensions/qoder/transport.mjs';

assert.equal(process.argv.length, 2, 'offline-only smoke takes no arguments');
const entry = process.env.ROTOM_PI;
assert(entry && isAbsolute(entry) && (await lstat(entry)).isFile() && await realpath(entry) === entry);
assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const sdk = await import(import.meta.resolve('@earendil-works/pi-coding-agent', parent));
const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-catalog-refresh-')));
const summary = { mode: 'offline', checks: [], pass: false };
let session;
mock.timers.enable({ apis: ['Date'], now: Date.now() });
const expire = () => mock.timers.tick(CATALOG_TTL_MS + 1);
try {
  for (const authMode of ['browser', 'qodercli']) {
    const machineId = randomUUID(), uid = 'fixture', org = '';
    const fingerprint = createHmac('sha256', machineId).update(JSON.stringify(['rotom-qoder-browser-v1', uid, org])).digest('hex');
    const credential = { type: 'oauth', qoderAuthVersion: 1, access: 'fixture', refresh: 'fixture-refresh', expires: Date.now() + 86400000, refreshExpires: Date.now() + 172800000, machineId, uid, org, fingerprint };
    const credentials = new piAI.InMemoryCredentialStore();
    if (authMode === 'browser') await credentials.modify('qoder-experimental', async () => credential);
    const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new piAI.InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
    // Leave native retry enabled: catalog errors must not be treated as retryable.
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 } });
    let catalogReads = 0, dispatches = 0, toolExecutions = 0, failCatalog = false;
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Synthetic protocol test.',
      extensionFactories: [async pi => { await installQoderExtension(pi, { piAI, authMode,
        getCredential: async () => ({ accessToken: 'fixture', fingerprint, machineId, uid, org }),
        fetchImpl: async (url, init) => {
          if (url === CATALOG_URL) {
            catalogReads++;
            if (failCatalog) return new Response('PRIVATE fixture', { status: 503 });
            return new Response(JSON.stringify({ assistant: [{ key: 'auto', display_name: 'Fixture', source: 'system', enable: true, format: 'openai', max_input_tokens: 32000 }] }));
          }
          assert.equal(url, CHAT_URL); dispatches++;
          assert(dispatches <= 6);
          const payload = JSON.parse(init.body); assert.equal(payload.model, 'auto');
          const delta = dispatches === 1 ? { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'expire_catalog', arguments: '{}' } }] } : { content: 'OK' };
          const chunk = { choices: [{ index: 0, delta, finish_reason: dispatches === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        },
      }); }],
    });
    const tool = { name: 'expire_catalog', label: 'Expire fixture catalog', description: 'Synthetic clock advancement only.', parameters: piAI.Type.Object({}),
      async execute() { toolExecutions++; expire(); return { content: [{ type: 'text', text: 'OK' }], details: {} }; },
    };
    await resourceLoader.reload();
    assert.equal(resourceLoader.getExtensions().errors.length, 0);
    ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: { ...MODEL, id: 'auto' }, thinkingLevel: 'off',
      tools: [tool.name], customTools: [tool], settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(dir),
    }));
    const last = () => session.messages.filter(m => m.role === 'assistant').at(-1);
    await session.prompt('Run the synthetic tool once, then answer OK.');
    assert.equal(last().stopReason, 'stop'); assert.equal(toolExecutions, 1);
    assert.equal(catalogReads, 2); assert.equal(dispatches, 2);
    summary.checks.push(`${authMode}: native tool continuation refresh`);
    expire();
    await session.prompt('Synthetic padding. ' + 'padding '.repeat(80));
    assert.equal(last().stopReason, 'stop'); assert.equal(catalogReads, 3); assert.equal(dispatches, 3);
    summary.checks.push(`${authMode}: next user prompt refresh`);
    expire();
    const compacted = await session.compact('Reply OK.');
    assert.equal(compacted.summary, 'OK'); assert.equal(catalogReads, 4); assert.equal(dispatches, 4);
    summary.checks.push(`${authMode}: native compaction refresh`);
    expire(); failCatalog = true;
    await session.prompt('This request must not reach inference.');
    assert.equal(last().stopReason, 'error'); assert.match(last().errorMessage, /catalog_refresh_failed/);
    assert.equal(catalogReads, 5); assert.equal(dispatches, 4);
    summary.checks.push(`${authMode}: refresh failure stops without native retry`);
    failCatalog = false;
    await session.prompt('/qoder-models');
    await session.prompt('OK');
    assert.equal(last().stopReason, 'stop'); assert.equal(catalogReads, 6); assert.equal(dispatches, 5);
    assert.equal(session.model.id, 'auto'); assert.equal(session.thinkingLevel, 'off');
    summary.checks.push(`${authMode}: manual refresh recovery preserves selection`);
    session.dispose(); session = undefined;
  }
  summary.pass = true;
} catch (error) {
  summary.errorLocation = error?.stack?.match(/catalog-refresh-smoke\.mjs:(\d+):\d+/)?.[1] ?? 'unknown';
  summary.errorCode = error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : error?.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'sdk_error';
  process.exitCode = 1;
} finally {
  session?.dispose(); mock.timers.reset(); await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 2));
