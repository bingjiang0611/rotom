import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { installQoderExtension, BINDING_TYPE } from './session-policy.mjs';
import { CATALOG_TTL_MS } from './catalog.mjs';
import { CATALOG_URL } from './catalog-auth.mjs';
import { CHAT_URL } from './transport.mjs';

const entry = (key = 'auto', patch = {}) => ({ key, display_name: 'Fixture', source: 'system', enable: true, format: 'openai', max_input_tokens: 200000, ...patch });
const deferred = () => Promise.withResolvers();
async function fixture(t, { authMode = 'qodercli', modelId = 'auto', modelPatch = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const machineId = randomUUID(), uid = 'fixture', org = '';
  const oauth = { type: 'oauth', qoderAuthVersion: 1, access: 'fixture', refresh: 'fixture-refresh', expires: Date.now() + 86400000, refreshExpires: Date.now() + 172800000, machineId, uid, org,
    fingerprint: createHmac('sha256', machineId).update(JSON.stringify(['rotom-qoder-browser-v1', uid, org])).digest('hex') };
  let credential = { accessToken: 'fixture', fingerprint: oauth.fingerprint, machineId, uid, org };
  const handlers = new Map(), commands = new Map(), notices = [], entries = [];
  let catalog = [entry(modelId, modelPatch)], catalogReads = 0, dispatches = 0, refreshCalls = 0, catalogHook, chatHook;
  let sessionId = 'fixture-session';
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerProvider() {}, registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
  };
  const provider = await installQoderExtension(pi, { piAI: { createProvider: x => x, lazyStream: (_m, fn) => fn() }, authMode,
    getCredential: async () => credential,
    fetchImpl: async (url, init) => {
      if (url === CATALOG_URL) {
        catalogReads++;
        if (catalogHook) await catalogHook(init.signal);
        return new Response(JSON.stringify({ assistant: catalog }));
      }
      assert.equal(url, CHAT_URL); dispatches++;
      if (chatHook) return chatHook(init.signal);
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const ctx = { hasUI: true, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, ui: { notify: text => notices.push(text) },
    modelRegistry: { async refresh(options) {
      refreshCalls++; assert.deepEqual(options.providers, ['qoder-experimental']); assert.equal(options.allowNetwork, true);
      const errors = new Map();
      try { await provider.refreshModels({ ...options, credential: oauth, publish: async p => { if (options.signal.aborted) return false; p.update?.(); return true; } }); }
      catch (error) { errors.set('qoder-experimental', error); }
      return { errors, aborted: options.signal.aborted };
    } },
  };
  const emit = async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  await emit('session_start');
  const model = provider.getModels().find(m => m.id === modelId);
  const auth = authMode === 'browser' ? await provider.auth.oauth.toAuth(oauth) : {};
  const run = async (options = {}, selected = model) => {
    const stream = await provider.api.streamSimple(selected, { messages: [] }, { ...auth, sessionId, ...options });
    const events = []; for await (const event of stream) events.push(event);
    return events.at(-1);
  };
  return { provider, ctx, model, run, emit, commands, notices, entries,
    expire: () => t.mock.timers.tick(CATALOG_TTL_MS + 1),
    counts: () => ({ catalogReads, dispatches, refreshCalls }),
    setCatalog: value => { catalog = value; }, setCatalogHook: fn => { catalogHook = fn; }, setChatHook: fn => { chatHook = fn; },
    changeAccount: () => { credential = { ...credential, fingerprint: 'b'.repeat(64) }; },
    changeSession: () => { sessionId = 'replacement-session'; },
  };
}

for (const authMode of ['qodercli', 'browser']) test(`${authMode}: expiry refreshes once before inference; fresh requests reuse the catalog`, async t => {
  const f = await fixture(t, { authMode });
  assert.equal((await f.run()).type, 'done');
  assert.deepEqual(f.counts(), { catalogReads: 1, dispatches: 1, refreshCalls: 1 });
  f.expire();
  assert.equal((await f.run()).type, 'done');
  assert.equal((await f.run()).type, 'done');
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 3, refreshCalls: 2 });
  assert.equal(f.entries.filter(e => e.customType === BINDING_TYPE).length, 1);
  assert.deepEqual(f.notices, []);
});

test('refresh failure keeps stale catalog but blocks inference without retry or private error leakage', async t => {
  const f = await fixture(t); f.expire();
  f.setCatalogHook(() => { throw new Error('PRIVATE upstream body'); });
  await assert.rejects(f.run(), /^QoderError: Qoder: catalog_refresh_failed$/);
  assert.equal(f.provider.getModels()[0].id, 'auto');
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 0, refreshCalls: 2 });
  await f.emit('message_end', { message: { provider: 'qoder-experimental', errorMessage: 'Qoder: catalog_refresh_failed' } });
  assert.match(f.notices.at(-1), /\/qoder-models/); assert.doesNotMatch(JSON.stringify(f.notices), /PRIVATE/);
  f.setCatalogHook(undefined);
  await f.commands.get('qoder-models').handler('', f.ctx);
  assert.equal((await f.run()).type, 'done');
  assert.deepEqual(f.counts(), { catalogReads: 3, dispatches: 1, refreshCalls: 3 });
});

for (const changed of [[entry('lite')], [entry('auto', { enable: false })], [entry('auto', { format: 'anthropic' })]]) test('removed, disabled or unsupported model never dispatches after refresh', async t => {
  const f = await fixture(t); f.expire(); f.setCatalog(changed);
  await assert.rejects(f.run(), /catalog_model_unavailable/);
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 0, refreshCalls: 2 });
});

test('narrowed context is rechecked against the refreshed snapshot', async t => {
  const f = await fixture(t, { modelId: 'ultimate' });
  f.expire(); f.setCatalog([entry('ultimate', { max_input_tokens: 4096 })]);
  await assert.rejects(f.run({ reasoning: 'medium' }), /catalog_changed_select_again/);
  assert.equal(f.counts().dispatches, 0);
});

test('refresh does not silently downgrade a removed thinking effort', async t => {
  const thinking = efforts => ({ is_reasoning: true, thinking_config: { enabled: { efforts } } });
  const f = await fixture(t, { modelId: 'ultimate', modelPatch: thinking({ high: { is_default: true }, low: {} }) });
  assert.equal(f.model.thinkingLevelMap.high, 'high');
  f.expire(); f.setCatalog([entry('ultimate', thinking({ low: { is_default: true } }))]);
  await assert.rejects(f.run({ reasoning: 'high' }), /reasoning_controls_not_validated/);
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 0, refreshCalls: 2 });
});

for (const patch of [{ thinking_config: { enabled: { efforts: { high: {} } } } }, {}]) test('removed off support cannot silently enable thinking for an omitted simple option', async t => {
  const f = await fixture(t, { modelId: 'qmodel_38max', modelPatch: { is_reasoning: true, thinking_config: { disabled: {}, enabled: { efforts: { high: {} } } } } });
  assert.equal(f.model.thinkingLevelMap.off, 'none');
  f.expire(); f.setCatalog([entry('qmodel_38max', { is_reasoning: true, ...patch })]);
  await assert.rejects(f.run(), /catalog_changed_select_again/);
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 0, refreshCalls: 2 });
});

test('raw stream shares the pre-dispatch refresh path', async t => {
  const f = await fixture(t); f.expire();
  const stream = await f.provider.api.stream(f.model, { messages: [] }, {});
  let last; for await (const event of stream) last = event;
  assert.equal(last.type, 'done');
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 1, refreshCalls: 2 });
});

test('registry deadline bounds a noncooperative refresh and blocks late dispatch', async t => {
  const f = await fixture(t), started = deferred(), release = deferred(), deadline = new AbortController();
  f.expire();
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => ms === 30000 ? deadline.signal : original(ms));
  f.setCatalogHook(async () => { started.resolve(); await release.promise; });
  const pending = f.run(); const rejected = assert.rejects(pending, /catalog_refresh_failed/);
  await started.promise; deadline.abort(); await rejected;
  release.resolve(); await new Promise(setImmediate);
  assert.equal(f.counts().dispatches, 0);
  assert.deepEqual(f.provider.filterModels(f.provider.getModels()), []);
});

test('inference failure after refresh is not retried or treated as another catalog expiry', async t => {
  const f = await fixture(t); f.expire();
  f.setChatHook(() => new Response('PRIVATE', { status: 503 }));
  await assert.rejects(f.run(), /^QoderError: Qoder: http_503$/);
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 1, refreshCalls: 2 });
});

test('account changed while expired cannot attach existing history to the new account', async t => {
  const f = await fixture(t); await f.run(); f.expire(); f.changeAccount();
  await assert.rejects(f.run(), /account_changed_start_new_session/);
  assert.equal(f.counts().dispatches, 1);
});

test('same-scope concurrent requests share a single catalog read', async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  f.expire(); f.setCatalogHook(async () => { started.resolve(); await release.promise; });
  const first = f.run(); await started.promise;
  const second = f.run(); release.resolve();
  assert((await Promise.all([first, second])).every(e => e.type === 'done'));
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 2, refreshCalls: 2 });
});

for (const action of ['abort', 'shutdown', 'replace']) test(`${action} during a noncooperative refresh prevents late inference`, async t => {
  const f = await fixture(t), started = deferred(), release = deferred(), controller = new AbortController();
  f.expire(); f.setCatalogHook(async () => { started.resolve(); await release.promise; });
  const pending = f.run({ signal: controller.signal });
  const rejected = action === 'abort' ? pending.then(event => assert.equal(event.reason, 'aborted')) : assert.rejects(pending, /account_binding_stale/);
  await started.promise;
  if (action === 'abort') { controller.abort(); await rejected; }
  if (action === 'shutdown') await f.emit('session_shutdown');
  if (action === 'replace') f.changeSession();
  release.resolve(); await rejected; await new Promise(setImmediate);
  assert.equal(f.counts().dispatches, 0); assert.equal(f.entries.length, 0);
});

test('pre-aborted requests do not refresh or dispatch', async t => {
  const f = await fixture(t); f.expire();
  assert.equal((await f.run({ signal: AbortSignal.abort() })).reason, 'aborted');
  assert.deepEqual(f.counts(), { catalogReads: 1, dispatches: 0, refreshCalls: 1 });
});

test('cancellation also reaches inference after a successful refresh', async t => {
  const f = await fixture(t), started = deferred(), controller = new AbortController(); f.expire();
  let transportSignal;
  f.setChatHook(signal => { transportSignal = signal; started.resolve(); return new Promise(() => {}); });
  const pending = f.run({ signal: controller.signal });
  const rejected = pending.then(event => assert.equal(event.reason, 'aborted'));
  await started.promise; controller.abort(); await rejected;
  assert(transportSignal.aborted);
  assert.deepEqual(f.counts(), { catalogReads: 2, dispatches: 1, refreshCalls: 2 });
});
