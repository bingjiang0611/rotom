import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { readLocalCredential, createCredentialAccess, QoderError } from './auth.mjs';
import { createQoderProvider, MODEL } from './provider.mjs';
import { normalizeSSE, createQoderFetch, CHAT_URL } from './transport.mjs';
import { BINDING_TYPE, bindSessionAccount, installSessionPolicy } from './session-policy.mjs';

const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const stop = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const done = 'data: [DONE]\n\n';
async function drain(wire, options) {
  let result = '';
  for await (const value of normalizeSSE(new Response(wire).body, options)) result += value;
  return result;
}

test('usage wrapping at EVERY character boundary preserves usage, including SSE-looking prefixes', async () => {
  const json = JSON.stringify({ choices: [], raw_usage: { private: ':secret-id:private-retry:field-event:value-data:value' }, usage });
  const reference = await drain(stop + frame({ choices: [], usage }) + done);
  for (let at = 1; at < json.length; at++) {
    const output = await drain(stop + `data: ${json.slice(0, at)}\n${json.slice(at)}\n\n` + done);
    assert.equal(output, reference, `split ${at}`);
  }
});

test('split literal SSE data prefixes are restored only within the same frame', async () => {
  const json = JSON.stringify({ choices: [{ delta: { content: 'fixture' }, finish_reason: null }] });
  const reference = await drain(frame(JSON.parse(json)) + stop + frame({ choices: [], usage }) + done);
  for (let at = 1; at < 5; at++) {
    const diagnostics = [], prefix = 'data:';
    assert.equal(await drain(prefix.slice(0, at) + '\n' + prefix.slice(at) + ' ' + json + '\n\n' + stop + frame({ choices: [], usage }) + done, { onDiagnostic: d => diagnostics.push(d) }), reference);
    assert.deepEqual(diagnostics, [{ code: 'field_prefix_continuation', parts: 2 }]);
  }
  assert.equal(await drain('d\na\nt\na\n: ' + json + '\n\n' + stop + frame({ choices: [], usage }) + done), reference);
  await assert.rejects(drain('da\n\nta: ' + json + '\n\n'), { code: 'unexpected_sse_field' });
  await assert.rejects(drain('da\nevent: error\nta: ' + json + '\n\n'));
  await assert.rejects(drain('da\nta: {"error":"PRIVATE"}\n\n'), { code: 'upstream_error_frame' });
  await assert.rejects(drain(stop + frame({ choices: [], usage }) + 'da\nta: [DONE]\n\n' + 'da\nta: '+json+'\n\n'), { code: 'data_after_done' });
  await assert.rejects(drain('da\nta: [DONE]\n\n'), { code: 'incomplete_stream' });
  await assert.rejects(drain('da\nta: '+json+'\n\n'+stop+done), { code: 'incomplete_stream' });
});

test('colon-led usage continuation is not discarded as an SSE comment', async () => {
  const diagnostics = [];
  const wire = stop + 'data: {"choices":[],"usage"\n:' + JSON.stringify(usage) + '}\n\n' + done;
  assert.match(await drain(wire, { onDiagnostic: d => diagnostics.push(d) }), /total_tokens/);
  assert.deepEqual(diagnostics, [{ code: 'usage_continuation', raw: false, fieldLike: 1 }]);
});

test('genuine SSE comments/ids/events remain ignorable and error events stay fatal', async () => {
  await drain(stop + 'data: {"choices":[],\n: heartbeat\nid: fixture\nevent: message\ndata: "usage":' + JSON.stringify(usage) + '}\n\n' + done);
  await assert.rejects(drain('data: {"choices":[]\nevent: error\n}\n\n'), { code: 'upstream_error_event' });
});

test('every content/tool JSON wrap preserves exact values, including escapes and SSE-looking text', async () => {
  for (const delta of [
    { content: 'synthetic\\n:field id:value data:value retry:value event:value "quoted"' },
    { tool_calls: [{ index: 0, id: 'fixture', type: 'function', function: { name: 'echo', arguments: JSON.stringify({ text: 'a\\n:field data:value "quote"' }) } }] },
  ]) {
    const json = JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] });
    const ending = stop + frame({ choices: [], usage }) + done;
    const options = { toolNames: ['echo'] };
    const reference = await drain(`data: ${json}\n\n` + ending, options);
    for (let at = 1; at < json.length; at++) {
      assert.equal(await drain(`data: ${json.slice(0, at)}\n${json.slice(at)}\n\n` + ending, options), reference, `split ${at}`);
    }
  }
});

test('literal event: error inside raw JSON is content, while a standard SSE error still fails', async () => {
  const json = JSON.stringify({ choices: [{ index: 0, delta: { content: 'before event: error after' }, finish_reason: null }] });
  const at = json.indexOf('event: error');
  const ending = stop + frame({ choices: [], usage }) + done;
  assert.equal(await drain(`data: ${json.slice(0, at)}\nevent: error\n${json.slice(at + 12)}\n\n` + ending), await drain(`data: ${json}\n\n` + ending));
  await assert.rejects(drain(`data: ${json}\nevent: error\n\n` + ending), { code: 'upstream_error_event' });
});

test('pre-abort bypasses credential reads and unavailable binding capture', async () => {
  const access = createCredentialAccess({ readCredential: () => assert.fail('read'), captureBinding: () => { throw new QoderError('account_binding_unavailable'); } });
  await assert.rejects(access.getToken(AbortSignal.abort()), { code: 'aborted' });
  await assert.rejects(access.check(AbortSignal.abort()), { code: 'aborted' });
});

test('native adapter normalizes to safe error codes without another dispatch', async () => {
  // The self-owned transport no longer renders errors as a 400 Response: a
  // known QoderError code is preserved and an arbitrary failure is masked as
  // request_failed, both surfacing as a thrown QoderError (which lazyStream
  // turns into an error event) with no upstream body and no network dispatch.
  for (const [error, expected] of [[new QoderError('credential_expired_login_with_qodercli'), 'credential_expired_login_with_qodercli'], [new Error('PRIVATE fixture error'), 'request_failed']]) {
    const provider = await createQoderProvider({
      authMode: 'qodercli',
      piAI: { createProvider: p => p, lazyStream: (_m, setup) => setup() },
      getToken: () => { throw error; }, fetchImpl: () => assert.fail('network'),
    });
    await assert.rejects(provider.api.streamSimple(MODEL, { messages: [] }), e => {
      assert.equal(e.code, expected); assert.doesNotMatch(String(e.message), /PRIVATE/); return true;
    });
  }
});

test('normalization never adds JSON syntax, joins frames, or invents finish/usage/done', async () => {
  for (const wire of ['data: {"choices":\n\n[] }\n\n', 'data: {"choices":[]\n\n', 'data: {"choices":[]\n}\n\n']) {
    await assert.rejects(drain(wire));
  }
});

test('diagnostics contain only structural metadata, even with malicious JSON errors', async () => {
  const diagnostics = [];
  await assert.rejects(drain('data: {"PRIVATE_TOKEN":INVALID_PRIVATE_BODY}\n\n', { onDiagnostic: d => diagnostics.push(d) }), { code: 'invalid_sse_json' });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['bytes', 'category', 'code', 'fieldCounts', 'position']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
  await assert.rejects(drain('data: {\n\n', { onDiagnostic() { throw new Error('PRIVATE'); } }), { code: 'invalid_sse_json' });
  await assert.rejects(drain('data: position 123456789\n\n', { onDiagnostic: d => diagnostics.push(d) }), { code: 'invalid_sse_json' });
  assert.equal(diagnostics.at(-1).position, -1);
  await assert.rejects(drain('data: {\n\n', { onDiagnostic: async () => { throw new Error('PRIVATE'); } }), { code: 'invalid_sse_json' });
  await new Promise(resolve => setImmediate(resolve));
});

const A = 'a'.repeat(64), B = 'b'.repeat(64);
function memory(entries = []) {
  return { getEntries: () => entries, append: (customType, data) => entries.push({ type: 'custom', customType, data }) };
}
test('binding persists across new guard instances and accepts same account only', () => {
  const manager = memory();
  bindSessionAccount(manager, manager.append, A);
  bindSessionAccount(manager, manager.append, A);
  assert.equal(manager.getEntries().length, 1);
  assert.equal(manager.getEntries()[0].data.pricing, 'unknown');
  assert.throws(() => bindSessionAccount(manager, manager.append, B), { code: 'account_changed_start_new_session' });
  assert.equal(manager.getEntries().length, 1);
});

test('whole-tree binding survives compaction and detects conflicting abandoned branches', () => {
  const manager = memory([{ type: 'custom', customType: BINDING_TYPE, data: { version: 1, fingerprint: A } }, { type: 'compaction' }]);
  bindSessionAccount(manager, manager.append, A);
  manager.append(BINDING_TYPE, { version: 1, fingerprint: B });
  assert.throws(() => bindSessionAccount(manager, manager.append, A), { code: 'account_changed_start_new_session' });
});

test('legacy, corrupt and unproven writes fail closed', () => {
  for (const entry of [{ type: 'compaction' }, { type: 'message', message: { role: 'assistant', provider: 'qoder-experimental', stopReason: 'stop' } }]) {
    const manager = memory([entry]);
    assert.throws(() => bindSessionAccount(manager, manager.append, A), { code: 'legacy_session_unbound_start_new_session' });
  }
  const manager = memory([{ type: 'custom', customType: BINDING_TYPE, data: { version: 99, fingerprint: A } }]);
  assert.throws(() => bindSessionAccount(manager, manager.append, A), { code: 'account_binding_invalid' });
  assert.throws(() => bindSessionAccount(memory(), () => {}, A), { code: 'account_binding_not_saved' });
});

test('session hooks invalidate outstanding credential leases on shutdown/switch', () => {
  const events = new Map(), status = [];
  let manager = memory();
  const pi = { on: (name, fn) => events.set(name, fn), appendEntry: (type, data) => manager.append(type, data) };
  const { captureBinding: capture } = installSessionPolicy(pi);
  assert.throws(capture, { code: 'account_binding_unavailable' });
  const ctx = { sessionManager: manager, hasUI: true, model: { provider: 'qoder-experimental' }, ui: { setStatus: (...args) => status.push(args) } };
  events.get('session_start')({}, ctx);
  assert.equal(status.length, 0);
  const lease = capture();
  events.get('session_shutdown')();
  assert.throws(() => lease(A), { code: 'account_binding_stale' });
  manager = memory();
  events.get('session_start')({}, { ...ctx, sessionManager: manager });
  capture()(B);
  assert.equal(manager.getEntries()[0].data.fingerprint, B);
});

test('availability never binds; rotation accepted; changed account blocks before fetch', async () => {
  let current = { accessToken: 'fixture-one', fingerprint: A }, calls = 0;
  const access = createCredentialAccess({ readCredential: async () => current });
  await access.check(); current = { accessToken: 'fixture-two', fingerprint: B };
  assert.equal(await access.getToken(), 'fixture-two');
  current = { ...current, accessToken: 'fixture-rotated' };
  assert.equal(await access.getToken(), 'fixture-rotated');
  current = { accessToken: 'fixture-one', fingerprint: A };
  const fetch = createQoderFetch({ getToken: access.getToken, fetchImpl: () => { calls++; } });
  await assert.rejects(fetch(CHAT_URL, { method: 'POST', body: JSON.stringify({ model: 'lite', messages: [], stream: true }) }), { code: 'account_changed_start_new_session' });
  assert.equal(calls, 0);
});

test('credential completion after cancellation cannot bind an account', async () => {
  let release, entered, writes = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const access = createCredentialAccess({ readCredential: () => { entered(); return new Promise(resolve => { release = resolve; }); }, captureBinding: () => () => { writes++; } });
  const controller = new AbortController();
  const pending = access.getToken(controller.signal);
  await ready; controller.abort(); release({ accessToken: 'fixture', fingerprint: A });
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(writes, 0);
});

test('encrypted fixtures bind uid/org, permit token renewal, and reject expiry/unknown identity', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'qoder-identity-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const machine = 'synthetic-machine-0123456789';
  await writeFile(join(dir, 'machine_id'), machine, { mode: 0o600 });
  const set = async overrides => {
    const key = Buffer.from(machine.slice(0, 16));
    const cipher = createCipheriv('aes-128-cbc', key, key);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ uid: 'synthetic-user', org_id: 'synthetic-org', access_token: 'fixture', expire_time: 100000, ...overrides })), cipher.final()]).toString('base64');
    await writeFile(join(dir, 'user'), encrypted, { mode: 0o600 });
  };
  await set({}); const first = await readLocalCredential({ authDir: dir, now: 0 });
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  await set({ security_oauth_token: 'fixture-renewed' });
  const renewed = await readLocalCredential({ authDir: dir, now: 0 });
  assert.equal(renewed.fingerprint, first.fingerprint); assert.equal(renewed.accessToken, 'fixture-renewed');
  await set({ uid: 'different-user' }); assert.notEqual((await readLocalCredential({ authDir: dir, now: 0 })).fingerprint, first.fingerprint);
  await set({ org_id: 'different-org' }); assert.notEqual((await readLocalCredential({ authDir: dir, now: 0 })).fingerprint, first.fingerprint);
  await set({ uid: null }); await assert.rejects(readLocalCredential({ authDir: dir, now: 0 }), { code: 'credential_identity_unavailable' });
  await set({ expire_time: 60 }); await assert.rejects(readLocalCredential({ authDir: dir, now: 0 }), { code: 'credential_expired_login_with_qodercli' });
});
