import assert from 'node:assert/strict';
import { realpath, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createQoderProvider, MODELS } from '../../rotom/extensions/qoder/provider.mjs';
const modelArg = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? 'lite';
const MODEL = MODELS.find(model => model.id === modelArg);
if (!MODEL) throw new Error('Unreviewed model');

// Explicit host Pi installation, resolved only through its public exports.
// No global/PATH fallback, package installation, CLI subprocess or private import.
const entry = process.env.ROTOM_PI;
if (!entry || !isAbsolute(entry) || !(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('Set ROTOM_PI to a canonical Pi executable');
if (!process.execArgv.includes('--experimental-import-meta-resolve')) throw new Error('Use node --experimental-import-meta-resolve');
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const openAI = await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions', parent));
const live = process.argv.includes('--live');
if (process.argv.slice(2).some(a => a !== '--live' && a !== `--model=${modelArg}`)) throw new Error('Only --live and --model are supported');
const nonce = randomUUID(), marker = `HOST_RESULT_${randomUUID()}`;
const parameters = piAI.Type.Object({ nonce: piAI.Type.String() }, { additionalProperties: false });
const tools = [{ name: 'rotom_probe_echo', description: 'Pure protocol-test tool. Returns a host-only marker; no side effects.', parameters }];
const context = {
  systemPrompt: 'You are a protocol test assistant. Use the provided test tool exactly as requested. Reply concisely.',
  messages: [{ role: 'user', content: `Call rotom_probe_echo exactly once with nonce ${nonce}. After the tool result, reply with exactly its text.`, timestamp: Date.now() }], tools,
};
let networkCalls = 0;
const summary = { mode: live ? 'live' : 'offline', provider: MODEL.provider, model: MODEL.id, rounds: [], toolExecutions: 0, cost: 'unknown' };
const encode = obj => `data: ${JSON.stringify(obj)}\n\n`;
const usage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, prompt_tokens_details: { cached_tokens: 10 } };
const fakeFetch = async (_url, init) => {
  networkCalls++;
  const payload = JSON.parse(init.body);
  const first = networkCalls === 1;
  if (first) assert.ok(payload.tools.some(t => t.function.name === tools[0].name));
  else assert.ok(payload.messages.some(m => m.role === 'tool' && m.content === marker));
  const delta = first ? { tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: tools[0].name, arguments: JSON.stringify({ nonce }) } }] } : { content: marker };
  const make = (d, finish = null) => ({ id: 'fixture', object: 'chat.completion.chunk', model: 'lite', choices: [{ index: 0, delta: d, finish_reason: finish }] });
  const final = JSON.stringify({ choices: [], usage, raw_usage: { private_account: 'must not escape' } });
  const at = final.indexOf('private_account') + 4;
  const wire = encode(make(delta)) + encode(make({}, 'stop')) + `data: ${final.slice(0, at)}\n${final.slice(at)}\n\n` + 'data: [DONE]\n\n';
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
};
const provider = await createQoderProvider({ piAI, openAI, ...live ? {} : { getToken: async () => 'fixture-token', fetchImpl: fakeFetch } });
async function run(options = {}) {
  const events = {};
  const stream = provider.streamSimple(MODEL, context, { maxTokens: 256, sessionId: nonce, ...options });
  for await (const event of stream) events[event.type] = (events[event.type] ?? 0) + 1;
  const result = await stream.result();
  summary.rounds.push({ stopReason: result.stopReason, events, usage: { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead }, ...(result.errorMessage ? { errorCode: result.errorMessage.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'native_stream_error' } : {}) });
  return result;
}
try {
  const first = await run({ toolChoice: 'required' });
  assert.equal(first.stopReason, 'toolUse');
  const calls = first.content.filter(c => c.type === 'toolCall');
  assert.equal(calls.length, 1); assert.equal(calls[0].name, tools[0].name); assert.deepEqual(calls[0].arguments, { nonce });
  summary.toolExecutions++;
  context.messages.push(first, { role: 'toolResult', toolCallId: calls[0].id, toolName: calls[0].name, content: [{ type: 'text', text: marker }], isError: false, timestamp: Date.now() });
  const second = await run({ toolChoice: 'none' });
  assert.equal(second.stopReason, 'stop');
  assert.equal(second.content.filter(c => c.type === 'text').map(c => c.text).join('').trim(), marker);
  assert.ok(summary.rounds.every(r => r.usage.input > 0 && r.usage.output > 0));
  summary.roundTrip = 'pass';
  const aborted = await run({ signal: AbortSignal.abort() });
  assert.equal(aborted.stopReason, 'aborted');
  summary.preAbort = 'pass';
  if (!live) assert.equal(networkCalls, 2);
  summary.pass = true;
} catch { summary.pass = false; process.exitCode = 1; }
console.log(JSON.stringify(summary, null, 2));
