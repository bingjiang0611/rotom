import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSSE, openQoderStream } from './transport.mjs';
import { translateQoderStream } from './translate.mjs';

// Sanitized shape observed on Ultimate COSY after the text and before finish/usage.
const metadata = {
  created: 1, id: 'fixture', model: 'auto', object: 'chat.completion.chunk',
  extras: { context_management: { applied_edits: [] } },
};
const options = { allowLegacyEnvelope: true, allowOpaqueReasoning: true, opaqueModelId: 'ultimate' };
const frame = value => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(value) })}\n\n`;
const text = frame({ choices: [{ delta: { content: 'Hi!' }, index: 0 }] });
const terminal = frame({ choices: [{ finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, credits: 0.01, billable: true } });
const done = 'data: [DONE]\n\n';
const timing = 'data: {"firstTokenDuration":1,"totalDuration":2,"serverDuration":1}\n\n';
async function normalize(body, opts = options) {
  let result = '';
  for await (const chunk of normalizeSSE(new Response(body).body, opts)) result += chunk;
  return result;
}

test('Ultimate empty context-management metadata does not interrupt text, usage or credits', async () => {
  const metering = [];
  let requests = 0;
  const body = text + frame(metadata) + terminal + done + timing;
  const { chunks } = await openQoderStream({
    modelId: 'ultimate',
    legacyModel: { id: 'ultimate', name: 'Ultimate', enabled: true, reviewed: true, format: 'openai', reportedContextWindow: 1000000, contextWindow: 32000 },
    getToken: () => 'fixture',
    getLegacyCredential: () => ({ accessToken: 'fixture', uid: 'fixture', org: '', machineId: 'fixture-machine' }),
    payload: { model: 'ultimate', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    onMetering: value => metering.push(value),
    fetchImpl: () => {
      requests++;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const events = [];
  for await (const event of translateQoderStream(chunks, { id: 'ultimate', provider: 'qoder', api: 'qoder' })) events.push(event);
  const end = events.at(-1);
  assert.equal(end.type, 'done');
  assert.equal(end.message.stopReason, 'stop');
  assert.deepEqual(end.message.content, [{ type: 'text', text: 'Hi!' }]);
  assert.equal(end.message.usage.totalTokens, 3);
  assert.equal(requests, 1);
  assert.equal(metering.length, 1);
  assert.equal(metering[0].status, 'reported');
  assert.equal(metering[0].outcome, 'complete');
  assert.equal(metering[0].credits, 0.01);
});

test('wrapped context metadata uses the existing same-frame continuation parser', async () => {
  const wrapped = frame(metadata).replace('context_management', 'context_\nmanagement');
  const result = await normalize(text + wrapped + terminal + done);
  assert.equal(result, await normalize(text + terminal + done));
});

test('empty context metadata cannot replace terminal evidence or hide late errors', async () => {
  const finishOnly = frame({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  const usageOnly = frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  for (const body of [
    frame(metadata), text + frame(metadata) + done, text + frame(metadata) + terminal,
    text + frame(metadata) + finishOnly + done, text + frame(metadata) + usageOnly + done,
  ]) {
    await assert.rejects(normalize(body), /incomplete_stream/);
  }
  await assert.rejects(normalize(text + terminal + done + frame(metadata)), /data_after_done/);
  await assert.rejects(normalize(text + frame(metadata) + frame({ error: 'fixture' }) + terminal + done), /upstream_error_frame/);
  await assert.rejects(normalize(text + frame(metadata) + timing, { ...options, allowLegacyMetricsDone: true }), /incomplete_stream/);
});

test('only the observed empty context-management shape is accepted on Ultimate COSY', async () => {
  const invalid = [
    { ...metadata, extras: {} },
    { ...metadata, extras: { context_management: {} } },
    { ...metadata, extras: { context_management: { applied_edits: null } } },
    { ...metadata, extras: { context_management: { applied_edits: [{ type: 'clear_tool_uses' }] } } },
    { ...metadata, extras: { context_management: { applied_edits: [], unknown: true } } },
    { ...metadata, extras: { context_management: { applied_edits: [] }, unknown: true } },
    { ...metadata, unknown: true },
    { ...metadata, usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    { ...metadata, choices: null },
  ];
  for (const value of invalid) await assert.rejects(normalize(text + frame(value) + terminal + done), /invalid_choices/);
  await assert.rejects(normalize(frame({ ...metadata, error: 'fixture' })), /upstream_error_frame/);
  await assert.rejects(normalize(frame(metadata), { ...options, opaqueModelId: 'smodel' }), /invalid_choices/);
  await assert.rejects(normalize(`data: ${JSON.stringify(metadata)}\n\n`, { ...options, allowLegacyEnvelope: false }), /invalid_choices/);
});
