// Maintenance-only raw protocol probes. Does not register unvalidated models.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readLocalCredential } from '../../rotom/extensions/qoder/auth.mjs';
import { CHAT_URL, normalizeSSE } from '../../rotom/extensions/qoder/transport.mjs';
if (!process.env.ROTOM_QODER_PROBE_LEDGER || !process.execArgv.includes('--import')) throw new Error('Use live-budget.mjs preload');
const models = process.argv.slice(2);
if (!models.length || models.some(m => !['lite', 'efficient', 'performance', 'auto', 'ultimate'].includes(m))) throw new Error('Explicit reviewed model tiers required');
for (const model of models) {
  const summary = { model, mode: 'text', cost: 'unknown' };
  try {
    const credential = await readLocalCredential({ authDir: process.env.ROTOM_QODER_AUTH_DIR });
    const marker = `PROBE_${randomUUID()}`;
    const requestId = randomUUID();
    const response = await fetch(CHAT_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, stream: true, max_tokens: 256, reasoning_effort: 'none', enable_thinking: false,
        messages: [{ role: 'user', content: `Reply exactly ${marker}.` }],
        metadata: { context: { request_id: requestId, request_set_id: requestId, session_id: requestId, task_id: 'common', client_type: 'rotom' } },
      }),
    });
    summary.httpStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
    let text = '';
    for await (const frame of normalizeSSE(response.body)) {
      if (frame === 'data: [DONE]\n\n') continue;
      const data = JSON.parse(frame.slice(6));
      text += data.choices[0]?.delta?.content ?? '';
      if (data.usage) summary.usage = data.usage;
    }
    assert.equal(text.trim(), marker); summary.pass = true;
  } catch (e) {
    summary.pass = false; summary.errorCode = e.code === 'ERR_ASSERTION' ? 'answer_mismatch' : /^http_\d+$/.test(e.message) ? e.message : e.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1] ?? 'probe_failed';
    process.exitCode = 1;
  }
  console.log(JSON.stringify(summary));
  if (!summary.pass) break;
}
