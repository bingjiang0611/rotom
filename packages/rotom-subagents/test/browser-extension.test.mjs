import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-child-browser-')));
const repo = path.resolve(import.meta.dirname, '../../..');
const browserExtension = path.join(repo, 'rotom/extensions/browser/index.ts');
const keys = ['HOME', 'PI_CODING_AGENT_DIR', 'ROTOM_SUBAGENT_BROWSER_EXTENSION', 'ROTOM_BROWSER_AGENT_ID', 'ROTOM_BROWSER_ROOT_SESSION'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION = browserExtension;
delete process.env.ROTOM_BROWSER_AGENT_ID;
delete process.env.ROTOM_BROWSER_ROOT_SESSION;
after(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, {
  fsCache: false, moduleCache: false,
  alias: { '@earendil-works/pi-tui': path.join(repo, 'rotom/runtime/pi/node_modules/@earendil-works/pi-tui/dist/index.js') },
});
const { resolvePiLaunchToolPlan, buildPiArgs } = await jiti.import('../src/runs/shared/pi-args.ts');

const browserWorker = { model: 'openai-codex/gpt-5.6-sol', tools: ['browser_inspect', 'browser_interact'], extensions: [], agentName: 'worker' };
const readOnlyWorker = { ...browserWorker, tools: ['read', 'grep'] };

test('requesting browser tools loads the product browser extension', () => {
  const plan = resolvePiLaunchToolPlan(browserWorker);
  assert.equal(plan.browserExtension, browserExtension);
  assert.ok(plan.extensionArgs.includes(browserExtension), 'child must be launched with the browser extension');
  assert.equal(plan.disableAmbientExtensions, true, 'requesting the product extension must not re-enable ambient discovery');
  assert.deepEqual(plan.configuredExtensions, []);
  // A child that does not request browser tools never gets it, even when the
  // launcher exported the path.
  const plain = resolvePiLaunchToolPlan(readOnlyWorker);
  assert.equal(plain.browserExtension, undefined);
  assert.equal(plain.extensionArgs.includes(browserExtension), false);
});

test('denied extensions or a missing/invalid product path refuse the launch', () => {
  const ceiling = { version: 1, denyExtensions: true, sources: ['fixture'] };
  assert.throws(() => resolvePiLaunchToolPlan({ ...browserWorker, capabilityCeiling: ceiling }), /browser extension, but child extensions are disabled/u);
  assert.throws(() => resolvePiLaunchToolPlan({ ...browserWorker, inheritedCapabilityCeiling: ceiling }), /browser extension, but child extensions are disabled/u);
  delete process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION;
  assert.throws(() => resolvePiLaunchToolPlan(browserWorker), /launcher did not provide it/u);
  const alias = path.join(root, 'browser-link.ts');
  fs.symlinkSync(browserExtension, alias);
  for (const value of ['relative.ts', root, alias, path.join(root, 'missing.ts')]) {
    process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION = value;
    assert.throws(() => resolvePiLaunchToolPlan(browserWorker), /Invalid product browser extension path/u, value);
  }
  process.env.ROTOM_SUBAGENT_BROWSER_EXTENSION = browserExtension;
  // The refusal is specific to browser tools: other children still launch.
  assert.equal(resolvePiLaunchToolPlan({ ...readOnlyWorker, capabilityCeiling: ceiling }).browserExtension, undefined);
});

test('the child is a distinct browser agent inside the parent root session', () => {
  const args = buildPiArgs({
    baseArgs: [], task: 'drive the form', sessionEnabled: false,
    tools: browserWorker.tools, extensions: [], cwd: root,
    runId: 'run_browser_child', parentSessionId: 'session-main',
  });
  assert.equal(args.env.ROTOM_BROWSER_AGENT_ID, 'run_browser_child');
  assert.equal(args.env.ROTOM_BROWSER_ROOT_SESSION, 'session-main');
  assert.ok(args.args.includes(browserExtension));
  // Nested delegation keeps the original root session instead of adopting the
  // intermediate parent.
  process.env.ROTOM_BROWSER_ROOT_SESSION = 'session-root';
  try {
    const nested = buildPiArgs({
      baseArgs: [], task: 'nested', sessionEnabled: false,
      tools: browserWorker.tools, extensions: [], cwd: root,
      runId: 'run_nested', parentSessionId: 'run_browser_child',
    });
    assert.equal(nested.env.ROTOM_BROWSER_AGENT_ID, 'run_nested');
    assert.equal(nested.env.ROTOM_BROWSER_ROOT_SESSION, 'session-root');
  } finally {
    delete process.env.ROTOM_BROWSER_ROOT_SESSION;
  }
  // Without browser tools the identity variables stay absent.
  const plain = buildPiArgs({ baseArgs: [], task: 'plain', sessionEnabled: false, tools: readOnlyWorker.tools, extensions: [], cwd: root, runId: 'run_plain', parentSessionId: 'session-main' });
  assert.equal(plain.env.ROTOM_BROWSER_AGENT_ID, undefined);
  assert.equal(plain.env.ROTOM_BROWSER_ROOT_SESSION, undefined);
});
