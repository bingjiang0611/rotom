import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {packageRoot,manifest,payloadFiles,privateOutput,copyPayload,snapshot,sourceDigest} from '../scripts/source.mjs';
import {checkLock,checkPackList,pack} from '../scripts/pack.mjs';
const fresh=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-subagents-unit-')));
const origin=JSON.parse(fs.readFileSync(path.join(packageRoot,'IMPORT.json')));

test('origin and original MIT attribution are retained',()=>{
 assert.equal(origin.import.tsFiles,213);assert.equal(Object.keys(origin.originalFiles).length,248);
 const license=fs.readFileSync(path.join(packageRoot,'LICENSE'));
 assert.equal(createHash('sha256').update(license).digest('hex'),origin.originalFiles.LICENSE);
 assert.match(license.toString(),/Copyright \(c\) 2026 Nico Bailon/);
 assert.equal(manifest().name,'pi-subagents');assert.equal(manifest().private,true);
});
test('common builtin profiles are explicit/fresh without widening tools or replacing overrides',()=>{
 const root=fresh(),agentDir=path.join(root,'agent'),cwd=path.join(root,'business');fs.mkdirSync(agentDir,{mode:0o700});fs.mkdirSync(cwd,{mode:0o700});
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({subagents:{agentOverrides:{worker:{model:'fixture/preserved',thinking:'medium'}}}}));
 const script=`import fs from 'node:fs';import path from 'node:path';import {createJiti} from 'jiti';globalThis.fetch=()=>{throw Error('No network authorized');};const jiti=createJiti(import.meta.url,{fsCache:false,moduleCache:false});const {discoverAgents}=await jiti.import(${JSON.stringify(path.join(packageRoot,'src/agents/agents.ts'))});const select=()=>discoverAgents(${JSON.stringify(cwd)},'both').agents.filter(a=>['worker','scout','reviewer'].includes(a.name)).map(a=>({name:a.name,tools:a.tools,extensions:a.extensions,context:a.defaultContext,model:a.model,thinking:a.thinking}));const defaults=select();fs.mkdirSync(${JSON.stringify(path.join(cwd,'.pi'))});fs.writeFileSync(${JSON.stringify(path.join(cwd,'.pi/settings.json'))},JSON.stringify({subagents:{agentOverrides:{worker:{defaultContext:'fork'}}}}));console.log(JSON.stringify({defaults,explicit:select()}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:packageRoot,env:{...process.env,HOME:root,PI_CODING_AGENT_DIR:agentDir},encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);
 const {defaults,explicit}=JSON.parse(result.stdout);assert.equal(defaults.length,3);
 const tools={worker:['read','grep','find','ls','bash','edit','write','contact_supervisor'],scout:['read','grep','find','ls','bash','write'],reviewer:['read','grep','find','ls']};
 for(const a of defaults){assert.equal(a.context,'fresh');assert.deepEqual(a.extensions,[]);assert.deepEqual(a.tools,tools[a.name]);}
 assert.equal(defaults.find(a=>a.name==='worker').model,'fixture/preserved');assert.equal(defaults.find(a=>a.name==='worker').thinking,'medium');assert.equal(explicit.find(a=>a.name==='worker').context,'fork');
});
test('runtime dependency lock and explicit payload remain bounded',()=>{
 checkLock();const files=payloadFiles();
 for(const name of ['LICENSE','UPSTREAM.md','owned-store.mjs','src/runs/background/owned-execution.ts'])assert.ok(files.includes(name));
 assert.ok(!files.some(n=>n.startsWith('scripts/')||n.startsWith('test/')||n.includes('node_modules')||n.endsWith('.patch')||n==='package-lock.json'));
 assert.throws(()=>checkPackList({files:[...files,{path:'test/leak.mjs'}].map(f=>typeof f==='string'?{path:f}:f)},files));
});
test('snapshots read maintained source, not archive/patch reconstruction',()=>{
 const root=fresh(),source=snapshot(root);assert.deepEqual(sourceDigest(source),sourceDigest());
 assert.throws(()=>snapshot(root),/unused/);
 assert.ok(!fs.existsSync(path.join(source,'test')));assert.ok(fs.existsSync(path.join(root,'node_modules/jiti/package.json')));
});
test('repository, installed, public and aliased output roots are refused',()=>{
 assert.throws(()=>privateOutput(packageRoot));const root=fresh(),publicDir=path.join(root,'public');fs.mkdirSync(publicDir,{mode:0o755});fs.chmodSync(publicDir,0o755);assert.throws(()=>privateOutput(publicDir));
 const modules=path.join(root,'node_modules');fs.mkdirSync(modules,{mode:0o700});assert.throws(()=>privateOutput(modules));
 const alias=path.join(root,'alias');fs.symlinkSync(fresh(),alias);assert.throws(()=>privateOutput(alias));
});
test('linked source and unreviewed traversal cannot enter a snapshot',()=>{
 const root=fresh(),source=copyPayload(path.join(root,'source'));
 fs.unlinkSync(path.join(source,'index.ts'));fs.symlinkSync(path.join(packageRoot,'index.ts'),path.join(source,'index.ts'));
 assert.throws(()=>payloadFiles(source),/Linked/);assert.throws(()=>copyPayload(path.join(root,'failed'),source));assert.equal(fs.existsSync(path.join(root,'failed')),false);
 fs.unlinkSync(path.join(source,'index.ts'));fs.copyFileSync(path.join(packageRoot,'index.ts'),path.join(source,'index.ts'));
 fs.writeFileSync(path.join(source,'src/leak.test.ts'),'export {};');assert.throws(()=>payloadFiles(source),/Unsafe/);fs.unlinkSync(path.join(source,'src/leak.test.ts'));
 const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json')));pkg.files.push('../escape');fs.writeFileSync(path.join(source,'package.json'),JSON.stringify(pkg));assert.throws(()=>payloadFiles(source),/Unsafe/);
});
test('lock drift fails before package publication',()=>{
 const root=fresh(),source=copyPayload(path.join(root,'source'));const lock=JSON.parse(fs.readFileSync(path.join(packageRoot,'package-lock.json')));lock.packages['node_modules/jiti'].version='0.0.0';fs.writeFileSync(path.join(source,'package-lock.json'),JSON.stringify(lock));assert.throws(()=>checkLock(source));
});
test('actual offline pack is audited, source-bound and cannot overwrite identity',{timeout:120000},()=>{
 const output=fresh(),result=pack(output);assert.equal(result.published,false);assert.equal(result.sourceDigest,sourceDigest().sourceDigest);assert.equal(result.audit.status,'PASS');assert.throws(()=>pack(output),/overwrite/);
 const invalid=spawnSync('python3',[path.join(packageRoot,'scripts/stage-product.py'),'--archive',result.artifact,'--output',path.join(output,'stage'),'--revision','HEAD','--product-version','invalid'],{encoding:'utf8',timeout:10000});assert.notEqual(invalid.status,0);assert.equal(fs.existsSync(path.join(output,'stage')),false);
 const receipt=JSON.parse(fs.readFileSync(result.artifact+'.json'));receipt.sourceDigest='0'.repeat(64);fs.writeFileSync(result.artifact+'.json',JSON.stringify(receipt));
 const mismatch=spawnSync('python3',[path.join(packageRoot,'scripts/stage-product.py'),'--archive',result.artifact,'--output',path.join(output,'mismatch'),'--revision','HEAD','--product-version','0.1.0-rotom-subagents.0'],{encoding:'utf8',timeout:10000});assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/Source receipt\/archive mismatch/);assert.equal(fs.existsSync(path.join(output,'mismatch')),false);
});
