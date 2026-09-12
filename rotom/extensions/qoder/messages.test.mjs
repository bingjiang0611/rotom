import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQoderPayload } from './messages.mjs';
import { translateQoderStream } from './translate.mjs';

const MODEL = { id: 'lite', api: 'qoder', provider: 'qoder-experimental', input: ['text', 'image'] };
const TEXT_ONLY = { ...MODEL, input: ['text'] };
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
async function* source(chunks) { for (const c of chunks) yield c; }
async function collect(iterable) { const events = []; for await (const e of iterable) events.push(e); return events; }
// Rebuild a persisted assistant history turn exactly as Pi would after
// translate.mjs finished a same-model response.
const history = message => ({ role: 'assistant', provider: MODEL.provider, api: MODEL.api, model: MODEL.id, ...message });

test('opaque reasoning, text and tool calls round-trip translate -> messages verbatim', async () => {
  const detail = { type: 'reasoning.encrypted', format: 'rotom-qoder-ultimate-v1', id: 'r1', data: 'ciphertext' };
  const done = (await collect(translateQoderStream(source([
    delta({ reasoning_details: [detail] }),
    delta({ content: 'answer' }),
    delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"m":1}' } }] }, 'tool_calls'),
  ]), MODEL))).at(-1);
  const payload = buildQoderPayload(MODEL, { messages: [history(done.message)] }, { maxTokens: 4096 });
  const assistant = payload.messages[0];
  // The encrypted details survive as a structural array (never decoded), the
  // visible text stays, and tool arguments re-serialize to the exact JSON.
  assert.deepEqual(assistant.reasoning_details, [detail]);
  assert.equal(assistant.content, 'answer');
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"m":1}' } }]);
  assert.equal(assistant.reasoning_content, undefined);
});

test('plain reasoning round-trips as reasoning_content, not an opaque array', async () => {
  const done = (await collect(translateQoderStream(source([
    delta({ reasoning_content: 'thought' }),
    delta({ content: 'reply' }, 'stop'),
  ]), MODEL))).at(-1);
  const assistant = buildQoderPayload(MODEL, { messages: [history(done.message)] }, { maxTokens: 4096 }).messages[0];
  assert.equal(assistant.reasoning_content, 'thought');
  assert.equal(assistant.content, 'reply');
  assert.equal(assistant.reasoning_details, undefined);
});

test('system prompt uses the system role and text/tool bookkeeping', () => {
  const payload = buildQoderPayload(MODEL, { systemPrompt: 'be brief', messages: [{ role: 'user', content: 'hi' }] }, { maxTokens: 4096 });
  assert.deepEqual(payload.messages[0], { role: 'system', content: 'be brief' });
  assert.equal(payload.messages.some(m => m.role === 'developer'), false);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.tools, undefined);
});

test('reasoning_effort is set only when a validated reasoning mode is bound', () => {
  const payload = buildQoderPayload(MODEL, { messages: [{ role: 'user', content: 'hi' }] }, { maxTokens: 4096, reasoningMode: { enabled: true, effort: 'high' } });
  assert.equal(payload.reasoning_effort, 'high');
  assert.equal(payload.enable_thinking, undefined); // openQoderStream owns enable_thinking.
});

test('unpaired surrogates are stripped before the wire', () => {
  const payload = buildQoderPayload(MODEL, { systemPrompt: 'sys\uD800', messages: [{ role: 'user', content: 'a\uDC00b' }] }, { maxTokens: 4096 });
  assert.equal(payload.messages[0].content, 'sys');
  assert.equal(payload.messages[1].content, 'ab');
});

test('empty assistant turns are skipped, orphaned tool calls get a synthetic result', () => {
  const payload = buildQoderPayload(MODEL, { messages: [
    { role: 'assistant', provider: MODEL.provider, api: MODEL.api, model: MODEL.id, content: [{ type: 'text', text: '   ' }] },
    { role: 'user', content: 'go' },
    { role: 'assistant', provider: MODEL.provider, api: MODEL.api, model: MODEL.id, content: [{ type: 'toolCall', id: 'call_x', name: 'run', arguments: {} }] },
  ] }, { maxTokens: 4096 });
  // The whitespace-only assistant turn is dropped; the tool call keeps a paired
  // synthetic tool result so the history stays well-formed for replay.
  assert.deepEqual(payload.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(payload.messages[2].tool_call_id, 'call_x');
  assert.equal(payload.messages[2].content, 'No result provided');
  assert.deepEqual(payload.tools, []); // tool history without live tools still declares an empty tools array.
});

test('cross-model thinking is downgraded to plain text and never replayed as signed reasoning', () => {
  const payload = buildQoderPayload(MODEL, { messages: [
    { role: 'assistant', provider: 'other-provider', api: 'qoder', model: MODEL.id, content: [{ type: 'thinking', thinking: 'foreign reasoning', thinkingSignature: 'reasoning_content' }] },
  ] }, { maxTokens: 4096 });
  assert.equal(payload.messages[0].content, 'foreign reasoning');
  assert.equal(payload.messages[0].reasoning_content, undefined);
  assert.equal(payload.messages[0].reasoning_details, undefined);
});

test('tool results batch into tool messages and split images into a trailing user message', () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4)]).toString('base64');
  const payload = buildQoderPayload(MODEL, { messages: [
    { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'out1' }] },
    { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'image', mimeType: 'image/png', data: png }] },
  ] }, { maxTokens: 4096 });
  assert.deepEqual(payload.messages.map(m => m.role), ['tool', 'tool', 'user']);
  assert.equal(payload.messages[0].content, 'out1');
  assert.equal(payload.messages[1].content, '(see attached image)');
  assert.equal(payload.messages[2].content[0].text, 'Attached image(s) from tool result:');
  assert.equal(payload.messages[2].content[1].image_url.url, `data:image/png;base64,${png}`);
});

test('non-vision models replace user and tool images with a placeholder, not image_url blocks', () => {
  const png = Buffer.from([137, 80, 78, 71]).toString('base64');
  const payload = buildQoderPayload(TEXT_ONLY, { messages: [
    { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', data: png }] },
    { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'image', mimeType: 'image/png', data: png }] },
  ] }, { maxTokens: 4096 });
  assert.equal(JSON.stringify(payload).includes('image_url'), false);
  assert.equal(payload.messages[0].content.some(b => b.text === '(image omitted: model does not support images)'), true);
});

test('a tool that hard-requires strict constrained sampling fails closed', () => {
  assert.throws(() => buildQoderPayload(MODEL, { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', parameters: {}, constrainedSampling: { type: 'json_schema', strict: 'require' } }] }, { maxTokens: 4096 }), { code: 'tool_constrained_sampling_unsupported' });
});
