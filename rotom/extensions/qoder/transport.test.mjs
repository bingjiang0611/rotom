import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, realpath, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { readLocalAccessToken } from './auth.mjs';
import { CHAT_URL, normalizeSSE, createQoderFetch } from './transport.mjs';
import { createQoderProvider, MODEL } from './provider.mjs';

const encoder = new TextEncoder();
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } };
const chunk = (delta, finish = null) => ({ id: 'fixture', object: 'chat.completion.chunk', model: 'lite', choices: [{ index: 0, delta, finish_reason: finish }] });
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const ending = frame({ choices: [], usage }) + 'data: [DONE]\n\n';
function body(text, split = 1) {
  const bytes = encoder.encode(text); let offset = 0;
  return new ReadableStream({ pull(out) { if (offset === bytes.length) return out.close(); out.enqueue(bytes.subarray(offset, offset += Math.min(split, bytes.length - offset))); } });
}
async function normalized(text, options) {
  const result = [];
  for await (const line of normalizeSSE(body(text), options)) result.push(line);
  return result.join('');
}
const toolDelta = { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'echo', arguments: '{"nonce":"ok"}' } }] };

test('UTF-8/chunk splits, CRLF, comments and usage metadata allowlist', async () => {
  const input = ': heartbeat\r\n\r\n' + frame(chunk({ content: '你好🌱' })).replaceAll('\n', '\r\n') + frame(chunk({}, 'stop')) + frame({ choices: [], usage, raw_usage: { account: 'DO_NOT_FORWARD' } }) + 'data: [DONE]\n\n';
  const output = await normalized(input);
  assert.match(output, /你好🌱/); assert.doesNotMatch(output, /raw_usage|DO_NOT_FORWARD/);
  assert.match(output, /cached_tokens/);
});

test('Qoder raw usage line continuation (inside a JSON key)', async () => {
  const json = JSON.stringify({ choices: [], raw_usage: { private_account: 'discard' }, usage });
  const at = json.indexOf('private_account') + 5;
  const output = await normalized(frame(chunk({}, 'stop')) + `data: ${json.slice(0, at)}\n${json.slice(at)}\n\n` + 'data: [DONE]\n\n');
  assert.match(output, /total_tokens/); assert.doesNotMatch(output, /private|discard/);
});

test('standard multiline SSE data is preserved', async () => {
  const output = await normalized('data: {"choices":[],\ndata: "usage":' + JSON.stringify(usage) + '}\n\n' + frame(chunk({}, 'stop')) + 'data: [DONE]\n\n');
  assert.match(output, /prompt_tokens/);
});

test('tool call plus upstream stop becomes tool_calls without executing anything', async () => {
  const output = await normalized(frame(chunk(toolDelta)) + frame(chunk({}, 'stop')) + ending, { toolNames: ['echo'] });
  assert.match(output, /"finish_reason":"tool_calls"/);
});

for (const [label, input, code] of [
  ['missing finish', ending, 'incomplete_stream'],
  ['missing usage', frame(chunk({}, 'stop')) + 'data: [DONE]\n\n', 'incomplete_stream'],
  ['missing done', frame(chunk({}, 'stop')) + frame({ choices: [], usage }), 'incomplete_stream'],
  ['partial JSON', 'data: {"choices":\n\n', 'invalid_sse_json'],
  ['error body', 'event: error\ndata: PRIVATE_ERROR_TEXT\n\n', 'upstream_error_event'],
  ['error chunk', frame({ error: { message: 'PRIVATE_ERROR_TEXT' } }), 'upstream_error_frame'],
  ['quota', 'data: [EXCEED_QUOTA]PRIVATE_ERROR_TEXT\n\n', 'quota_exceeded'],
  ['unknown stop', frame(chunk({}, 'mystery')), 'invalid_finish_reason'],
  ['bad usage', frame({ choices: [], usage: { ...usage, prompt_tokens: -1 } }), 'invalid_usage'],
  ['unexpected tool', frame(chunk(toolDelta)) + frame(chunk({}, 'stop')) + ending, 'invalid_tool_call'],
]) {
  test(`fail closed: ${label}`, async () => {
    await assert.rejects(normalized(input), error => error.code === code && !error.message.includes('PRIVATE_ERROR_TEXT'));
  });
}

test('empty IDs on continuation deltas do not replace an established ID', async () => {
  const start = structuredClone(toolDelta); start.tool_calls[0].function.arguments = '{"nonce":';
  const continuation = { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"ok"}' } }] };
  const output = await normalized(frame(chunk(start)) + frame(chunk(continuation)) + frame(chunk({}, 'stop')) + ending, { toolNames: ['echo'] });
  assert.match(output, /"finish_reason":"tool_calls"/);
  const changed = structuredClone(continuation); changed.tool_calls[0].id = 'changed-id';
  await assert.rejects(normalized(frame(chunk(start)) + frame(chunk(changed)), { toolNames: ['echo'] }), { code: 'invalid_tool_id' });
});

test('invalid tool JSON, truncation, duplicate IDs, and unknown tool type are blocked', async () => {
  const bad = structuredClone(toolDelta); bad.tool_calls[0].function.arguments = '{';
  await assert.rejects(normalized(frame(chunk(bad)) + frame(chunk({}, 'stop')) + ending, { toolNames: ['echo'] }), { code: 'invalid_tool_arguments' });
  await assert.rejects(normalized(frame(chunk(toolDelta)) + frame(chunk({}, 'length')) + ending, { toolNames: ['echo'] }), { code: 'truncated_tool_call' });
  const dup = structuredClone(toolDelta); dup.tool_calls.push({ ...dup.tool_calls[0], index: 1 });
  await assert.rejects(normalized(frame(chunk(dup)) + frame(chunk({}, 'stop')) + ending, { toolNames: ['echo'] }), { code: 'invalid_tool_call' });
  const custom = structuredClone(toolDelta); custom.tool_calls[0].type = 'custom';
  await assert.rejects(normalized(frame(chunk(custom))), { code: 'unsupported_tool_type' });
});

test('quota notifications are dropped, but never replace terminal evidence', async () => {
  const output = await normalized('data: [NOTIFICATIONS]PRIVATE\n\ndata: [NOT_EXCEED_QUOTA]\n\n' + frame(chunk({}, 'stop')) + ending);
  assert.doesNotMatch(output, /PRIVATE|NOTIFICATIONS/);
});

test('frame/total output bounds', async () => {
  await assert.rejects(normalized('data: ' + 'x'.repeat(80), { maxFrameBytes: 32 }), { code: 'frame_oversized' });
  await assert.rejects(normalized('data: ' + 'x'.repeat(80), { maxTotalBytes: 32 }), { code: 'stream_oversized' });
});

test('abort unblocks an idle reader and cancels it', async () => {
  const controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const it = normalizeSSE(stream, { signal: controller.signal });
  const next = it.next(); controller.abort();
  await assert.rejects(next, { code: 'aborted' }); assert.equal(cancelled, true);
});

const request = () => ({ method: 'POST', body: JSON.stringify({ model: 'lite', messages: [], stream: true }) });
test('only fixed endpoint receives token; inbound headers/metadata are not forwarded', async () => {
  let calls = 0;
  const fetch = createQoderFetch({ getToken: async () => 'fixture-token', fetchImpl: async (url, init) => {
    calls++; assert.equal(url, CHAT_URL); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token'); assert.equal(init.headers['x-untrusted'], undefined);
    assert.equal(JSON.parse(init.body).metadata.context.client_type, 'rotom');
    return new Response(body(frame(chunk({}, 'stop')) + ending), { headers: { 'content-type': 'text/event-stream' } });
  } });
  await assert.rejects(fetch('https://example.invalid/chat/completions', request()), { code: 'request_scope_rejected' });
  assert.equal(calls, 0);
  const response = await fetch(CHAT_URL, { ...request(), headers: { 'x-untrusted': 'not-forwarded' } });
  assert.match(await response.text(), /total_tokens/); assert.equal(calls, 1);
});

test('HTTP failures are sanitized, never retried, never refresh credentials', async () => {
  let calls = 0, authCalls = 0;
  const fetch = createQoderFetch({ getToken: async () => { authCalls++; return 'fixture-token'; }, fetchImpl: async () => { calls++; return new Response('PRIVATE_ERROR_TEXT', { status: 401 }); } });
  await assert.rejects(fetch(CHAT_URL, request()), { code: 'http_401' });
  assert.equal(calls, 1); assert.equal(authCalls, 1);
});

test('onPayload cannot bypass the experiment output bound', async () => {
  const fetch = createQoderFetch({ getToken: () => assert.fail('auth called'), fetchImpl: () => assert.fail('network called') });
  for (const max_tokens of [-1, 0, 4097, 1.5]) {
    const init = request(); init.body = JSON.stringify({ ...JSON.parse(init.body), max_tokens });
    await assert.rejects(fetch(CHAT_URL, init), { code: 'request_limits_rejected' });
  }
});

test('pre-abort performs neither credential reads nor network requests', async () => {
  const fetch = createQoderFetch({ getToken: () => assert.fail('auth called'), fetchImpl: () => assert.fail('network called') });
  await assert.rejects(fetch(CHAT_URL, { ...request(), signal: AbortSignal.abort() }), { code: 'aborted' });
});

test('request timeout terminates an idle response', async () => {
  const fetch = createQoderFetch({ getToken: async () => 'fixture-token', timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await fetch(CHAT_URL, request());
  await assert.rejects(response.text(), { code: 'aborted' });
});

async function authFixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'qoder-auth-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const machine = 'test-machine-id-012345678901234567890';
  const key = Buffer.from(machine.slice(0, 16));
  const set = async (data) => {
    const cipher = createCipheriv('aes-128-cbc', key, key);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
    await writeFile(join(dir, 'user'), encrypted, { mode: 0o600 });
  };
  await writeFile(join(dir, 'machine_id'), machine, { mode: 0o600 });
  await set({ uid: 'fixture-user', security_oauth_token: 'fixture-token', expire_time: 100000 });
  return { dir, set };
}

test('local credentials decrypt read-only, reject expired/malformed/symlink/public stores', async t => {
  const { dir, set } = await authFixture(t);
  const before = await readFile(join(dir, 'user'));
  assert.equal(await readLocalAccessToken({ authDir: dir, now: 0 }), 'fixture-token');
  assert.deepEqual(await readFile(join(dir, 'user')), before);
  await assert.rejects(readLocalAccessToken({ authDir: dir, now: 100000000 }), { code: 'credential_expired_login_with_qodercli' });
  await chmod(join(dir, 'user'), 0o644);
  await assert.rejects(readLocalAccessToken({ authDir: dir, now: 0 }), { code: 'credential_file_not_private' });
  await chmod(join(dir, 'user'), 0o600);
  await set({ security_oauth_token: 'PRIVATE\nBAD', expire_time: 100000 });
  await assert.rejects(readLocalAccessToken({ authDir: dir, now: 0 }), { code: 'credential_format_invalid' });
  await rm(join(dir, 'user')); await symlink(join(dir, 'machine_id'), join(dir, 'user'));
  await assert.rejects(readLocalAccessToken({ authDir: dir, now: 0 }), { code: 'credential_path_not_canonical' });
});

test('credential errors never include underlying contents or missing file paths', async t => {
  const { dir } = await authFixture(t);
  await writeFile(join(dir, 'user'), 'PRIVATE malformed credential');
  await assert.rejects(readLocalAccessToken({ authDir: dir, now: 0 }), error => !error.message.includes('PRIVATE') && !error.message.includes(dir));
  await assert.rejects(readLocalAccessToken({ authDir: 'relative' }), { code: 'credential_path_not_canonical' });
});

test('provider owns a single bounded dispatch, caps maxTokens, and rejects endpoint overrides', async () => {
  let calls = 0, body;
  const provider = await createQoderProvider({
    authMode: 'qodercli',
    piAI: { createProvider: p => p, lazyStream: (_m, setup) => setup() },
    getToken: async () => 'secret-fixture',
    fetchImpl: async (_url, init) => { calls++; body = JSON.parse(init.body); return new Response('', { status: 403 }); },
  });
  assert.equal((await provider.auth.apiKey.resolve()).auth.apiKey.includes('secret-fixture'), false);
  // maxRetries is not a transport concept here: exactly one dispatch, and the
  // caller's maxTokens is capped to the reviewed maximum at build time.
  await assert.rejects(provider.api.streamSimple(MODEL, { messages: [] }, { maxRetries: 9, maxTokens: 99999 }), { code: 'http_403' });
  assert.equal(calls, 1); assert.equal(body.max_tokens, 4096);
  await assert.rejects(provider.api.streamSimple({ ...MODEL, baseUrl: 'https://example.invalid' }, { messages: [] }), { code: 'model_scope_rejected' });
  await assert.rejects(provider.api.streamSimple(MODEL, { messages: [{ content: [{ type: 'image' }] }] }), { code: 'images_not_validated' });
  await assert.rejects(provider.api.streamSimple(MODEL, { messages: [{ content: [{ type: 'thinking', thinking: 'fixture', thinkingSignature: 'opaque-fixture' }] }] }), { code: 'opaque_reasoning_replay_unsupported' });
  await assert.rejects(provider.api.streamSimple({ ...MODEL, id: 'unvalidated-model' }, { messages: [] }), { code: 'model_scope_rejected' });
});
