import test from 'node:test';
import assert from 'node:assert/strict';
import { createQoderFetch, normalizeSSE, CHAT_URL } from './transport.mjs';
import { createQoderProvider } from './provider.mjs';

const request = (signal) => ({ method: 'POST', body: JSON.stringify({ model: 'lite', messages: [], stream: true }), signal });
const never = () => new Promise(() => {});
const headers = { 'content-type': 'text/event-stream' };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
const ending = frame(chunk({}, 'stop')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n';
async function drain(wire) {
  let text = '';
  for await (const value of normalizeSSE(new Response(wire).body)) text += value;
  return text;
}

for (const phase of ['credential', 'fetch']) {
  test(`deadline bounds non-cooperative ${phase}`, { timeout: 1000 }, async () => {
    let calls = 0;
    const fetch = createQoderFetch({ timeoutMs: 10,
      getToken: phase === 'credential' ? never : async () => 'fixture',
      fetchImpl: () => { calls++; return never(); },
    });
    await assert.rejects(fetch(CHAT_URL, request()), { code: 'aborted' });
    assert.equal(calls, phase === 'credential' ? 0 : 1);
  });
}

test('abort during credential loading prevents late dispatch', { timeout: 1000 }, async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const fetch = createQoderFetch({ getToken: () => { entered(); return new Promise(resolve => { release = resolve; }); }, fetchImpl: () => assert.fail('late dispatch') });
  const pending = fetch(CHAT_URL, request(controller.signal));
  await ready; controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  release('fixture'); await new Promise(resolve => setImmediate(resolve));
});

test('provider auth resolution observes caller abort', { timeout: 1000 }, async () => {
  const provider = await createQoderProvider({ authMode: 'qodercli', piAI: { createProvider: p => p }, getToken: never });
  const controller = new AbortController();
  const pending = provider.auth.apiKey.resolve({ signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'aborted' });
});

test('late HTTP response is cancelled after dispatch deadline', { timeout: 1000 }, async () => {
  let release, cancelled = 0;
  const fetch = createQoderFetch({ timeoutMs: 10, getToken: async () => 'fixture', fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(fetch(CHAT_URL, request()), { code: 'aborted' });
  release(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('stalled source cancellation cannot stall abort delivery', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const it = normalizeSSE(new ReadableStream({ cancel: never }), { signal: controller.signal });
  const pending = it.next(); controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`HTTP ${status} is sanitized and single dispatch despite stalled cancel`, { timeout: 1000 }, async () => {
    let calls = 0;
    const fetch = createQoderFetch({ getToken: async () => 'fixture', fetchImpl: async () => {
      calls++; return new Response(new ReadableStream({ cancel: never }), { status });
    } });
    await assert.rejects(fetch(CHAT_URL, request()), { code: `http_${status}` });
    assert.equal(calls, 1);
  });
}

test('non-object payload and malformed tool declarations fail before auth', async () => {
  const fetch = createQoderFetch({ getToken: () => assert.fail('auth called') });
  for (const value of [null, false, 2, 'x', [], { model: 'lite', messages: [], stream: true, tools: [null] }]) {
    await assert.rejects(fetch(CHAT_URL, { ...request(), body: JSON.stringify(value) }), { code: 'request_scope_rejected' });
  }
});

test('CR-only, LF and CRLF have identical normalized output', async () => {
  const reference = await drain(ending);
  assert.equal(await drain(ending.replaceAll('\n', '\r')), reference);
  assert.equal(await drain(ending.replaceAll('\n', '\r\n')), reference);
});

test('unsupported reasoning fails closed instead of producing thinking', async () => {
  await assert.rejects(drain(frame(chunk({ reasoning_content: 'synthetic' })) + ending), { code: 'reasoning_not_validated' });
});

test('disconnect after content cannot become successful completion', async () => {
  const source = new ReadableStream({ start(out) {
    out.enqueue(new TextEncoder().encode(frame(chunk({ content: 'synthetic' }))));
  }, pull(out) { out.error(new Error('PRIVATE_NETWORK_ERROR')); } });
  await assert.rejects(async () => { for await (const _ of normalizeSSE(source)) { /* drain */ } }, error => error.code === 'stream_failed' && !error.message.includes('PRIVATE'));
});
