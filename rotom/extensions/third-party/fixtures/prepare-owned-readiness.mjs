// Maintenance-only eighth layer; never apply to installed source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareOwnedFlatCandidate} from './prepare-owned-flat.mjs';
const preimages = {
 'src/runs/background/owned-execution.ts': '26f1331b3a6f40bafdd6ff1ae959eca0e1aa9ef17628481965e9d9eeba47e204',
 'src/runs/background/auto-drain.ts': 'c0bd035fcde43776f7e9d5c6d6f8768e5188114f26f524159bbe4cae15337e73',
 'src/runs/background/active-async-capacity.ts': '2de467ca459afde92aab74a46b67db48670d33e1cc5e60a5a7154c68778367c5',
 'src/runs/background/subagent-wait.ts': 'f8386008d7a2b8f7d8d50202f232520b8e0bff20dfc5e6dabe426439ec17275a',
};
export function verifyOwnedReadinessPreimages(source) {
 for (const [file,hash] of Object.entries(preimages)) {
  const target=path.join(source,file),stat=fs.lstatSync(target);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),`Invalid preimage: ${file}`);
  assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'),hash,`Readiness preimage drift: ${file}`);
 }
}
export function prepareOwnedReadinessCandidate(root) {
 const source=prepareOwnedFlatCandidate(root);verifyOwnedReadinessPreimages(source);
 const patch=path.resolve(import.meta.dirname,'../subagent-owned-readiness-candidate.patch');
 for(const flags of [['--check'],[]]) {
  const result=spawnSync('git',['apply','--unidiff-zero',...flags,patch],{cwd:source,timeout:10000,encoding:'utf8',
   env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 }
 return source;
}
