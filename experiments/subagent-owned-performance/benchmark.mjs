// Explicitly authorized six-task live A/B; dry mode dispatches no remote model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [mode,rootArg]=process.argv.slice(2);
assert.ok(['--dry-run','--live'].includes(mode));assert.ok(path.isAbsolute(rootArg??''));
const root=fs.realpathSync(rootArg),stat=fs.lstatSync(rootArg);
assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.uid===process.getuid());
const preflight=JSON.parse(fs.readFileSync(path.join(root,'preflight.json')));
const source=path.join(preflight.product,'extensions/third-party/node_modules/pi-subagents');
assert.equal(JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version,'0.52.1-rotom.0');
let fauxEntry;
for(let dir=preflight.piPackageRoot;;dir=path.dirname(dir)){
 const file=path.join(dir,'node_modules/@earendil-works/pi-ai/package.json');
 if(fs.existsSync(file)){const p=JSON.parse(fs.readFileSync(file));assert.equal(p.name,'@earendil-works/pi-ai');fauxEntry=path.resolve(path.dirname(file),p.exports['./providers/*'].import.replaceAll('*','faux'));break;}
 assert.notEqual(path.dirname(dir),dir);
}
assert.ok(fs.existsSync(fauxEntry));
const dry=mode==='--dry-run',plan=dry?[['dry-A',false],['dry-B',true]]:[['pair1-A',false],['pair1-B',true],['pair2-B',true],['pair2-A',false],['pair3-A',false],['pair3-B',true]];
const phase=path.join(root,dry?'dry':'live');assert.equal(fs.existsSync(phase),false);fs.mkdirSync(phase,{mode:0o700});
const helperDigests={};
for(const name of ['child.mjs','tap.mjs','benchmark.mjs']){const bytes=fs.readFileSync(path.join(import.meta.dirname,name));helperDigests[name]=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(phase,name),bytes,{mode:0o600,flag:'wx'});}
const frozen={helperDigests,mode,model:dry?'scope-bench/fixture':'cc-switch/claude-opus-5',thinking:'off',plan,productVersion:'0.1.0-alpha.1',componentVersion:'0.52.1-rotom.0',task:'One read of payload.txt; return token and sum',maxTurns:3,toolBudget:1,tokenBudget:20000,taskTimeoutMs:120000,manualRetries:0,remoteTasksAuthorized:dry?0:6,controllerModelCalls:0};
fs.writeFileSync(path.join(phase,'plan.json'),JSON.stringify(frozen,null,2),{mode:0o600,flag:'wx'});
const results=[];
for(const [id,owned] of plan){
 const base=path.join(phase,id);fs.mkdirSync(base,{mode:0o700});
 const cwd=path.join(base,'work'),home=dry?path.join(base,'home'):process.env.HOME,temp=path.join(base,'tmp'),store=path.join(base,'store');
 for(const dir of [cwd,temp,...(dry?[home]:[])])fs.mkdirSync(dir,{mode:0o700});
 fs.mkdirSync(path.join(cwd,'.pi'),{mode:0o700});
 fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({retry:{enabled:false,maxRetries:0},compaction:{enabled:false},defaultThinkingLevel:'off'}),{mode:0o600});
 fs.writeFileSync(path.join(cwd,'payload.txt'),JSON.stringify({token:'ORCHID-47',values:[13,7,21,9]})+'\n',{mode:0o600});
 assert.equal(spawnSync('git',['-c','init.templateDir=','init','-q'],{cwd}).status,0);
 const c={...preflight,source,root:base,cwd,home,id,owned,dry,model:frozen.model,tap:path.join(phase,'tap.mjs'),fauxEntry,events:path.join(base,'events.jsonl'),writerMarker:path.join(base,'writer-started'),result:path.join(base,'result.json')};
 const config=path.join(base,'config.json');fs.writeFileSync(config,JSON.stringify(c),{mode:0o600});
 const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:home,TMPDIR:temp,PI_SUBAGENTS_TEMP_ROOT:store,PI_SUBAGENT_PI_BINARY:preflight.piExecutable,PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT:preflight.piPackageRoot,ROTOM_SCOPE_BENCH_CONFIG:config,ROTOM_OBSERVABILITY:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 // Native credential discovery uses the existing HOME, never copied credential files.
 if(!dry)for(const key of Object.keys(process.env))if(/^(ANTHROPIC_|CC_SWITCH_)/.test(key))env[key]=process.env[key];
 if(owned){
  const init=spawnSync(process.execPath,[path.join(source,'owned-store.mjs'),'init','--base',store,'--accept-unverified-descendants'],{env,encoding:'utf8',timeout:20000});
  assert.equal(init.status,0,'store init failed');assert.equal(JSON.parse(init.stdout).recoveryAuthorized,false);env.PI_SUBAGENTS_EXECUTION_SCOPE='owned-process-groups-v2';
 }
 // Durable attempt record precedes dispatch. Re-entering a phase is refused, not replayed.
 fs.appendFileSync(path.join(phase,'attempts.jsonl'),JSON.stringify({id,owned,at:Date.now()})+'\n',{mode:0o600});
 const fd=fs.openSync(path.join(base,'driver.log'),'wx',0o600);let p;
 try{p=spawnSync(process.execPath,[path.join(phase,'child.mjs'),config],{cwd,env,stdio:['ignore',fd,fd],timeout:190000});}finally{fs.closeSync(fd);}
 const result=fs.existsSync(c.result)?JSON.parse(fs.readFileSync(c.result)):{state:'unknown'};
 console.log(JSON.stringify({id,processStatus:p.status,error:p.error?.code??null,...result}));
 assert.equal(p.status,0,'Unproven execution; retain artifacts and stop, no replay');assert.equal(result.state,'closed');
 const events=fs.readFileSync(c.events,'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.equal(events.filter(x=>x.kind==='writer-extension-ready').length,1);
 const payload=fs.readFileSync(path.join(cwd,'payload.txt'));assert.equal(createHash('sha256').update(payload).digest('hex'),createHash('sha256').update(JSON.stringify({token:'ORCHID-47',values:[13,7,21,9]})+'\n').digest('hex'));
 results.push(result);
 fs.writeFileSync(path.join(phase,'results.json'),JSON.stringify(results,null,2),{mode:0o600});
}
console.log(JSON.stringify({completed:results.length,dry,valid:results.filter(r=>r.valid).length,root:phase}));
