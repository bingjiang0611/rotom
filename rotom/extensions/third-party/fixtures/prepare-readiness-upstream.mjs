// Supplement the existing pinned/adapted suite with byte-bound wait/drain units.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareFlatUpstreamTests} from './prepare-flat-upstream.mjs';
export async function prepareReadinessUpstreamTests(options) {
 const result=await prepareFlatUpstreamTests(options);
 for(const [name,hash] of Object.entries({
  'auto-drain':'d7438fbad725201a57a753c14e23210789eb39784601720daf85630e73ee19e3',
  'subagent-wait':'db33836a9e9e32bbad20945fd0378aafd0c701b51521f658797b631892304d1f',
 })) {
  const from=path.join(options.upstream,'test/unit',name+'.test.ts'),to=path.join(result.source,'test/unit',name+'.test.ts');
  const stat=fs.lstatSync(from);assert.ok(stat.isFile()&&!stat.isSymbolicLink());
  assert.equal(createHash('sha256').update(fs.readFileSync(from)).digest('hex'),hash,`Wait/drain upstream preimage drift: ${name}`);
  assert.ok(!fs.existsSync(to),'Supplemental tests must not overwrite existing files');
  fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
 }
 return result;
}
