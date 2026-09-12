// Bounded maintenance reconnaissance; no CLI, refresh, fallback endpoint or retry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CATALOG_URL, catalogHeaders } from '../../rotom/extensions/qoder/catalog-auth.mjs';
import { readProbeCredential } from './probe-credential.mjs';

const focusReasoning = process.argv.slice(2).join(' ') === '--live --focus-reasoning';
const cliVersion = process.argv.slice(2).join(' ') === '--live --cli-version';
const legacyVersion = process.argv.slice(2).join(' ') === '--live --legacy-version';
if (process.argv.slice(2).join(' ') !== '--live' && !focusReasoning && !cliVersion && !legacyVersion) throw new Error('Explicit --live and fresh authorized ledger required');
const ledger = process.env.ROTOM_QODER_PROBE_LEDGER;
if (!ledger || process.env.ROTOM_QODER_PROBE_CATALOG !== '1' || !process.execArgv.some(a => a.endsWith('live-budget.mjs'))) throw new Error('Budget preload required');
const before = Number(readFileSync(ledger, 'utf8'));
const digest = () => createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');
let credentialDigest, attempted = false;
const summary = { mode: 'live', scope: 'catalog', pass: false };
try {
  credentialDigest = digest();
  const c = await readProbeCredential();
  const headers = catalogHeaders(c);
  if (legacyVersion) headers['Cosy-Version'] = '1.0.0';
  if (cliVersion) headers['Cosy-Version'] = '1.1.45';
  summary.compatVersion = headers['Cosy-Version'];
  attempted = true;
  const signal = AbortSignal.timeout(15000);
  const response = await fetch(CATALOG_URL, { method: 'GET', redirect: 'error', headers, signal });
  summary.httpStatus = response.status;
  if (!response.ok) { void response.body?.cancel(); throw new Error('catalog_http_error'); }
  let size = 0; const chunks = [];
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 512 * 1024) throw new Error('catalog_oversized');
    chunks.push(bytes);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  summary.sceneKeys = Object.keys(body).filter(k => /^[a-z_]{1,40}$/.test(k));
  const allowed = ['key','display_name','enable','source','format','is_vl','is_reasoning','max_input_tokens','max_output_tokens','available_context_windows','default_context_window','efforts','thinking_config','context_config','price_factor','original_price_factor','is_free'];
  summary.scenes = {};
  for (const scene of ['assistant','chat']) if (Array.isArray(body[scene])) {
    summary.scenes[scene] = body[scene].filter(e => (!e.source || e.source === 'system') && (!focusReasoning || ['ultimate','dfmodel'].includes(e.key))).map(e => {
      const selected = Object.fromEntries(allowed.filter(k => k in e).map(k => [k,e[k]]));
      if (focusReasoning) {
        const ids = obj => Object.fromEntries(['model','provider','source','server_scene'].filter(k => typeof obj?.[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(obj[k])).map(k => [k,obj[k]]));
        selected.routing = ids(e); selected.serverModel = ids(e.server_model);
        selected.serverModelKeys = e.server_model && typeof e.server_model === 'object' ? Object.keys(e.server_model).filter(k => /^[a-z_]{1,48}$/.test(k)).slice(0,24) : [];
      }
      return selected;
    });
  }
  assert.equal(Object.keys(summary.scenes).length > 0, true);
  summary.pass = true;
} catch (e) {
  summary.errorCode = /^[a-z_]+$/.test(e.code ?? '') ? e.code : 'catalog_probe_failed';
  process.exitCode = 1;
} finally {
  summary.requests = Number(readFileSync(ledger, 'utf8')) - before;
  summary.ledgerTotal = Number(readFileSync(ledger, 'utf8'));
  summary.credentialsUnchanged = credentialDigest ? credentialDigest === digest() : null;
  if (summary.requests !== (attempted ? 1 : 0) || summary.credentialsUnchanged === false) { summary.pass = false; process.exitCode = 1; }
  console.log(JSON.stringify(summary, null, 2));
}
