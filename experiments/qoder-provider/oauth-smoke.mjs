// Offline only. Public Pi runtime + real private auth.json, synthetic HTTP.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createQoderProvider, MODEL, PROVIDER_ID } from '../../rotom/extensions/qoder/provider.mjs';
import { createRefreshGuard } from '../../rotom/extensions/qoder/refresh-guard.mjs';

if (process.argv.length !== 2) throw new Error('Offline only: no arguments supported');
const entry = process.env.ROTOM_PI;
if (!entry || !isAbsolute(entry) || !(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('Set canonical ROTOM_PI');
if (!process.execArgv.includes('--experimental-import-meta-resolve')) throw new Error('Use --experimental-import-meta-resolve');
const parent = pathToFileURL(entry).href;
const piAI = await import(import.meta.resolve('@earendil-works/pi-ai', parent));
const pi = await import(import.meta.resolve('@earendil-works/pi-coding-agent', parent));
const openAI = await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions', parent));
const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-oauth-smoke-')));
const authPath = join(dir, 'auth.json');
let polls = 0, refreshes = 0, profiles = 0, chats = 0;
const json = value => new Response(JSON.stringify(value));
const authFetch = async (url, init) => {
  const path = new URL(url).pathname;
  assert.equal(new URL(url).origin, 'https://openapi.qoder.sh');
  assert.equal(init.redirect, 'error');
  if (path === '/api/v1/userinfo') { profiles++; return json({ id: 'synthetic-user', organization_id: 'synthetic-org' }); }
  if (path === '/api/v1/deviceToken/poll') {
    polls++; return json({ token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, refresh_token_expires_in: 86400, user_id: 'synthetic-user' });
  }
  assert.equal(path, '/api/v1/deviceToken/refresh'); refreshes++;
  return json({ device_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh', expires_in: 3600, refresh_token_expires_in: 86400 });
};
const chatFetch = async (_url, init) => {
  chats++;
  assert.equal(init.headers.Authorization, 'Bearer synthetic-rotated');
  const frame = d => `data: ${JSON.stringify(d)}\n\n`;
  return new Response(frame({ choices: [{ index: 0, delta: { content: 'fixture-ok' }, finish_reason: null }] }) +
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
async function runtime() {
  const provider = await createQoderProvider({ piAI, openAI, authMode: 'browser', fetchImpl: chatFetch,
    getCredential: () => assert.fail('CLI credentials accessed'),
    oauthOptions: { fetchImpl: authFetch, claimRefresh: createRefreshGuard(dir) } });
  const runtime = await pi.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(provider);
  return runtime;
}
try {
  const first = await runtime(); const events = [];
  assert.equal(await first.getAuth(PROVIDER_ID), undefined);
  await first.login(PROVIDER_ID, 'oauth', { notify: e => events.push(e), prompt: () => assert.fail('no secret prompts') });
  assert.equal(events.some(e => e.type === 'auth_url'), true);
  assert.equal((await lstat(authPath)).mode & 0o777, 0o600);
  const data = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(data[PROVIDER_ID].access, 'synthetic-access');
  assert.equal(polls, 1);
  const originalFingerprint = data[PROVIDER_ID].fingerprint;
  data[PROVIDER_ID].expires = 0;
  await writeFile(authPath, JSON.stringify(data), { mode: 0o600 });
  const restored = await runtime();
  const auth = await Promise.all([restored.getAuth(PROVIDER_ID), restored.getAuth(PROVIDER_ID)]);
  assert.equal(refreshes, 1);
  assert.equal(auth.every(a => a.auth.apiKey.startsWith('rotom-qoder-v1.')), true);
  const updated = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(updated[PROVIDER_ID].refresh, 'synthetic-rotated-refresh');
  assert.equal(updated[PROVIDER_ID].fingerprint, originalFingerprint);
  const restarted = await runtime();
  const result = await restarted.complete(MODEL, { messages: [{ role: 'user', content: 'Synthetic fixture', timestamp: Date.now() }] });
  assert.equal(result.stopReason, 'stop'); assert.equal(chats, 1);
  await restarted.logout(PROVIDER_ID);
  assert.equal(await restarted.getAuth(PROVIDER_ID), undefined);
  assert.equal(refreshes, 1); assert.equal(profiles, 2);
  console.log(JSON.stringify({ mode: 'offline', pass: true, login: true, diskResume: true, serializedRefresh: true, sealedDispatch: true, logout: true, polls, refreshes, profiles, chats }));
} finally { await rm(dir, { recursive: true, force: true }); }
