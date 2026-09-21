// Maintenance gate only; never included in the npm product. No live mode.
import { createHash } from 'node:crypto';
import { findPackageJSON } from 'node:module';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstalledPi } from '../runtime/resolve-installed-pi.mjs';
import { probePiVersion } from '../runtime/verify-pi-runtime.mjs';
import { sourceDigest } from './build-pi-fork.mjs';
import { executeProcessTreeV1 } from '../runtime/process-tree.ts';

const repository = resolve(import.meta.dirname, '../..');
const guard = join(import.meta.dirname, 'provider-offline-guard.mjs');
const aiDirectory = 'packages/rotom-pi/packages/ai';
// Reviewed synthetic tests only. The upstream default test command includes live
// tests whose module imports can read/refresh auth; never invoke that broad suite.
export const AI_TESTS = [
  'retry.test.ts', 'provider-retry.test.ts', 'openai-responses-terminal-event.test.ts',
  'provider-error-body-regression.test.ts', 'assistant-message-frame.test.ts',
];

export function offlineEnvironment(home) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    TMPDIR: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1', ROTOM_OBSERVABILITY: '0', NO_COLOR: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    // Deliberately do not inherit credentials, proxies, NODE_OPTIONS or probe flags.
  };
}

export function parseArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--report' && isAbsolute(args[1])) return { report: args[1] };
  throw new Error('Usage: npm run test:providers -- [--report /absolute/new-file.json]; offline only');
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(paths, root) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    const absolute = resolve(root, path), info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error('Untrusted verification input');
    hash.update(path).update('\0').update(String(info.mode & 0o777)).update('\0').update(await readFile(absolute)).update('\0');
  }
  return hash.digest('hex');
}
function git(args) {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Git input inspection failed');
  return result.stdout;
}
async function sourceIdentity() {
  const scopes = ['packages/rotom-pi', 'rotom/extensions/qoder', 'experiments/qoder-provider', 'rotom/scripts', 'rotom/runtime', 'rotom/package.json'];
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes]).split('\0').filter(Boolean))];
  return {
    commit: git(['rev-parse', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
    inputSha256: await fileDigest(paths, repository), inputFiles: paths.length,
    piSourceSha256: await sourceDigest(),
  };
}
export async function piIdentity(executable) {
  if (!isAbsolute(executable) || !(await lstat(executable)).isFile() || await realpath(executable) !== executable) throw new Error('Canonical Pi executable required');
  await probePiVersion({ executable });
  const packages = [];
  for (const name of ['chord', 'pi-telemetry', 'pi-ai', 'pi-tui', 'pi-agent-core', 'pi-coding-agent']) {
    const metadata = findPackageJSON(`@earendil-works/${name}`, pathToFileURL(executable));
    const root = dirname(metadata), pkg = JSON.parse(await readFile(metadata, 'utf8'));
    if (pkg.name !== `@earendil-works/${name}`) throw new Error('Pi dependency identity mismatch');
    const entries = await readdir(join(root, 'dist'), { recursive: true, withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error('Symlink in Pi build');
    const paths = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1));
    packages.push({ name: pkg.name, root, version: pkg.version, sourceSha256: pkg.rotomFork?.sourceSha256 ?? null, compiledSha256: await fileDigest(['package.json', ...paths], root) });
  }
  return { executable, selection: process.env.ROTOM_PI ? 'explicit-override' : 'bundled', packages };
}

export async function verificationCases() {
  const qoder = (await readdir(join(repository, 'rotom/extensions/qoder'))).filter(name => name.endsWith('.test.mjs')).sort();
  const smoke = (id, file, args = []) => ({ id, kind: 'smoke', requiresPi: true, cwd: '.', args: ['--experimental-import-meta-resolve', `experiments/qoder-provider/${file}`, ...args] });
  return [
    { id: 'qoder-contracts', kind: 'tap', cwd: '.', args: ['--test', '--test-reporter=tap', '--test-concurrency=1', ...qoder.map(name => `rotom/extensions/qoder/${name}`), 'experiments/qoder-provider/stream-shape.test.mjs'] },
    { id: 'pi-ai-contracts', kind: 'vitest', cwd: aiDirectory, args: ['../../node_modules/vitest/vitest.mjs', 'run', '--pool=threads', '--maxWorkers=1', '--reporter=json', ...AI_TESTS.map(name => `test/${name}`)] },
    smoke('browser-oauth-lifecycle', 'oauth-smoke.mjs'),
    smoke('direct-tool-roundtrip-cli-fixture', 'smoke.mjs'),
    smoke('session-restore-compaction-cli-fixture', 'session-smoke.mjs', ['--extended']),
    smoke('stream-cancel-replay-cli-fixture', 'stream-smoke.mjs'),
    smoke('cosy-tool-roundtrip', 'catalog-sdk-smoke.mjs', ['--offline', 'smodel']),
    smoke('cosy-late-error', 'catalog-sdk-smoke.mjs', ['--offline', 'smodel', '--negative-trailer']),
    smoke('native-output-budget', 'input-budget-smoke.mjs'),
  ];
}

export function classifyResult(kind, result) {
  if (result.terminal && (!result.terminal.confirmed || result.terminal.outcome !== 'exited')) return { status: 'UNKNOWN', reason: 'process_unsettled' };
  if (result.error || result.signal) return { status: 'UNKNOWN', reason: 'process_unsettled' };
  if (result.status === 86 || result.stderr?.includes('ROTOM_PROVIDER_NETWORK_BLOCKED')) return { status: 'FAIL', reason: 'network_blocked' };
  if (result.status !== 0) return { status: 'FAIL', reason: 'command_failed' };
  try {
    if (kind === 'smoke') return JSON.parse(result.stdout).pass === true ? { status: 'PASS' } : { status: 'FAIL', reason: 'smoke_not_passed' };
    let counts;
    if (kind === 'vitest') {
      const data = JSON.parse(result.stdout);
      counts = { tests: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests, skipped: data.numPendingTests };
    } else {
      const count = key => Number(result.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1]);
      counts = { tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') + count('todo') + count('cancelled') };
    }
    const pass = counts.tests > 0 && counts.passed === counts.tests && counts.failed === 0 && counts.skipped === 0;
    return { status: pass ? 'PASS' : 'FAIL', reason: pass ? undefined : 'incomplete_test_coverage', counts };
  } catch { return { status: 'FAIL', reason: 'invalid_summary' }; }
}

export async function checkProviders() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'rotom-provider-check-')));
  let cleanup = true;
  const report = { schema: 'rotom-provider-verification/v1', mode: 'offline', nodeVersion: process.versions.node, liveValidation: 'not-run', startedAt: new Date().toISOString(), status: 'BLOCKED', scope: 'source contracts plus source Qoder with the identified installed Pi; not installed-product or live validation', cases: [] };
  try {
    const env = offlineEnvironment(home);
    report.source = await sourceIdentity();
    // Unit contracts can still run when the installed runtime is stale. SDK
    // cases remain visibly BLOCKED; never silently fall back to global Pi.
    try {
      const executable = process.env.ROTOM_PI || await resolveInstalledPi(join(repository, 'rotom'));
      report.pi = await piIdentity(executable);
      report.compiledPiMatchesSource = report.pi.packages.every(pkg => pkg.sourceSha256 === report.source.piSourceSha256);
      env.ROTOM_PI = executable;
    } catch { report.pi = { status: 'BLOCKED', reason: 'pi_identity_unavailable_or_mismatch' }; }
    const cases = await verificationCases();
    let stopped = false;
    for (const item of cases) {
      const row = { id: item.id, command: [process.execPath, ...item.args], cwd: item.cwd, execution: 'not-run' };
      report.cases.push(row);
      if (stopped || item.requiresPi && !env.ROTOM_PI) {
        Object.assign(row, { status: stopped ? 'SKIPPED' : 'BLOCKED', reason: stopped ? 'previous_case_failed' : 'pi_identity_unavailable_or_mismatch' });
        continue;
      }
      const start = Date.now();
      const caseEnv = { ...env };
      if (!item.requiresPi) delete caseEnv.ROTOM_PI;
      const result = await executeProcessTreeV1(process.execPath, item.args, { cwd: resolve(repository, item.cwd), env: caseEnv, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
      cleanup &&= result.terminal.confirmed;
      Object.assign(row, { execution: 'executed', ...classifyResult(item.kind, { ...result, status: result.code }), durationMs: Date.now() - start, exitCode: result.code, signal: result.signal, terminal: result.terminal, outputSha256: sha256(`${result.stdout}\0${result.stderr}`) });
      process.stderr.write(`${row.status} ${row.id}\n`);
      if (row.status !== 'PASS') stopped = true;
    }
    try {
      const after = await sourceIdentity();
      report.inputsStable = report.source.inputSha256 === after.inputSha256 && report.source.commit === after.commit;
      if (env.ROTOM_PI) report.inputsStable &&= JSON.stringify(report.pi) === JSON.stringify(await piIdentity(env.ROTOM_PI));
    } catch { report.inputsStable = false; }
    report.status = !report.inputsStable || report.cases.some(row => row.status === 'UNKNOWN') ? 'UNKNOWN'
      : report.cases.some(row => row.status === 'FAIL') ? 'FAIL'
      : report.cases.every(row => row.status === 'PASS') ? 'PASS' : 'BLOCKED';
  } catch {
    report.status = 'BLOCKED'; report.reason = 'verification_preflight_failed';
  } finally {
    if (cleanup) await rm(home, { recursive: true, force: true });
    else report.retainedHome = home;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.report) {
      if (await realpath(dirname(options.report)) !== dirname(options.report)) throw new Error('Canonical report directory required');
      output = await open(options.report, 'wx', 0o600);
    }
    const report = await checkProviders();
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await output.writeFile(text); else process.stdout.write(text);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  } finally { await output?.close(); }
}
