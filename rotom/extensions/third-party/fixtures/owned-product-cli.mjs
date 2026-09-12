// Real installed npm entry, local SSE inference only; no injected Pi extension.
// Usage: node owned-product-cli.mjs ABS_INSTALL_PREFIX ABS_PRIVATE_WORK_ROOT wait|drain|native|workflow 0|1 transient|persistent
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
const [prefixArg,workArg,scenario='wait',deferred='0',persistence='transient']=process.argv.slice(2);
assert.ok(path.isAbsolute(prefixArg??'')&&path.isAbsolute(workArg??''));
assert.ok(['wait','drain','native','workflow'].includes(scenario)&&['0','1'].includes(deferred)&&['transient','persistent'].includes(persistence));
const prefix=fs.realpathSync(prefixArg),workRoot=fs.realpathSync(workArg),stat=fs.statSync(workRoot);
assert.equal(stat.mode&0o077,0,'Require a private evidence root');assert.equal(stat.uid,process.getuid());
const product=path.join(prefix,'node_modules/rotom'),bin=process.env.ROTOM_SUBAGENT_TEST_BIN??path.join(prefix,'node_modules/.bin/rotom');
// A selected public command may be an activation symlink, never another product or shell command.
assert.ok(path.isAbsolute(bin));
assert.equal(fs.realpathSync(bin),fs.realpathSync(path.join(product,'bin/rotom')));
const builtinAgent=process.env.ROTOM_SUBAGENT_TEST_BUILTIN;
if(builtinAgent)assert.ok(['worker','scout','reviewer'].includes(builtinAgent)&&scenario==='native');
const manifest=JSON.parse(fs.readFileSync(path.join(product,'package.json')));
assert.equal(manifest.name,'rotom');assert.equal(manifest.private,true);
const subagentRoot=path.join(product,'extensions/third-party/node_modules/pi-subagents');
const subagent=JSON.parse(fs.readFileSync(path.join(subagentRoot,'package.json')));
if(process.env.ROTOM_SUBAGENT_TEST_VERSION) {
 assert.match(process.env.ROTOM_SUBAGENT_TEST_VERSION,/^0\.52\.1-rotom\.\d+$/);
 assert.equal(subagent.version,process.env.ROTOM_SUBAGENT_TEST_VERSION);
} else assert.match(subagent.version,/^0\.52\.1-dev-agent-owned-flat\.\d+$/);
const work=fs.mkdtempSync(path.join(workRoot,'owned-product-')),home=path.join(work,'home'),cwd=path.join(work,'business space'),binPath=path.join(work,'bin');
// The product selects the scope and this store path itself; the fixture never initializes or injects them.
const base=path.join(home,'.local/state/rotom/subagent-store');
for(const dir of [home,cwd,binPath,path.join(home,'.pi/agent'),path.join(cwd,'.pi/agents')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
fs.symlinkSync(process.execPath,path.join(binPath,'node'));
const env={PATH:binPath+':/usr/bin:/bin',HOME:home,ROTOM_OBSERVABILITY:'0',ROTOM_DEFERRED_TOOLS:deferred,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
const scope='owned-process-groups-v2';
// Scope selection, store creation and opt-out live in the launcher; see verify-pi-runtime.test.mjs.
assert.equal(fs.existsSync(base),false,'The product must create its own store, not inherit a fixture store');
assert.equal(spawnSync('git',['-c','init.templateDir=','init','-q'],{cwd,env}).status,0);
const marker=path.join(cwd,'effect.json');
// A one-second local workload, not a delay in the provider or wait path.
fs.writeFileSync(path.join(cwd,'external.mjs'),`import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),pid:process.pid}));console.log('LOCAL_EXTERNAL_DONE')},1000));`);
fs.writeFileSync(path.join(cwd,'.pi/agents/external.md'),`---\nname: external\ndescription: Local external product acceptance\nrunner:\n  type: external-cli\n  command: ${process.execPath}\n  args: ["./external.mjs"]\n  promptDelivery: stdin\nasync: true\n---\nRun this independent local fixture only.\n`);
fs.writeFileSync(path.join(cwd,'payload.txt'),'NATIVE_READ_CONTROL');
if(builtinAgent)fs.writeFileSync(path.join(home,'.pi/agent/settings.json'),JSON.stringify({subagents:{agentOverrides:{[builtinAgent]:{model:'owned-local/native'}}}}),{mode:0o600});
else fs.writeFileSync(path.join(cwd,'.pi/agents/native.md'),'---\nname: native\ndescription: Local Pi product acceptance\nmodel: owned-local/native\ntools: read\nextensions:\nasync: true\n---\nRead the local fixture only.\n');
let requests=0,nativeRequests=0,scopedDescription=false,rejectionSeen=false,waitSeen=false,searchSeen=false,originalSession,originalSessionBytes;
const errors=[],events=[];
function send(res,index,model,call,content) {
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call-'+index,type:'function',function:call}]}:{role:'assistant',content};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 const packet=(delta,finish)=>({id:'local-'+index,object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason:finish}]});
 res.write('data: '+JSON.stringify(packet(delta,null))+'\n\n');res.write('data: '+JSON.stringify(packet({},call?'tool_calls':'stop'))+'\n\n');res.end('data: [DONE]\n\n');
}
const server=http.createServer(async(req,res)=>{
 let index,call,content='PRODUCT_CLI_DONE';
 try {
  assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<2_000_000)}
  const body=JSON.parse(raw);assert.equal(body.stream,true);
  if(body.model==='native') {
   assert.ok(['native','workflow'].includes(scenario));const childIndex=nativeRequests++;assert.ok(childIndex<4,'Unexpected native replay');
   const last=body.messages.at(-1);
   if(last.role==='tool'){assert.ok(JSON.stringify(last.content).includes('NATIVE_READ_CONTROL'));send(res,'native-'+childIndex,'native',undefined,'LOCAL_NATIVE_DONE');}
   else send(res,'native-'+childIndex,'native',{name:'read',arguments:JSON.stringify({path:'payload.txt'})});
   return;
  }
  index=requests++;assert.equal(body.model,'controller');assert.ok(JSON.stringify(body.messages).includes('ACTUAL_PRODUCT_SMOKE α'),'Caller argv/Unicode was not preserved');
  const result=body.messages.filter(m=>m.role==='tool').at(-1);
  const logical=index-(deferred==='1'?1:0);
  if(logical===-1) {
   assert.ok(body.tools.some(t=>t.function?.name==='search_tools'));assert.ok(!body.tools.some(t=>t.function?.name==='subagent'));
   call={name:'search_tools',arguments:JSON.stringify({query:'Subagent delegate task',limit:1})};searchSeen=true;
  } else {
   const tool=body.tools.find(t=>t.function?.name==='subagent');assert.ok(tool);assert.match(tool.function.description,/Scoped first release \(owned-process-groups-v2\)/);scopedDescription=true;
   if(logical===0)call={name:'subagent',arguments:JSON.stringify({agent:'external',task:'Rejected local fixture',async:false})};
   else if(logical===1){assert.match(String(result?.content),/Scoped first release/);assert.equal(fs.existsSync(marker),false);rejectionSeen=true;call={name:'subagent',arguments:JSON.stringify(scenario==='workflow'?{async:true,workflowScript:"const both = await runs.all([{key:'native-async',agent:'native',task:'Read the local fixture',async:true,acceptance:false},{key:'external',agent:'external',task:'Run the independent external fixture',async:true}]); const foreground = await runs.run('native-foreground',{agent:'native',task:'Read the local fixture',async:false,acceptance:false}); return {both,foreground};"}:{agent:scenario==='native'?(builtinAgent??'native'):'external',task:'Independent local product validation',async:true,...(scenario==='native'?{acceptance:false}:{})})};}
   else if(logical===2){assert.ok(!String(result?.content).includes('no writer is authorized'));if(scenario!=='drain')call={name:'subagent_wait',arguments:JSON.stringify({all:true,timeoutMs:60000})};}
   else if(logical===3&&scenario==='native'){
    assert.match(String(result?.content),/; done/);
    const runRoot=path.join(base,scope,'async-subagent-runs'),ids=fs.readdirSync(runRoot).filter(n=>!n.startsWith('.'));assert.equal(ids.length,1);
    const dir=path.join(runRoot,ids[0]),status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'))),proof=JSON.parse(fs.readFileSync(path.join(dir,'process-terminal.json')));
    assert.equal(proof.ownedClosure?.state,'observed');originalSession=status.sessionFile??status.steps[0]?.sessionFile;originalSessionBytes=fs.readFileSync(originalSession,'utf8');
    call={name:'subagent',arguments:JSON.stringify({action:'resume',id:ids[0],message:'Continue the closed local fixture with another read'})};
   }
   else if(logical===4&&scenario==='native'){assert.ok(!String(result?.content).includes('unavailable'));call={name:'subagent_wait',arguments:JSON.stringify({all:true,timeoutMs:60000})};}
   else if(logical===5&&scenario==='native'){assert.match(String(result?.content),/; done/);waitSeen=true;}
   else if(logical===3&&['wait','workflow'].includes(scenario)){assert.doesNotMatch(String(result?.content),/Nothing to wait for/);assert.match(String(result?.content),/; done/);assert.ok(fs.existsSync(marker),'Wait returned before effect');waitSeen=true;}
   else assert.fail('Unexpected provider replay');
  }
 } catch(error) {errors.push(error.message);content='FIXTURE_REJECTED';call=undefined;}
 send(res,index,'controller',call,content);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(home,'.pi/agent/models.json'),JSON.stringify({providers:{'owned-local':{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'local-fixture-not-a-credential',models:[{id:'controller',reasoning:false,contextWindow:128000,maxTokens:4096},{id:'native',reasoning:false,contextWindow:128000,maxTokens:4096}]}}}),{mode:0o600});
const log=fs.openSync(path.join(work,'cli.log'),'wx',0o600);let pending='';
const args=[...(persistence==='transient'?['--no-session']:['--session-dir',path.join(work,'parent-sessions')]),'--mode','json','--provider','owned-local','--model','controller','--thinking','off','-p','ACTUAL_PRODUCT_SMOKE α'];
const child=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',chunk=>{fs.writeSync(log,chunk);pending+=chunk;assert.ok(pending.length<2_000_000);let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const e=JSON.parse(line);if(e.type==='tool_execution_end')events.push(e)}catch{}}});
child.stderr.on('data',chunk=>fs.writeSync(log,chunk));
const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
const closed=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
clearTimeout(timer);fs.closeSync(log);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
const storeMarker=JSON.parse(fs.readFileSync(path.join(base,'.owned-process-groups-v2.json')));
assert.equal(storeMarker.version,3);assert.equal(storeMarker.scope,scope);assert.equal(fs.realpathSync(storeMarker.baseRoot),fs.realpathSync(base));
const inspect=spawnSync(process.execPath,[path.join(subagentRoot,'owned-store.mjs'),'inspect','--base',base],{env,encoding:'utf8',timeout:30000});
assert.equal(inspect.status,0,inspect.stderr);const inspected=JSON.parse(inspect.stdout);
assert.equal(inspected.scope,scope);assert.equal(inspected.root,storeMarker.root);assert.equal(inspected.recoveryAuthorized,false);assert.equal(inspected.liveSessionMigration,false);
const evidence={work,productVersion:manifest.version,subagentVersion:subagent.version,scenario,deferred,persistence,builtinAgent,defaultScopeFromProduct:true,storeCreatedByProduct:storeMarker.storeId.length===36,requests,nativeRequests,scopedDescription,rejectionSeen,waitSeen,searchSeen,errors,closed};
fs.writeFileSync(path.join(work,'metadata.json'),JSON.stringify(evidence),{mode:0o600});
assert.equal(closed.code,0,JSON.stringify(evidence));assert.deepEqual(errors,[]);assert.equal(requests,(scenario==='native'?6:scenario==='drain'?3:4)+(deferred==='1'?1:0));assert.equal(nativeRequests,['native','workflow'].includes(scenario)?4:0);
assert.ok(scopedDescription&&rejectionSeen);assert.equal(waitSeen,scenario!=='drain');assert.equal(searchSeen,deferred==='1');
if(scenario!=='native')assert.equal(fs.realpathSync(JSON.parse(fs.readFileSync(marker)).cwd),fs.realpathSync(cwd));
const launch=events.filter(e=>e.toolName==='subagent'&&e.result?.details?.asyncId);assert.equal(launch.length,scenario==='native'?2:1);
const runId=launch.at(-1).result.details.asyncId,runRoot=path.join(base,scope,'async-subagent-runs');
const dirs=fs.readdirSync(runRoot).filter(n=>!['.active-runs','.terminal-runs'].includes(n)&&fs.statSync(path.join(runRoot,n)).isDirectory());if(scenario==='workflow') {
 assert.equal(dirs.length,4);const workflow=JSON.parse(fs.readFileSync(path.join(runRoot,runId,'process-terminal-candidate.json'))).ownedWorkflow;
 assert.equal(workflow.sealed,true);assert.ok(workflow.controllerClosedAt);assert.equal(workflow.admissions.length,3);
 for(const admission of workflow.admissions) {
  const dir=path.join(runRoot,admission.childRunId);
  if(admission.kind==='foreground') {const fg=JSON.parse(fs.readFileSync(path.join(dir,'process-terminal-candidate.json'))).ownedForeground;assert.ok(fg.pipelineClosedAt&&fg.hostReturnedAt);assert.equal(fg.coverageComplete,true);}
  else {const proof=JSON.parse(fs.readFileSync(path.join(dir,'process-terminal.json'))).ownedClosure;assert.equal(proof.state,'observed');assert.equal(proof.workflowParent.workflowRunId,runId);assert.equal(proof.workflowParent.controllerInstanceId,workflow.controllerInstanceId);assert.equal(proof.workflowParent.admissionId,admission.admissionId);}
 }
} else {
 assert.deepEqual(dirs.sort(),[...new Set(launch.map(e=>e.result.details.asyncId))].sort());
 const terminal=JSON.parse(fs.readFileSync(path.join(runRoot,runId,'process-terminal.json')));
 assert.equal(terminal.ownedClosure?.state,'observed');assert.equal(terminal.ownedClosure?.descendantCoverage,'unverified');assert.equal(terminal.ownedClosure?.effectVerification,'unverified');
}
if(scenario==='native') {
 const status=JSON.parse(fs.readFileSync(path.join(runRoot,runId,'status.json'))),candidate=JSON.parse(fs.readFileSync(path.join(runRoot,runId,'process-terminal-candidate.json')));
 assert.equal(status.state,'complete');assert.equal(fs.realpathSync(status.sessionFile??status.steps[0]?.sessionFile),fs.realpathSync(originalSession));
 const bytes=fs.readFileSync(originalSession,'utf8');assert.ok(bytes.startsWith(originalSessionBytes)&&bytes.length>originalSessionBytes.length);assert.equal(candidate.revivalLeaseReleaseAcknowledged,true);
}
if(persistence==='persistent')assert.ok(fs.readdirSync(path.join(work,'parent-sessions')).some(n=>n.endsWith('.jsonl')));
console.log(JSON.stringify({...evidence,publicNpmBin:true,argvPreserved:true,externalEffectInBusinessCwd:scenario!=='native',nativeLeaseAndSessionPreserved:scenario==='native',ownedResourceCloseObserved:true,descendantsAndEffects:'unverified',remoteModelCalls:0}));
