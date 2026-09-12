import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createQoderProvider, MODEL } from '../../rotom/extensions/qoder/provider.mjs';

const entry = process.env.ROTOM_PI;
if (!entry || !isAbsolute(entry) || !(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('Set canonical ROTOM_PI');
if (!process.execArgv.includes('--experimental-import-meta-resolve')) throw new Error('Use --experimental-import-meta-resolve');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Only --live is supported');
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const openAI = await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions', parent));
const live = process.argv.includes('--live'), marker = `REPLAY_${randomUUID()}`;
const summary = { mode: live ? 'live' : 'offline', requests: 0, checks: {}, rounds: [], cost: 'unknown' };
let phase = 'abort';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const fetchImpl = async (url, init) => {
  assert.ok(++summary.requests <= 3);
  if (live) return globalThis.fetch(url, init);
  const first = frame({ choices: [{ index: 0, delta: { content: phase === 'abort' ? '1' : marker }, finish_reason: null }] });
  if (phase === 'abort') return new Response(new ReadableStream({ start(out) { out.enqueue(new TextEncoder().encode(first)); } }), { headers: { 'content-type': 'text/event-stream' } });
  return new Response(first + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
const provider = await createQoderProvider({ piAI, openAI, fetchImpl, ...live ? {} : { getToken: async () => 'fixture' } });
async function run(context, signal, onDelta) {
  const stream = provider.streamSimple(MODEL, context, { maxTokens: 256, signal });
  let deltas = 0;
  for await (const event of stream) if (event.type === 'text_delta') { deltas++; onDelta?.(); }
  const result = await stream.result();
  summary.rounds.push({ phase, stopReason: result.stopReason, deltas,
    ...(result.errorMessage ? { errorCode: result.errorMessage.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'native_stream_error' } : {}),
    usage: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead },
  });
  return result;
}
const user = content => ({ role: 'user', content, timestamp: Date.now() });
const answer = result => {
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content.filter(c => c.type === 'text').map(c => c.text).join('').trim(), marker);
};
try {
  const controller = new AbortController();
  const aborted = await run({ messages: [user('Write integers from 1 to 10000, one per line. Do not stop early.')] }, controller.signal, () => controller.abort());
  assert.ok(summary.rounds[0].deltas > 0); assert.equal(aborted.stopReason, 'aborted');
  summary.checks.midstreamAbort = 'pass';
  phase = 'after-abort';
  answer(await run({ messages: [user(`Reply with exactly ${marker}.`)] }));
  summary.checks.freshRequestAfterAbort = 'pass';
  phase = 'cross-provider';
  const assistant = { role: 'assistant', api: 'anthropic-messages', provider: 'synthetic-other-provider', model: 'synthetic-other-model', stopReason: 'toolUse', timestamp: Date.now(),
    content: [{ type: 'toolCall', id: 'foreign|call:1', name: 'synthetic_echo', arguments: {} }],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  answer(await run({ messages: [user('Call synthetic_echo and reply with exactly its result.'), assistant,
    { role: 'toolResult', toolCallId: 'foreign|call:1', toolName: 'synthetic_echo', content: [{ type: 'text', text: marker }], isError: false, timestamp: Date.now() }],
    tools: [{ name: 'synthetic_echo', description: 'Pure synthetic protocol fixture.', parameters: piAI.Type.Object({}) }],
  }));
  summary.checks.syntheticForeignToolHistory = 'pass';
  summary.pass = true;
} catch {
  summary.pass = false; summary.failedPhase = phase; process.exitCode = 1;
}
console.log(JSON.stringify(summary, null, 2));
