import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createJiti} from 'jiti';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-child-provider-')));
const repo = path.resolve(import.meta.dirname, '../../..');
const provider = path.join(repo, 'rotom/extensions/qoder/index.ts');
const keys = ['HOME', 'PI_CODING_AGENT_DIR', 'ROTOM_SUBAGENT_QODER_EXTENSION', 'ROTOM_QODER'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ROTOM_SUBAGENT_QODER_EXTENSION = provider;
delete process.env.ROTOM_QODER;
after(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  fs.rmSync(root, {recursive: true, force: true});
});
const jiti = createJiti(import.meta.url, {
  fsCache: false, moduleCache: false,
  alias: {'@earendil-works/pi-tui': path.join(repo, 'rotom/runtime/pi/node_modules/@earendil-works/pi-tui/dist/index.js')},
});
const {resolvePiLaunchToolPlan, projectLaunchResolvedChildExtensions, buildPiArgs} = await jiti.import('../src/runs/shared/pi-args.ts');
const reviewer = {model: 'qoder/ultimate:high', tools: ['read', 'grep', 'find', 'ls'], extensions: [], agentName: 'reviewer'};

test('isolated reviewer inherits only its selected product provider and records it in launch identity', () => {
  const plan = resolvePiLaunchToolPlan(reviewer);
  assert.equal(plan.disableAmbientExtensions, true);
  assert.deepEqual(plan.effectiveToolAllowlist, reviewer.tools);
  assert.deepEqual(plan.configuredExtensions, []);
  assert.equal(plan.extensionArgs.length, 2);
  assert.equal(plan.extensionArgs[1], provider);
  const digest = 'sha256:' + createHash('sha256').update(provider).digest('hex').slice(0, 16);
  const identity = projectLaunchResolvedChildExtensions(plan);
  assert.ok(identity.runtime.includes(digest));
  assert.ok(identity.effective.includes(digest));
  assert.equal(resolvePiLaunchToolPlan({...reviewer, subagentOnlyExtensions: [provider]}).extensionArgs.filter(p => p === provider).length, 1);
  for (const model of [undefined, 'openai-codex/gpt-5.6-sol', 'custom/ultimate']) {
    assert.equal(resolvePiLaunchToolPlan({...reviewer, model}).extensionArgs.includes(provider), false);
  }
});

test('preflight binds inherited Qoder and explicit model overrides to the same launch plan', async () => {
  const {resolveSubagentLaunchContract} = await jiti.import('../src/api/preflight.ts');
  const input = {agent: 'reviewer', cwd: root, artifacts: false, parentModel: {provider: 'qoder', id: 'ultimate'}, availableModels: [{provider: 'qoder', id: 'ultimate'}]};
  const result = await resolveSubagentLaunchContract(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.contract.model, 'qoder/ultimate:high');
  assert.equal(result.contract.tools.disableAmbientExtensions, true);
  assert.ok(result.contract.tools.extensionArgs.includes(provider));
  const override = await resolveSubagentLaunchContract({...input, model: 'openai-codex/gpt-5.6-sol', availableModels: [...input.availableModels, {provider: 'openai-codex', id: 'gpt-5.6-sol'}]});
  assert.equal(override.ok, true, JSON.stringify(override));
  assert.equal(override.contract.tools.extensionArgs.includes(provider), false);
  const denied = await resolveSubagentLaunchContract({...input, capabilityCeiling: {version: 1, denyExtensions: true, sources: ['fixture']}});
  assert.equal(denied.ok, false);
  assert.match(denied.message, /provider extension.*disabled/);
});

test('Qoder opt-out and extension ceilings reject before child spawn without changing the model', () => {
  process.env.ROTOM_QODER = '0';
  assert.throws(() => resolvePiLaunchToolPlan(reviewer), /provider extension.*disabled/);
  delete process.env.ROTOM_QODER;
  const ceiling = {version: 1, denyExtensions: true, sources: ['fixture']};
  assert.throws(() => resolvePiLaunchToolPlan({...reviewer, capabilityCeiling: ceiling}), /provider extension.*disabled/);
  assert.throws(() => resolvePiLaunchToolPlan({...reviewer, inheritedCapabilityCeiling: ceiling}), /provider extension.*disabled/);
  assert.equal(resolvePiLaunchToolPlan({...reviewer, model: 'openai-codex/gpt-5.6-sol', capabilityCeiling: ceiling}).extensionArgs.length, 1);
});

test('provider paths must be absolute canonical files; standalone callers keep their extension configuration', () => {
  const alias = path.join(root, 'provider-link.ts');
  fs.symlinkSync(provider, alias);
  for (const value of ['relative.ts', root, alias]) {
    process.env.ROTOM_SUBAGENT_QODER_EXTENSION = value;
    assert.throws(() => resolvePiLaunchToolPlan(reviewer), /Invalid product Qoder extension path/);
  }
  process.env.ROTOM_SUBAGENT_QODER_EXTENSION = path.join(root, 'missing.ts');
  assert.throws(() => resolvePiLaunchToolPlan(reviewer), /ENOENT/);
  delete process.env.ROTOM_SUBAGENT_QODER_EXTENSION;
  assert.equal(resolvePiLaunchToolPlan(reviewer).extensionArgs.length, 1);
  assert.ok(resolvePiLaunchToolPlan({...reviewer, subagentOnlyExtensions: [provider]}).extensionArgs.includes(provider));
  process.env.ROTOM_SUBAGENT_QODER_EXTENSION = provider;
});

test('real child Pi loads the product Qoder provider with ambient extensions disabled, offline', {timeout: 60000}, () => {
  const piRoot = path.join(repo, 'rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent');
  const manifest = JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json')));
  const cli = path.join(piRoot, manifest.bin.pi);
  assert.ok(fs.statSync(cli).isFile());
  const machineId = randomUUID(), uid = 'fixture', org = '';
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, {recursive: true});
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), JSON.stringify({qoder: {
    type: 'oauth', qoderAuthVersion: 1, access: 'fixture-access', refresh: 'fixture-refresh',
    expires: Date.now() + 3600000, refreshExpires: Date.now() + 86400000, machineId, uid, org,
    fingerprint: createHmac('sha256', machineId).update(JSON.stringify(['rotom-qoder-browser-v1', uid, org])).digest('hex'),
  }}), {mode: 0o600});
  const guard = path.join(root, 'no-network.mjs');
  fs.writeFileSync(guard, "globalThis.fetch = () => { throw new Error('Network forbidden in provider launch regression'); };\n");
  const input = {...reviewer, baseArgs: ['--list-models', 'qoder'], task: '', deferTask: true, sessionEnabled: false, inheritProjectContext: false, inheritSkills: false};
  const run = (built, input) => {
    try {
      return spawnSync(process.execPath, ['--import', guard, cli, ...built.args], {
        cwd: root, encoding: 'utf8', timeout: 30000, input,
        env: {PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, ...built.env},
      });
    } finally { fs.rmSync(built.tempDir, {recursive: true, force: true}); }
  };
  delete process.env.ROTOM_SUBAGENT_QODER_EXTENSION;
  const before = run(buildPiArgs(input));
  assert.ifError(before.error);
  assert.doesNotMatch(before.stdout, /qoder\s+lite/);
  process.env.ROTOM_SUBAGENT_QODER_EXTENSION = provider;
  const built = buildPiArgs(input);
  assert.ok(built.args.includes('--no-extensions'));
  assert.equal(built.args[built.args.indexOf('--model') + 1], 'qoder/ultimate:high');
  assert.equal(built.args[built.args.indexOf('--tools') + 1], reviewer.tools.join(','));
  const result = run(built);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /qoder\s+lite/);
  assert.match(result.stdout, /qoder\s+performance/);
  assert.doesNotMatch(result.stderr, /Network forbidden|Failed to load extension/);
  // Resolve the screenshot's exact model without sending any inference request.
  const rpc = run(buildPiArgs({...input, baseArgs: ['--mode', 'rpc']}), '{"id":"probe","type":"get_state"}\n');
  assert.ifError(rpc.error);
  assert.equal(rpc.status, 0, rpc.stderr);
  const state = rpc.stdout.trim().split('\n').map(line => JSON.parse(line)).find(event => event.id === 'probe');
  assert.equal(state.success, true);
  assert.equal(state.data.model.provider, 'qoder');
  assert.equal(state.data.model.id, 'ultimate');
  assert.equal(state.data.thinkingLevel, 'high');
});
