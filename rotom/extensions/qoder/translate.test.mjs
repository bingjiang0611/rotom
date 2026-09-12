import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateQoderStream } from './translate.mjs';
import { QoderError } from './auth.mjs';

const MODEL = { id: 'lite', api: 'qoder', provider: 'qoder-experimental' };

// Build an async iterable of validated chunk records, exactly the shape
// openQoderStream yields (STREAM_DONE is already swallowed there).
async function* source(chunks) { for (const c of chunks) yield c; }
async function* failing(chunks, error) { for (const c of chunks) yield c; throw error; }

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('text stream produces start/text/done with final message', async () => {
  const events = await collect(translateQoderStream(source([
    delta({ role: 'assistant' }),
    delta({ content: 'Hel' }),
    delta({ content: 'lo' }, 'stop'),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]), MODEL));
  assert.deepEqual(events.map(e => e.type), ['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done']);
  const done = events.at(-1);
  assert.equal(done.reason, 'stop');
  assert.deepEqual(done.message.content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(done.message.usage.input, 10);
  assert.equal(done.message.usage.output, 2);
});

test('plain reasoning becomes a thinking block signed reasoning_content', async () => {
  const events = await collect(translateQoderStream(source([
    delta({ reasoning_content: 'think ' }),
    delta({ reasoning_content: 'more' }),
    delta({ content: 'answer' }, 'stop'),
  ]), MODEL));
  const thinking = events.at(-1).message.content.find(b => b.type === 'thinking');
  assert.equal(thinking.thinking, 'think more');
  assert.equal(thinking.thinkingSignature, 'reasoning_content');
  assert.ok(events.some(e => e.type === 'thinking_start'));
  assert.ok(events.some(e => e.type === 'thinking_end'));
});

test('opaque reasoning_details are preserved as a JSON signature for replay', async () => {
  const detail = { type: 'reasoning.encrypted', format: 'rotom-qoder-ultimate-v1', id: 'r1', data: 'ciphertext' };
  const events = await collect(translateQoderStream(source([
    delta({ reasoning_details: [detail] }),
    delta({ content: 'ok' }, 'stop'),
  ]), MODEL));
  const thinking = events.at(-1).message.content.find(b => b.type === 'thinking');
  assert.equal(thinking.thinking, '');
  // The signature must JSON-parse back to the exact details array so that the
  // request builder can rebuild reasoning_details verbatim.
  assert.deepEqual(JSON.parse(thinking.thinkingSignature), [detail]);
});

test('tool calls accumulate arguments and finalize as toolUse', async () => {
  const events = await collect(translateQoderStream(source([
    delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":' } }] }),
    delta({ tool_calls: [{ index: 0, type: 'function', function: { arguments: '"hi"}' } }] }, 'tool_calls'),
  ]), MODEL));
  const done = events.at(-1);
  assert.equal(done.reason, 'toolUse');
  const call = done.message.content.find(b => b.type === 'toolCall');
  assert.equal(call.id, 'call_1');
  assert.equal(call.name, 'echo');
  assert.deepEqual(call.arguments, { msg: 'hi' });
  assert.equal(call.partialArgs, undefined);
});

test('mid-stream failure yields a partial-preserving error event, not a throw', async () => {
  const events = await collect(translateQoderStream(failing([
    delta({ content: 'partial' }),
  ], new QoderError('http_500')), MODEL));
  const last = events.at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.reason, 'error');
  assert.equal(last.error.errorMessage, 'Qoder: http_500');
  assert.deepEqual(last.error.content, [{ type: 'text', text: 'partial' }]);
  assert.equal(last.error.stopReason, 'error');
});

test('abort failure maps to an aborted error event', async () => {
  const events = await collect(translateQoderStream(failing([], new QoderError('aborted')), MODEL));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).reason, 'aborted');
});
