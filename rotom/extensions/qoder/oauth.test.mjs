import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, readdir, stat, symlink, mkdir, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createBrowserOAuth, createOAuthEnvelope, AUTH_ORIGIN, LOGIN_URL, DEVICE_CLIENT_ID } from './oauth.mjs';
import { createRefreshGuard } from './refresh-guard.mjs';
import { createQoderProvider, MODEL } from './provider.mjs';

const NOW = Date.now();
const tokens = (overrides = {}) => ({ token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, refresh_token_expires_in: 86400, user_id: 'fixture-user', ...overrides });
const user = (overrides = {}) => ({ id: 'fixture-user', organization_id: 'fixture-org', ...overrides });
const response = data => new Response(JSON.stringify(data));
function harness({ replies = [tokens(), user()], ...options } = {}) {
  const calls = [], events = [];
  const oauth = createBrowserOAuth({ now: () => NOW, sleep: async () => {}, ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, AUTH_ORIGIN);
    assert.equal(init.redirect, 'error');
    const reply = replies.shift();
    if (typeof reply === 'function') return reply(url, init);
    if (reply instanceof Error) throw reply;
    assert.notEqual(reply, undefined, 'unexpected request');
    return reply instanceof Response ? reply : response(reply);
  } });
  return { oauth, calls, events, login: signal => oauth.login({ signal, notify: e => events.push(e) }) };
}
async function temp(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rotom-qoder-oauth-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('browser login uses independent PKCE, verifies account, stores only allowlisted fields', async () => {
  const h = harness({ replies: [new Response(null, { status: 404 }), tokens({ private_server_field: 'PRIVATE' }), user()] });
  const c = await h.login();
  assert.equal(c.type, 'oauth'); assert.equal(c.access, 'fixture-access'); assert.equal(c.org, 'fixture-org');
  assert.equal(c.expires, NOW + 3540000); assert.match(c.fingerprint, /^[a-f0-9]{64}$/);
  const auth = new URL(h.events.find(e => e.type === 'auth_url').url);
  assert.equal(auth.origin + auth.pathname, LOGIN_URL); assert.equal(auth.searchParams.get('client_id'), DEVICE_CLIENT_ID);
  const poll = new URL(h.calls[0].url);
  const verifier = poll.searchParams.get('verifier');
  assert.equal(verifier.length, 43);
  assert.equal(auth.searchParams.get('challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(auth.searchParams.get('nonce'), poll.searchParams.get('nonce'));
  assert.equal(auth.searchParams.get('machine_id'), c.machineId);
  assert.equal(auth.searchParams.has('verifier'), false);
  assert.equal(h.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(h.events), /fixture-access|fixture-refresh|PRIVATE/);
  assert.doesNotMatch(JSON.stringify(c), /private_server_field/);
  assert.equal(h.calls[2].init.headers.Authorization, 'Bearer fixture-access');
  const another = await harness().login();
  assert.notEqual(another.machineId, c.machineId);
  assert.notEqual(another.fingerprint, c.fingerprint, 'fresh login does not silently migrate a session');
});

test('request envelope seals legacy identity with the token before caller mutation',async()=>{
  const c=await harness().login(),expected={uid:c.uid,org:c.org,machineId:c.machineId};
  const envelope=createOAuthEnvelope({now:()=>NOW}),pending=envelope.toAuth(c);
  c.uid='changed-user';c.org='changed-org';c.machineId='changed-machine';
  const auth=await pending,decoded=envelope.read(auth.apiKey);
  assert.deepEqual({uid:decoded.uid,org:decoded.org,machineId:decoded.machineId},expected);
  assert.equal(decoded.accessToken,'fixture-access');assert.doesNotMatch(auth.apiKey,/fixture-user|fixture-org|fixture-access/);
});

for (const [name, reply, code] of [
  ['HTTP rejection', new Response('PRIVATE', { status: 403 }), 'oauth_http_403'],
  ['redirect', new Response(null, { status: 302 }), 'oauth_http_302'],
  ['network ambiguity', new Error('PRIVATE verifier/token'), 'oauth_request_unknown'],
  ['malformed JSON', new Response('PRIVATE'), 'oauth_response_invalid'],
  ['oversized response', new Response('X'.repeat(65537)), 'oauth_response_oversized'],
  ['missing access', tokens({ token: '' }), 'oauth_response_invalid'],
  ['unsafe token', tokens({ token: 'bad\r\nvalue' }), 'oauth_response_invalid'],
  ['missing expiry', tokens({ expires_in: undefined }), 'oauth_expiry_invalid'],
  ['expired token', tokens({ expires_in: 30 }), 'oauth_expiry_invalid'],
  ['bad absolute expiry', tokens({ expires_at: 'not-a-date' }), 'oauth_expiry_invalid'],
  ['missing refresh expiry', tokens({ refresh_token_expires_in: undefined }), 'oauth_expiry_invalid'],
]) test(`login rejects ${name}, sanitized and without retry`, async () => {
  const h = harness({ replies: [reply] });
  await assert.rejects(h.login(), e => e.code === code && !e.message.includes('PRIVATE'));
  assert.equal(h.calls.length, 1);
});

test('userinfo is required and must match token identity', async () => {
  for (const u of [user({ id: 'different-user' }), {}, user({ organization_id: [] })]) {
    const h = harness({ replies: [tokens(), u] });
    await assert.rejects(h.login(), /oauth_identity/); assert.equal(h.calls.length, 2);
  }
});

test('abort before login does not notify or dispatch; abort while polling stops promptly', async () => {
  const h = harness();
  await assert.rejects(h.login(AbortSignal.abort()), { code: 'oauth_aborted' });
  assert.equal(h.calls.length, 0); assert.equal(h.events.length, 0);
  const controller = new AbortController();
  const pending = harness({ replies: [(_url, _init) => { controller.abort(); return new Promise(() => {}); }] });
  await assert.rejects(pending.login(controller.signal), { code: 'oauth_aborted' });
  assert.equal(pending.calls.length, 1);
});

test('refresh verifies same account and preserves fingerprint through token rotation', async () => {
  const c = await harness().login(); const claims = [];
  const h = harness({ claimRefresh: async token => claims.push(token), replies: [tokens({ token: undefined, device_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh' }), user()] });
  const next = await h.oauth.refresh(c);
  assert.deepEqual(claims, ['fixture-refresh']); assert.equal(next.fingerprint, c.fingerprint);
  assert.equal(next.machineId, c.machineId); assert.equal(next.access, 'fixture-new-access');
  assert.equal(next.refresh, 'fixture-new-refresh');
  assert.equal(new URL(h.calls[0].url).pathname, '/api/v1/deviceToken/refresh');
  assert.equal(h.calls[0].init.body, JSON.stringify({ refresh_token: c.refresh }));
});

test('refresh cannot replay unknown outcome across reconstructed guards or processes', async t => {
  const dir = await temp(t); const c = await harness().login();
  const h = harness({ claimRefresh: createRefreshGuard(dir), replies: [new Error('PRIVATE')] });
  await assert.rejects(h.oauth.refresh(c), { code: 'oauth_refresh_unproven_login_required' });
  const next = harness({ claimRefresh: createRefreshGuard(dir) });
  await assert.rejects(next.oauth.refresh(c), { code: 'oauth_refresh_already_attempted_login_required' });
  assert.equal(h.calls.length, 1); assert.equal(next.calls.length, 0);
  const child = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {createRefreshGuard} from ${JSON.stringify(new URL('./refresh-guard.mjs', import.meta.url).href)};
     try { await createRefreshGuard(process.argv[1])('fixture-refresh'); process.exit(2); }
     catch(e) { if (e.code !== 'oauth_refresh_already_attempted_login_required') process.exit(3); }`, dir]);
  assert.equal(child.length, 0);
  const files = await readdir(join(dir, 'qoder-refresh-attempts'));
  assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}$/);
  const file = join(dir, 'qoder-refresh-attempts', files[0]);
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await readFile(file)).length, 0);
});

test('refresh claims are exclusive, private, canonical, and refuse symlink directories', async t => {
  const dir = await temp(t);
  const results = await Promise.allSettled([createRefreshGuard(dir)('fixture'), createRefreshGuard(dir)('fixture')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const alias = join(dir, 'alias'); await symlink(dir, alias);
  await assert.rejects(createRefreshGuard(alias)('other'), /guard_unavailable/);
  const root = await temp(t), destination = await temp(t);
  await symlink(destination, join(root, 'qoder-refresh-attempts'));
  await assert.rejects(createRefreshGuard(root)('other'), /guard_unavailable/);
  const root2 = await temp(t); await mkdir(join(root2, 'qoder-refresh-attempts'));
  await chmod(join(root2, 'qoder-refresh-attempts'), 0o755);
  await assert.rejects(createRefreshGuard(root2)('other'), /guard_unavailable/);
});

test('refresh fail-closed on nonrotation, account change, expiry or missing durable guard', async () => {
  const c = await harness().login();
  for (const replies of [[tokens()], [tokens({ refresh_token: 'new-refresh' }), user({ id: 'different' })]]) {
    const h = harness({ replies, claimRefresh: async () => {} });
    await assert.rejects(h.oauth.refresh(c), /refresh_unproven_login_required/);
  }
  const h = harness();
  await assert.rejects(h.oauth.refresh(c), /guard_unavailable/);
  await assert.rejects(h.oauth.refresh({ ...c, refreshExpires: NOW }), /login_required/);
  await assert.rejects(h.oauth.refresh(c, AbortSignal.abort()), /oauth_aborted/);
  assert.equal(h.calls.length, 0);
});

test('sealed request auth rejects override, mutation, cross-instance replay and expiry', async () => {
  const c = await harness().login(); let now = NOW;
  const envelope = createOAuthEnvelope({ now: () => now });
  const { apiKey } = await envelope.toAuth(c);
  assert.doesNotMatch(apiKey, /fixture-access|fixture-refresh/);
  assert.equal(envelope.read(apiKey).accessToken, c.access);
  assert.equal(envelope.read(apiKey).fingerprint, c.fingerprint);
  assert.throws(() => envelope.read('raw-token'), /request_auth_invalid/);
  const at = 45; assert.throws(() => envelope.read(apiKey.slice(0, at) + (apiKey[at] === 'A' ? 'B' : 'A') + apiKey.slice(at + 1)), /request_auth_invalid/);
  assert.throws(() => createOAuthEnvelope().read(apiKey), /request_auth_invalid/);
  await assert.rejects(envelope.toAuth({ ...c, fingerprint: 'a'.repeat(64) }), /credential_invalid/);
  now = c.expires; assert.throws(() => envelope.read(apiKey), /login_required/);
});

test('browser provider integrates dispatch binding without CLI reads or raw token overrides', async () => {
  const c = await harness().login(); let network = 0; const bindings = [];
  const provider = await createQoderProvider({ authMode: 'browser',
    piAI: { createProvider: p => p, lazyStream: (_m, setup) => setup() },
    getCredential: () => assert.fail('CLI read'), getToken: () => assert.fail('CLI token'),
    captureBinding: () => fp => bindings.push(fp),
    fetchImpl: async (_url, init) => { network++; assert.equal(init.headers.Authorization ?? init.headers.authorization, `Bearer ${c.access}`); return new Response(null, { status: 403 }); },
  });
  assert.equal(provider.auth.apiKey, undefined); assert.equal(network, 0);
  const auth = await provider.auth.oauth.toAuth(c);
  assert.equal(bindings.length, 0);
  // The binding is captured during credential resolution, before the eager
  // http_403 rejection; a raw apiKey override never resolves and never dispatches.
  await assert.rejects(provider.api.streamSimple(MODEL, { messages: [] }, auth), { code: 'http_403' });
  assert.deepEqual(bindings, [c.fingerprint]); assert.equal(network, 1);
  await assert.rejects(provider.api.streamSimple(MODEL, { messages: [] }, { apiKey: 'malicious-override' }));
  assert.equal(network, 1); assert.equal(bindings.length, 1);
});

test('invalid auth mode fails closed without imports or network', async () => {
  await assert.rejects(createQoderProvider({ authMode: '' }), /invalid_auth_mode/);
});

test('default auth mode is browser and never reaches the CLI credential source', async () => {
  const saved = process.env.ROTOM_QODER_AUTH; delete process.env.ROTOM_QODER_AUTH;
  try {
    const provider = await createQoderProvider({
      piAI: { createProvider: p => p, lazyStream: (_m, setup) => setup() },
      getCredential: () => assert.fail('CLI read'), getToken: () => assert.fail('CLI token'),
    });
    // Browser mode exposes the oauth adapter and no raw apiKey resolver; the
    // CLI credential source is never consulted when the default holds.
    assert.equal(provider.auth.apiKey, undefined);
    assert.ok(provider.auth.oauth, 'default should expose the browser oauth adapter');
  } finally {
    if (saved === undefined) delete process.env.ROTOM_QODER_AUTH; else process.env.ROTOM_QODER_AUTH = saved;
  }
});
