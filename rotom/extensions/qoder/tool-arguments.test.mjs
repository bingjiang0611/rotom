import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../runtime/pi/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import * as piAI from '../../runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js';
import { createQoderProvider, MODEL } from './provider.mjs';
import { qoderChunks } from './transport.mjs';
import { translateQoderStream } from './translate.mjs';

const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const tool = (id, args) => ({ index: 0, id, type: 'function', function: { name: 'context_status', ...(args === undefined ? {} : { arguments: args }) } });
const ending = frame(chunk({}, 'tool_calls')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n';

async function translate(wire, options = {}) {
  const events = [];
  for await (const event of translateQoderStream(qoderChunks(new Response(wire).body, { toolNames: ['context_status'], ...options }), MODEL)) events.push(event);
  return events;
}

test('omitted, empty and whitespace arguments become empty objects on direct and COSY streams', async () => {
  for (const legacy of [false, true]) {
    const emit = value => frame(legacy ? { statusCodeValue: 200, body: JSON.stringify(value) } : value);
    for (const args of [undefined, '', ' \n\t\r']) {
      const wire = emit(chunk({ tool_calls: [tool('call_empty', args)] })) + emit(chunk({}, 'tool_calls')) + emit({ choices: [], usage }) + 'data: [DONE]\n\n';
      const events = await translate(wire, { allowLegacyEnvelope: legacy });
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.at(-1).reason, 'toolUse');
      assert.deepEqual(events.at(-1).message.content, [{ type: 'toolCall', id: 'call_empty', name: 'context_status', arguments: {} }]);
      assert.equal(events.filter(e => e.type === 'toolcall_end').length, 1);
    }
  }
});

test('Ultimate serial index-zero calls preserve empty predecessors without merging identities', async () => {
  for (const legacy of [false, true]) {
    const emit = value => frame(legacy ? { statusCodeValue: 200, body: JSON.stringify(value) } : value);
    const wire = [tool('call_first', ''), tool('call_second', ' \t'), tool('call_third', '{"offset":1}')]
      .map(call => emit(chunk({ tool_calls: [call] }))).join('') + emit(chunk({}, 'tool_calls')) + emit({ choices: [], usage }) + 'data: [DONE]\n\n';
    const events = await translate(wire, { allowLegacyEnvelope: legacy, allowOpaqueReasoning: true, opaqueModelId: 'ultimate' });
    assert.equal(events.at(-1).type, 'done');
    const calls = events.at(-1).message.content;
    assert.deepEqual(calls.map(call => call.id), ['call_first', 'call_second', 'call_third']);
    assert.deepEqual(calls.map(call => call.arguments), [{}, {}, { offset: 1 }]);
  }
});

test('empty arguments still require finish, usage, DONE and a clean stream', async () => {
  const start = frame(chunk({ tool_calls: [tool('call_empty', '')] }));
  for (const [suffix, code] of [
    [frame({ choices: [], usage }) + 'data: [DONE]\n\n', 'incomplete_stream'],
    [frame(chunk({}, 'tool_calls')) + 'data: [DONE]\n\n', 'incomplete_stream'],
    [frame(chunk({}, 'tool_calls')) + frame({ choices: [], usage }), 'incomplete_stream'],
    [ending + frame(chunk({ content: 'late' })), 'data_after_done'],
  ]) {
    const events = await translate(start + suffix);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).error.errorMessage, `Qoder: ${code}`);
    assert.ok(!events.some(event => event.type === 'toolcall_end' || event.type === 'done'));
  }
});

test('invalid tool arguments stay rejected with only structural diagnostics', async () => {
  for (const [args, reason] of [
    ['{"PRIVATE_VALUE":"秘密"', 'invalid_json'],
    ['{} trailing_PRIVATE_VALUE', 'invalid_json'], ['\uFEFF{}', 'invalid_json'],
    ['null', 'non_object'], ['[]', 'non_object'], ['"PRIVATE_VALUE"', 'non_object'], ['1', 'non_object'],
  ]) {
    const diagnostics = [];
    const wire = frame(chunk({ tool_calls: [tool('PRIVATE_ID', args)] })) + ending;
    const events = await translate(wire, { onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).error.errorMessage, 'Qoder: invalid_tool_arguments');
    assert.ok(!events.some(event => event.type === 'toolcall_end' || event.type === 'done'));
    assert.deepEqual(diagnostics, [{ code: 'invalid_tool_arguments', reason, argumentBytes: Buffer.byteLength(args) }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_|秘密/);
  }
  for (const onDiagnostic of [() => { throw new Error('PRIVATE_LISTENER'); }, async () => { throw new Error('PRIVATE_LISTENER'); }]) {
    const events = await translate(frame(chunk({ tool_calls: [tool('call_bad', '{')] })) + ending, { onDiagnostic });
    assert.equal(events.at(-1).error.errorMessage, 'Qoder: invalid_tool_arguments');
  }
});

for (const required of [false, true]) {
  test(`native agent ${required ? 'rejects missing required arguments without executing' : 'executes an optional-argument tool once and continues'}`, async () => {
    let requests = 0, executions = 0;
    const provider = await createQoderProvider({
      piAI, authMode: 'qodercli', getToken: async () => 'fixture',
      fetchImpl: async (_url, init) => {
        requests++;
        if (requests === 1) return new Response(frame(chunk({ tool_calls: [tool('call_empty', ' \t\n')] })) + ending, { headers: { 'content-type': 'text/event-stream' } });
        assert.equal(requests, 2);
        const result = JSON.parse(init.body).messages.find(message => message.role === 'tool');
        assert.ok(result);
        if (required) assert.match(result.content, /command/);
        else assert.equal(result.content, 'fixture tool result');
        return new Response(frame(chunk({ content: 'finished' }, 'stop')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const agent = new Agent({
      initialState: {
        model: MODEL,
        tools: [{
          name: 'context_status', label: 'fixture', description: 'fixture',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, ...(required ? { required: ['command'] } : {}), additionalProperties: false },
          execute: async (_id, args) => {
            executions++;
            assert.deepEqual(args, {});
            return { content: [{ type: 'text', text: 'fixture tool result' }], details: {} };
          },
        }],
      },
      streamFn: (model, context, options) => provider.streamSimple(model, context, options),
    });
    await agent.prompt('fixture');
    assert.equal(requests, 2, JSON.stringify(agent.state.messages.at(-1)));
    assert.equal(executions, required ? 0 : 1);
    const result = agent.state.messages.find(message => message.role === 'toolResult');
    assert.equal(result.isError, required);
    assert.equal(agent.state.messages.at(-1).stopReason, 'stop');
    assert.equal(agent.state.messages.at(-1).content[0].text, 'finished');
  });
}
