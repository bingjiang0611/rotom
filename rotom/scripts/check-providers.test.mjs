import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { AI_TESTS, classifyResult, offlineEnvironment, parseArguments, piIdentity, verificationCases } from './check-providers.mjs';

const root = resolve(import.meta.dirname, '../..');
const ok = stdout => ({ status: 0, signal: null, stdout, stderr: '' });

test('gate is offline-only and accepts only an explicit report file', () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(['--report', '/tmp/report.json']), { report: '/tmp/report.json' });
  for (const args of [['--live'], ['--report', 'relative'], ['--report'], ['--model', 'live'], ['--report', '/tmp/a', '--live']]) {
    assert.throws(() => parseArguments(args), /offline only/);
  }
});

test('child environment does not inherit auth, proxy, preload or live probe authority', () => {
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--import=PRIVATE';
  try {
    const env = offlineEnvironment('/isolated');
    assert.equal(env.HOME, '/isolated');
    assert.equal(env.PI_CODING_AGENT_DIR, '/isolated/agent');
    assert.equal(env.PI_OFFLINE, '1');
    assert.match(env.NODE_OPTIONS, /provider-offline-guard\.mjs$/);
    assert.doesNotMatch(JSON.stringify(env), /PRIVATE/);
    assert(!('ROTOM_PI' in env));
    assert(!('HTTPS_PROXY' in env));
    assert(!('ROTOM_QODER_PROBE_LEDGER' in env));
    assert(!('ANTHROPIC_API_KEY' in env));
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
  }
});

test('every selected source command exists; broad AI live suites are not selected', async () => {
  assert(!AI_TESTS.includes('stream.test.ts'));
  assert(!AI_TESTS.includes('cross-provider-handoff.test.ts'));
  for (const item of await verificationCases()) {
    assert(!item.args.includes('--live'));
    const cwd = resolve(root, item.cwd);
    await access(cwd);
    for (const arg of item.args.filter(arg => /\.(mjs|ts)$/.test(arg))) await access(resolve(cwd, arg));
  }
});

test('exit zero without executed assertions, skipped tests or a passing smoke is not PASS', () => {
  assert.equal(classifyResult('smoke', ok('{"pass":true}')).status, 'PASS');
  assert.equal(classifyResult('smoke', ok('{"pass":false}')).status, 'FAIL');
  assert.equal(classifyResult('smoke', ok('not json')).status, 'FAIL');
  const tap = '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(classifyResult('tap', ok(tap)).counts, { tests: 3, passed: 3, failed: 0, skipped: 0 });
  assert.equal(classifyResult('tap', ok(tap.replace('# pass 3', '# pass 2').replace('# skipped 0', '# skipped 1'))).status, 'FAIL');
  assert.equal(classifyResult('tap', ok('')).status, 'FAIL');
  const vitest = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0 };
  assert.equal(classifyResult('vitest', ok(JSON.stringify(vitest))).status, 'PASS');
  assert.equal(classifyResult('vitest', ok(JSON.stringify({ ...vitest, numPendingTests: 1 }))).status, 'FAIL');
  assert.equal(classifyResult('vitest', ok('{}')).status, 'FAIL');
});

test('process timeout stays UNKNOWN and blocked dispatch is a failure even if output says pass', () => {
  assert.deepEqual(classifyResult('smoke', { ...ok('{"pass":true}'), error: { code: 'ETIMEDOUT' } }), { status: 'UNKNOWN', reason: 'process_unsettled' });
  assert.equal(classifyResult('smoke', { ...ok('{"pass":true}'), signal: 'SIGTERM' }).status, 'UNKNOWN');
  assert.equal(classifyResult('smoke', { ...ok('{"pass":true}'), terminal: { outcome: 'exited', confirmed: false } }).status, 'UNKNOWN');
  assert.equal(classifyResult('smoke', { ...ok('{"pass":true}'), terminal: { outcome: 'timeout', confirmed: true } }).status, 'UNKNOWN');
  assert.deepEqual(classifyResult('smoke', { ...ok('{"pass":true}'), status: 86 }), { status: 'FAIL', reason: 'network_blocked' });
  assert.equal(classifyResult('smoke', { ...ok('{"pass":true}'), stderr: 'ROTOM_PROVIDER_NETWORK_BLOCKED' }).status, 'FAIL');
});

test('Pi evidence follows executable resolution, including nested dependencies, not unused siblings', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'provider-identity-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const modules = join(home, 'node_modules', '@earendil-works');
  async function makePackage(base, name, version) {
    const root = join(base, name); await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@earendil-works/${name}`, version, bin: { pi: 'dist/cli.js' }, exports: { '.': { import: './dist/index.js' } } }));
    await writeFile(join(root, 'dist/index.js'), 'export const fixture = 1;');
    await writeFile(join(root, 'dist/cli.js'), '', { mode: 0o755 });
    return root;
  }
  for (const name of ['chord', 'pi-telemetry', 'pi-ai', 'pi-tui', 'pi-agent-core', 'pi-coding-agent']) await makePackage(modules, name, '0.85.1');
  const coding = join(modules, 'pi-coding-agent'), executable = join(coding, 'dist/cli.js');
  const nested = await makePackage(join(coding, 'node_modules/@earendil-works'), 'pi-ai', '0.85.2');
  const selected = identity => identity.packages.find(pkg => pkg.name === '@earendil-works/pi-ai');
  const first = selected(await piIdentity(executable));
  assert.equal(first.root, nested); assert.equal(first.version, '0.85.2');
  await writeFile(join(modules, 'pi-ai/dist/index.js'), 'unused sibling changed');
  assert.equal(selected(await piIdentity(executable)).compiledSha256, first.compiledSha256);
  await writeFile(join(nested, 'dist/index.js'), 'selected implementation changed');
  assert.notEqual(selected(await piIdentity(executable)).compiledSha256, first.compiledSha256);
});

test('existing report is rejected before executing any check or overwriting evidence', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'provider-report-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const report = join(home, 'report.json'); await writeFile(report, 'existing-evidence');
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'check-providers.mjs'), '--report', report], { env: offlineEnvironment(home), encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /EEXIST/);
  assert.doesNotMatch(result.stderr, /qoder-contracts|pi-ai-contracts/);
  assert.equal(await readFile(report, 'utf8'), 'existing-evidence');
});

test('offline preload blocks native fetch, cross-realm fetch, HTTP, TLS, raw sockets and inherited children before local server receipt', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'provider-guard-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  let received = 0;
  const server = createServer((_req, res) => { received++; res.end('must not receive'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, url = `http://127.0.0.1:${port}/PRIVATE`;
  const code = `await fetch(${JSON.stringify(url)})`;
  const snippets = [
    code,
    `import vm from 'node:vm'; await vm.runInNewContext(${JSON.stringify(code.replace('await ', ''))},{fetch})`,
    `import http from 'node:http'; http.get(${JSON.stringify(url)})`,
    `import tls from 'node:tls'; tls.connect({host:'127.0.0.1',port:${port}})`,
    `import net from 'node:net'; net.connect(${port},'127.0.0.1')`,
    `import {Worker} from 'node:worker_threads'; new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(code)}))).on('exit',code=>process.exit(code))`,
    `import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(code)}],{encoding:'utf8'}); process.stderr.write(r.stderr); process.exit(r.status)`,
  ];
  for (const snippet of snippets) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', snippet], { env: offlineEnvironment(home), encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 86, `guard exit: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'ROTOM_PROVIDER_NETWORK_BLOCKED');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, 0);
  const synthetic = spawnSync(process.execPath, ['--input-type=module', '-e', 'console.log(await new Response("fixture").text())'], { env: offlineEnvironment(home), encoding: 'utf8', timeout: 10_000 });
  assert.equal(synthetic.status, 0); assert.equal(synthetic.stdout.trim(), 'fixture');
});
