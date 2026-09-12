// One synthetic tool roundtrip per selected directory key. No retries or real tools.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CHAT_URL, createQoderFetch } from '../../rotom/extensions/qoder/transport.mjs';
import { readProbeCredential } from './probe-credential.mjs';

const [mode, model] = process.argv.slice(2);
const ledger = process.env.ROTOM_QODER_PROBE_LEDGER;
if (mode !== '--live' || !ledger || !process.execArgv.some(a => a.endsWith('live-budget.mjs'))) throw new Error('Explicit --live, catalog and authorized budget preload required');
const catalog = JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE, 'utf8'));
assert(catalog.pass && catalog.credentialsUnchanged && catalog.scenes.assistant.some(m => m.key === model && m.enable === true && m.source === 'system'));
const before = Number(readFileSync(ledger, 'utf8'));
const digest = () => createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');
const credentialDigest = digest();
const summary = { model, pass: false, tool: false, text: false, usage: [] };
let attempts = 0;
try {
  const transport = createQoderFetch({ modelId: model, getToken: async () => (await readProbeCredential()).accessToken });
  const tools = [{ type: 'function', function: { name: 'qoder_probe', description: 'Synthetic test echo. No external effect.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
  const messages = [{ role: 'user', content: 'Call qoder_probe exactly once with value CATALOG_OK. After receiving its result, reply exactly CATALOG_OK. This is a synthetic protocol test.' }];
  async function request(messages) {
    attempts++;
    const response = await transport(CHAT_URL, { method: 'POST', body: JSON.stringify({ model, messages, tools, stream: true, max_tokens: 256, stream_options: { include_usage: true } }) });
    const text = await response.text(); const calls = new Map(); let content = '', usage, finish;
    for (const line of text.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const chunk = JSON.parse(line.slice(6)); if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices) {
        content += choice.delta.content ?? ''; finish = choice.finish_reason ?? finish;
        for (const d of choice.delta.tool_calls ?? []) {
          const call = calls.get(d.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (d.id) call.id = d.id;
          call.function.name += d.function.name ?? ''; call.function.arguments += d.function.arguments ?? '';
          calls.set(d.index, call);
        }
      }
    }
    assert(usage);summary.usage.push(usage);
    return { content, calls: [...calls.values()], finish };
  }
  const first = await request(messages);
  assert.equal(first.finish, 'tool_calls');assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].function.name, 'qoder_probe');
  assert.deepEqual(JSON.parse(first.calls[0].function.arguments), { value: 'CATALOG_OK' });
  summary.tool = true;
  messages.push({ role: 'assistant', content: first.content || null, tool_calls: first.calls }, { role: 'tool', tool_call_id: first.calls[0].id, content: 'CATALOG_OK' });
  const second = await request(messages);
  assert.equal(second.finish, 'stop');assert.equal(second.calls.length, 0);assert.equal(second.content.trim(), 'CATALOG_OK');
  summary.text = true; summary.pass = true;
} catch (e) {
  summary.errorCode = /^[a-z0-9_]+$/.test(e.code ?? '') ? e.code : 'probe_assertion_failed';
  process.exitCode = 1;
} finally {
  summary.attempts = attempts;
  summary.requests = Number(readFileSync(ledger, 'utf8')) - before;
  summary.ledgerTotal = Number(readFileSync(ledger, 'utf8'));
  summary.credentialsUnchanged = credentialDigest === digest();
  if (summary.requests !== attempts || !summary.credentialsUnchanged) { summary.pass = false; process.exitCode = 1; }
  console.log(JSON.stringify(summary, null, 2));
}
