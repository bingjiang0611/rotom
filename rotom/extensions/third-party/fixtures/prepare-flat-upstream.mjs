import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareForegroundUpstreamTests} from './prepare-foreground-upstream.mjs';
export const flatUpstreamUnits=['retained-children','tool-description','public-execution'];
const hashes=['40138e231426b0b3ef90edc6a1d26a551f67abfa73479584eacf3b2fed28ad36','37f9d122bfc14c021531eecae0300b9cc49fe203c6741b27eaddc9bfd13b0b27','4193edb54f4647ea093d4fe63e9dd25b6006d6e67e5a0c2feb148bf030ff79e1'];
export async function prepareFlatUpstreamTests(options){
 const files=flatUpstreamUnits.map((name,i)=>{const relative=`test/unit/${name}.test.ts`,file=path.join(options.upstream,relative),stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());const bytes=fs.readFileSync(file);assert.equal(createHash('sha256').update(bytes).digest('hex'),hashes[i],`Pinned upstream drift: ${relative}`);return {relative,bytes};});
 const result=await prepareForegroundUpstreamTests(options);
 for(const {relative,bytes} of files){let parent=result.source;for(const part of path.dirname(relative).split('/')){parent=path.join(parent,part);const stat=fs.lstatSync(parent);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());}const target=path.join(result.source,relative);try{const stat=fs.lstatSync(target);assert.ok(stat.isFile()&&!stat.isSymbolicLink());}catch(e){if(e.code!=='ENOENT')throw e;}fs.writeFileSync(target,bytes);}
 const patch=path.resolve(import.meta.dirname,'../subagent-external-readiness-test.patch');
 for(const flags of [['--check'],[]]){const applied=spawnSync('git',['apply','--unidiff-zero',...flags,patch],{cwd:result.source,timeout:10000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:path.dirname(result.source),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});assert.ifError(applied.error);assert.equal(applied.status,0,applied.stderr);}
 return {...result,extraUnits:flatUpstreamUnits,adaptation:result.adaptation+'; external marker and runner-terminal readiness before fixture cleanup'};
}
