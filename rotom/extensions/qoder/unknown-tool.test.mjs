import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../runtime/pi/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import * as piAI from '../../runtime/pi/node_modules/@earendil-works/pi-ai/dist/index.js';
import { createQoderProvider, MODEL } from './provider.mjs';
import { qoderChunks } from './transport.mjs';
import { translateQoderStream } from './translate.mjs';

const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const response = wire => new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const call = (name, id, index = 0) => ({ index, id, type: 'function', function: { name, arguments: '{"value":"fixture"}' } });
const ending = frame(chunk({}, 'tool_calls')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n';

// Reproduce a real dfmodel response spelling codemode as codemod. Preserve the
// spelling: only Pi's exact-name dispatcher may decide whether to execute it.
test('unknown tool names survive direct and COSY translation unchanged', async () => {
  for (const legacy of [false, true]) {
    const emit = value => frame(legacy ? { statusCodeValue: 200, body: JSON.stringify(value) } : value);
    const wire = emit(chunk({ tool_calls: [call('codemod', 'call_typo')] })) + emit(chunk({}, 'tool_calls')) + emit({ choices: [], usage }) + 'data: [DONE]\n\n';
    for (const toolNames of [[], ['codemode']]) {
      const events = [];
      const chunks = qoderChunks(new Response(wire).body, { toolNames, allowLegacyEnvelope: legacy });
      for await (const event of translateQoderStream(chunks, MODEL)) events.push(event);
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.at(-1).reason, 'toolUse');
      assert.deepEqual(events.at(-1).message.content, [{ type: 'toolCall', id: 'call_typo', name: 'codemod', arguments: { value: 'fixture' } }]);
    }
  }
});

for (const scenario of ['typo', 'mixed batch', 'late error']) {
  test(`native agent handles unknown tools without aliases or replay: ${scenario}`, async () => {
    const mixed = scenario !== 'typo';
    const lateError = scenario === 'late error';
    let requests = 0;
    const executions = [];
    const provider = await createQoderProvider({
      piAI, authMode: 'qodercli', getToken: async () => 'fixture',
      fetchImpl: async (_url, init) => {
        requests++;
        assert.ok(requests <= 3, 'unexpected extra model request');
        const payload = JSON.parse(init.body);
        assert.equal(payload.model, MODEL.id);
        assert.deepEqual(payload.tools.map(tool => tool.function.name), ['codemode', 'echo']);
        if (requests === 1) {
          const calls = [call('codemod', 'call_typo')];
          if (mixed) calls.push(call('echo', 'call_valid', 1));
          return response(frame(chunk({ tool_calls: calls })) + ending + (lateError ? frame(chunk({ content: 'late' })) : ''));
        }
        const results = payload.messages.filter(message => message.role === 'tool');
        const typo = results.find(result => result.tool_call_id === 'call_typo');
        assert.ok(typo);
        assert.match(typo.content, /Tool codemod not found/);
        assert.equal(payload.messages.find(message => message.tool_calls)?.tool_calls[0].function.name, 'codemod');
        if (requests === 2) {
          assert.deepEqual(executions, mixed ? ['call_valid'] : []);
          assert.equal(results.length, mixed ? 2 : 1);
          return response(frame(chunk({ tool_calls: [call('codemode', 'call_corrected')] })) + ending);
        }
        assert.deepEqual(executions, mixed ? ['call_valid', 'call_corrected'] : ['call_corrected']);
        assert.equal(results.find(result => result.tool_call_id === 'call_corrected').content, 'fixture result');
        return response(frame(chunk({ content: 'finished' }, 'stop')) + frame({ choices: [], usage }) + 'data: [DONE]\n\n');
      },
    });
    const agent = new Agent({
      initialState: {
        model: MODEL,
        tools: ['codemode', 'echo'].map(name => ({
          name, label: name, description: 'fixture',
          parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          execute: async (id, args) => {
            executions.push(id);
            assert.deepEqual(args, { value: 'fixture' });
            return { content: [{ type: 'text', text: 'fixture result' }], details: {} };
          },
        })),
      },
      streamFn: (model, context, options) => provider.streamSimple(model, context, options),
    });
    await agent.prompt('fixture');
    const last = agent.state.messages.at(-1);
    assert.equal(requests, lateError ? 1 : 3, JSON.stringify(last));
    if (lateError) {
      assert.deepEqual(executions, []);
      assert.equal(last.stopReason, 'error');
      assert.equal(last.errorMessage, 'Qoder: data_after_done');
      assert.ok(!agent.state.messages.some(message => message.role === 'toolResult'));
    } else {
      const error = agent.state.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'call_typo');
      assert.equal(error.isError, true);
      assert.equal(error.details.code, 'tool_not_found');
      assert.equal(last.stopReason, 'stop');
      assert.equal(last.content[0].text, 'finished');
    }
  });
}
