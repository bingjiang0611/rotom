import test from 'node:test';
import assert from 'node:assert/strict';
import { createQoderProvider } from './provider.mjs';
import { CATALOG_URL } from './catalog-auth.mjs';
import { CHAT_URL, QODER_REASONING_FORMAT, SONUS_REASONING_FORMAT } from './transport.mjs';
import { LEGACY_URL } from './legacy.mjs';
import { decodeProbeBody } from '../../../experiments/qoder-provider/probe-wire.mjs';

const opaque = [{ type: 'reasoning.encrypted', format: QODER_REASONING_FORMAT, id: 'own-id', data: 'own-ciphertext' }];
const assistant = (patch = {}) => ({ role: 'assistant', provider: 'qoder-experimental', model: 'ultimate', api: 'qoder', stopReason: 'toolUse',
  content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(opaque) }, { type: 'text', text: 'Visible answer' }, { type: 'toolCall', id: 'call_history', name: 'probe', arguments: { n: 7 } }], ...patch });
const result = { role: 'toolResult', toolCallId: 'call_history', toolName: 'probe', content: [{ type: 'text', text: 'Saved result' }], isError: false };
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
async function fixture(id = 'ultimate') {
  const wires = []; let reads = 0;
  const p = await createQoderProvider({ authMode: 'qodercli', piAI: { createProvider: x => x, lazyStream: (_m, fn) => fn() },
    getCredential: async () => { reads++; return { accessToken: 'fixture', uid: 'fixture', org: '', machineId: 'fixture-machine', fingerprint: 'a'.repeat(64) }; },
    fetchImpl: async (url, init) => {
      if (url === CATALOG_URL) return Response.json({ assistant: [{ key: id, display_name: 'Fixture', source: 'system', enable: true, format: 'openai', max_input_tokens: 200000 }] });
      assert.equal(url, id === 'ultimate' ? LEGACY_URL : CHAT_URL);
      wires.push(id === 'ultimate' ? decodeProbeBody(init.body) : JSON.parse(init.body));
      return new Response('', { status: 403 });
    },
  });
  await p.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async p => { p.update?.(); return true; } }); reads = 0;
  const model = p.getModels()[0];
  return { wires, reads: () => reads, run: (messages, options = {}, method = 'streamSimple') => p.api[method](model, { messages }, options) };
}

for (const id of ['ultimate', 'gmodel', 'lite']) for (const source of [{ provider: 'foreign' }, { model: 'smodel' }, { api: 'other-api' }]) test(`${id}: foreign identity ${Object.keys(source)[0]} strips opaque/tool signatures without editing history`, async () => {
  const f = await fixture(id);
  const prior = assistant(source);
  prior.content[0].thinkingSignature = 'FOREIGN_OPAQUE_NOT_JSON';
  prior.content[2].thoughtSignature = 'FOREIGN_TOOL_SIGNATURE';
  prior.content.push({ type: 'thinking', thinking: 'Visible reasoning', thinkingSignature: 'FOREIGN_SIGNED_REASONING' }, { type: 'thinking', thinking: 'FOREIGN_REDACTED', redacted: true, thinkingSignature: 'FOREIGN_REDACTED_SIGNATURE' });
  const messages = freeze([prior, structuredClone(result)]), original = JSON.stringify(messages);
  await assert.rejects(f.run(messages), { code: 'http_403' });
  assert.equal(f.wires.length, 1); assert.equal(f.reads(), 1); assert.equal(JSON.stringify(messages), original);
  const wire = f.wires[0], text = JSON.stringify(wire);
  assert.doesNotMatch(text, /FOREIGN_|reasoning_item|reasoning_details|reasoning_content|thoughtSignature|thinkingSignature/);
  const sent = wire.messages.find(m => m.role === 'assistant');
  assert.equal(sent.content, 'Visible answerVisible reasoning');
  assert.deepEqual(sent.tool_calls, [{ id: 'call_history', type: 'function', function: { name: 'probe', arguments: '{"n":7}' } }]);
  assert.equal(wire.messages.find(m => m.role === 'tool').tool_call_id, 'call_history');
  assert.equal(wire.messages.find(m => m.role === 'tool').content, 'Saved result');
});

for (const method of ['streamSimple', 'stream']) test(`${method}: mixed foreign and own opaque history preserves only own signature verbatim`, async () => {
  const f = await fixture();
  const foreign = assistant({ provider: 'foreign', stopReason: 'stop', content: [{ type: 'thinking', thinking: '', thinkingSignature: 'FOREIGN_SECRET' }, { type: 'text', text: 'Earlier answer' }] });
  const own = assistant(), messages = freeze([foreign, own, structuredClone(result)]), before = JSON.stringify(messages);
  await assert.rejects(f.run(messages, {}, method), { code: 'http_403' });
  assert.equal(JSON.stringify(messages), before);
  const sent = f.wires[0].messages.filter(m => m.role === 'assistant');
  assert.equal(sent[0].reasoning_item, undefined);
  assert.deepEqual(sent[1].reasoning_item, { id: 'own-id', encrypted_content: 'own-ciphertext' });
  assert.doesNotMatch(JSON.stringify(f.wires), /FOREIGN_SECRET/);
});

for (const content of [
  [{ type: 'thinking', thinking: '', thinkingSignature: 'INVALID' }],
  [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify([{ ...opaque[0], format: SONUS_REASONING_FORMAT }]) }],
  [{ type: 'toolCall', id: 'call_history', name: 'probe', arguments: {}, thoughtSignature: 'UNSUPPORTED' }],
]) test('same-model malformed, foreign-format or tool signatures still fail before credentials and dispatch', async () => {
  const f = await fixture(); await assert.rejects(f.run([assistant({ content })]), { code: 'opaque_reasoning_replay_unsupported' });
  assert.equal(f.reads(), 0); assert.equal(f.wires.length, 0);
});

for (const role of ['user', 'toolResult']) test(`${role}: signed thinking is not eligible for foreign-assistant conversion`, async () => {
  const f = await fixture();
  await assert.rejects(f.run([{ ...assistant({ provider: 'foreign' }), role }]), { code: 'opaque_reasoning_replay_unsupported' });
  assert.equal(f.reads(), 0); assert.equal(f.wires.length, 0);
});

test('foreign signature conversion does not bypass image or post-hook wire gates', async () => {
  const f = await fixture();
  const prior = assistant({ provider: 'foreign' });
  prior.content.push({ type: 'image', mimeType: 'image/png', data: 'invalid' });
  await assert.rejects(f.run([prior]), { code: 'images_not_validated' });
  await assert.rejects(f.run([assistant({ provider: 'foreign' }), result], { onPayload(payload) {
    payload.messages.find(m => m.role === 'assistant').reasoning_details = [{ ...opaque[0], format: 'foreign-format' }];
  } }), { code: 'opaque_reasoning_replay_unsupported' });
  assert.equal(f.reads(), 0); assert.equal(f.wires.length, 0);
});
