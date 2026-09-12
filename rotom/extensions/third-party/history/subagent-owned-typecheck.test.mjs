import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const helper = path.join(import.meta.dirname, 'fixtures/typecheck-owned-candidate.mjs');
const compiler = process.env.ROTOM_TYPECHECK_COMPILER_ROOT ?? path.resolve(import.meta.dirname, '../../evals');
function invoke(source) {
 return spawnSync(process.execPath, [helper, source, compiler], {encoding:'utf8',timeout:150000,
  env:{PATH:process.env.PATH,HOME:path.dirname(source),TMPDIR:path.dirname(source),ROTOM_PI:process.env.ROTOM_PI}});
}
test('type gate rejects installed source before loading any compiler or Pi runtime', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-types-reject-'));
 const installed = path.join(root, 'node_modules/pi-subagents'); fs.mkdirSync(installed, {recursive:true});
 const result = invoke(installed); assert.ifError(result.error); assert.equal(result.status,1);
 assert.match(result.stderr,/Require an explicit isolated candidate/);
});
test('stale config cannot replace the actual candidate compiler inputs', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-types-inputs-'));
 const source = path.join(root,'current'), old = path.join(root,'old');
 for (const dir of [source,old]) { fs.mkdirSync(path.join(dir,'src'),{recursive:true}); fs.writeFileSync(path.join(dir,'src/model.ts'),'export interface Model { id: string }'); }
 fs.writeFileSync(path.join(old,'index.ts'),'export const value = 1;');
 fs.writeFileSync(path.join(source,'index.ts'),'export const value: string = 1;');
 fs.writeFileSync(path.join(source,'tsconfig.json'),JSON.stringify({files:[path.join(old,'index.ts')]}));
 const rejected = invoke(source); assert.ifError(rejected.error); assert.equal(rejected.status,1);
 assert.match(rejected.stderr,/Type 'number' is not assignable to type 'string'/);
 fs.writeFileSync(path.join(source,'index.ts'),'export const value: string = "one";');
 const accepted = invoke(source); assert.ifError(accepted.error); assert.equal(accepted.status,0,accepted.stderr);
 const result = JSON.parse(accepted.stdout); assert.equal(result.source,fs.realpathSync(source)); assert.equal(result.candidateTsFiles,2);
 const config = JSON.parse(fs.readFileSync(result.config)); assert.deepEqual(config.files,[path.join(result.source,'index.ts'),path.join(result.source,'src/model.ts')]);
 assert.equal(config.compilerOptions.noUncheckedIndexedAccess,true); assert.equal(config.compilerOptions.strict,true);
});
