import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {packageRoot, repoRoot, snapshot, manifest} from './source.mjs';
import {probePiVersion} from '../../../rotom/runtime/verify-pi-runtime.mjs';

const mode = process.argv[2];
assert.ok(['unit','sdk','compat','types'].includes(mode) && process.argv.length === 3, 'Expected unit|sdk|compat|types');
let piRoot = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
while (!fs.existsSync(path.join(piRoot, 'package.json')) || JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json'))).name !== '@earendil-works/pi-coding-agent') {
 assert.notEqual(piRoot, path.dirname(piRoot)); piRoot = path.dirname(piRoot);
}
const pkg = JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json')));
assert.equal(pkg.version, '0.85.1');
const executable = fs.realpathSync(path.join(piRoot, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.pi));
await probePiVersion({executable});
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-subagents-check-')));
const env = {PATH:process.env.PATH, HOME:work, TMPDIR:work, ROTOM_PI:executable, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1'};
const fixtures = path.join(repoRoot, 'rotom/extensions/third-party');
let args;
if (mode === 'types') {
 const source = snapshot(work);
 args = [path.join(fixtures, 'fixtures/typecheck-owned-candidate.mjs'), source, packageRoot];
} else {
 let files;
 if (mode === 'unit') files = ['source.test.mjs','wait.test.mjs'].map(n => path.join(packageRoot, 'test', n));
 if (mode === 'sdk') files = [path.join(packageRoot, 'test/sdk.test.mjs')];
 if (mode === 'compat') {
  const source = snapshot(work);
  env.ROTOM_SUBAGENT_TEST_VERSION = manifest().version;
  for (const key of ['EXTERNAL_GROUP','OWNED_EXECUTION','OWNED_WORKFLOW','OWNED_FOREGROUND','OWNED_STORE','OWNED_SESSION','OWNED_FLAT','LIFELINE','FOLLOWTHROUGH']) env[`SUBAGENT_${key}_SOURCE`] = source;
  files = ['owned-flat','owned-session','owned-store','owned-foreground','owned-workflow','owned-execution','external-group','external-lifecycle','followthrough-regression','lifeline-regression'].map(n => path.join(fixtures, `subagent-${n}.test.mjs`));
 }
 assert.ok(files.length > 0); for (const file of files) assert.ok(fs.statSync(file).isFile());
 args = ['--experimental-strip-types','--test','--test-concurrency=1',...files];
}
const result = spawnSync(process.execPath, args, {cwd:packageRoot, env, stdio:'inherit', timeout:600000});
console.log(JSON.stringify({mode, artifacts:work, piExecutable:executable, remoteModelsAuthorized:false}));
assert.ifError(result.error); assert.equal(result.status, 0, `${mode} failed; artifacts retained`);
