// Synthetic ownership records test wait decisions, not real descendant closure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {probePiVersion} from '../../../rotom/runtime/verify-pi-runtime.mjs';
import {snapshot,sourceDigest} from '../scripts/source.mjs';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-readiness-unit-')));
const source=snapshot(root);
assert.ok(!source.split(path.sep).includes('node_modules'));
const pi=await probePiVersion({executable:process.env.ROTOM_PI??process.env.ROTOM_VERIFIED_PI_EXECUTABLE});
const parentURL=pathToFileURL(path.join(pi.packageRoot,'package.json')).href;
const hooks=registerHooks({resolve(specifier,ctx,next){return next(specifier,specifier.startsWith('@earendil-works/')?{...ctx,parentURL}:ctx)}});
const oldEnv={...process.env},oldFetch=globalThis.fetch;
const base=path.join(root,'store');
const load=file=>import(pathToFileURL(path.join(source,file)));
const {initializeExecutionStore}=await load('src/shared/execution-store.ts');
initializeExecutionStore(base);
Object.assign(process.env,{HOME:root,PI_SUBAGENTS_TEMP_ROOT:base,PI_SUBAGENTS_EXECUTION_SCOPE:'owned-process-groups-v2'});
globalThis.fetch=()=>{throw Error('Network forbidden in readiness units')};
const {DIRS,EXECUTION_STORE}=await load('src/shared/types.ts');
const {writePrivateAtomicJson}=await load('src/shared/atomic-json.ts');
const {waitForSubagents}=await load('src/runs/background/subagent-wait.ts');
const {drainOutstandingWork}=await load('src/runs/background/auto-drain.ts');
const {ownedClosureObserved,ownedClosureWasObserved}=await load('src/runs/background/owned-execution.ts');
const {acquireSessionLease,canonicalSessionId}=await load('src/runs/shared/session-lease.ts');
const {acquireActiveAsyncCapacity}=await load('src/runs/background/active-async-capacity.ts');
const {updateActiveRunIndex}=await load('src/runs/background/active-run-index.ts');
const {beginOwnedWorkflow,closeOwnedWorkflow}=await load('src/runs/background/owned-workflow.ts');
fs.mkdirSync(DIRS.async,{recursive:true,mode:0o700});
test.after(()=>{hooks.deregister();globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv)});

function fixture() {
 const id=randomUUID(),session=randomUUID(),dir=path.join(DIRS.async,id);fs.mkdirSync(dir,{mode:0o700});
 const job={asyncId:id,asyncDir:dir,status:'queued',pid:process.pid,sessionId:session,startedAt:Date.now(),
  nestedRoute:{rootRunId:randomUUID(),eventSink:path.join(dir,'events'),controlInbox:path.join(dir,'control'),capabilityToken:randomUUID()}};
 const state={currentSessionId:session,asyncJobs:new Map([[id,job]]),foregroundRuns:new Map(),workflowControllers:new Map()};
 const runner=randomUUID();let now=Date.now(),sleeps=0;
 const deps={state,now:()=>now,sleep:async ms=>{sleeps++;now+=ms},backgroundWork:{snapshot:()=>({providers:[],items:[]}),wakeChannels:()=>[]}};
 const status={runId:id,sessionId:session,mode:'single',state:'complete',pid:process.pid,startedAt:now,lastUpdate:now,
  ownedExecutionScope:EXECUTION_STORE.scope,processTerminal:{version:1,state:'pending',runId:id,runnerProcessInstanceId:runner}};
 // Match the producer's atomic inode replacement; in-place same-size writes
 // can collide with the status reader's metadata cache on fast filesystems.
 const save=(index=true)=>{writePrivateAtomicJson(path.join(dir,'status.json'),status);if(index)updateActiveRunIndex(dir,status.state)};
 const close=()=>{const terminal={version:1,state:'unknown',reason:'external-descendants-unverified',runId:id,runnerProcessInstanceId:runner,
  ownedClosure:{version:2,scope:EXECUTION_STORE.scope,storeId:EXECUTION_STORE.storeId,state:'observed',runId:id,runnerProcessInstanceId:runner,
   observedAt:Date.now(),writers:[],descendantCoverage:'unverified',effectVerification:'unverified'}};
  fs.writeFileSync(path.join(dir,'process-terminal.json'),JSON.stringify(terminal));return terminal};
 const wait=params=>waitForSubagents({all:true,timeoutMs:20,...params},undefined,deps);
 return {id,dir,session,runner,job,state,deps,status,save,close,wait,get sleeps(){return sleeps}};
}
const text=result=>result.content.map(c=>c.text??'').join('\n');

test('test snapshot matches current maintained source',()=>assert.deepEqual(sourceDigest(source),sourceDigest()));
test('receipt roster retains a wait before status/index publication despite distinct transport root',async()=>{
 const f=fixture(),r=await f.wait();assert.equal(r.isError,true);assert.match(text(r),/timed out.*1 async run/s);assert.doesNotMatch(text(r),/Nothing to wait/);assert.ok(f.sleeps>0);
});
test('terminal memory state with missing durable records is not an empty wait',async()=>{
 const f=fixture();f.job.status='complete';const r=await f.wait();assert.equal(r.isError,true);assert.match(text(r),/records unavailable/);assert.doesNotMatch(text(r),/Nothing to wait/);
});
test('exact id and prefix find the unpublished admitted run',async()=>{
 const f=fixture();for(const id of [f.id,f.id.slice(0,8)])assert.match(text(await f.wait({id})),/timed out.*1 async run/s);
});
test('foreign session roster does not become current work',async()=>{
 const f=fixture();f.job.sessionId=randomUUID();assert.match(text(await f.wait()),/Nothing to wait/);
});
test('out-of-namespace roster is not adopted',async()=>{
 const f=fixture();f.job.asyncDir=path.join(root,'foreign',f.id);assert.match(text(await f.wait()),/Nothing to wait/);
});
test('missing index does not hide an admitted running status',async()=>{
 const f=fixture();f.status.state='running';f.save(false);assert.match(text(await f.wait()),/timed out.*1 async run/s);
});
test('task complete is still pending until owned resource proof is published',async()=>{
 const f=fixture();f.save();const sleep=f.deps.sleep;f.deps.sleep=async ms=>{f.close();await sleep(ms)};
 const r=await f.wait({timeoutMs:1000});assert.ok(f.sleeps>0);assert.match(text(r),/done/);assert.ok(!r.isError);
});
test('completed task with missing close proof remains bounded and unconfirmed',async()=>{
 const f=fixture();f.save();assert.match(text(await f.wait()),/timed out.*1 async run/s);
});
test('explicit unknown resource proof never becomes task completion',async()=>{
 const f=fixture();f.save();const proof=f.close();proof.ownedClosure.state='unknown';fs.writeFileSync(path.join(f.dir,'process-terminal.json'),JSON.stringify(proof));
 const r=await f.wait();assert.equal(r.isError,true);assert.match(text(r),/closure unavailable/);assert.doesNotMatch(text(r),/; done/);
});
test('a new lease cannot reopen historical close, but still fences capacity/recovery',async()=>{
 const f=fixture(),sessionFile=path.join(EXECUTION_STORE.sessionRoot,randomUUID()+'.jsonl');fs.writeFileSync(sessionFile,'');
 const old=acquireSessionLease({sessionFile,runId:f.id,sourceRunId:f.id});old.updateWriter({state:'none'});assert.equal(old.release(),true);f.save();const proof=f.close(),now=Date.now();
 proof.ownedClosure.writers=[{processInstanceId:randomUUID(),kind:'pi-writer',stepIndex:0,attempt:0,
  sessionLease:{state:'held',sessionFile,canonicalSessionId:canonicalSessionId(sessionFile),token:old.owner.token,released:true},
  close:{closeObservedAt:now,processTree:{state:'observed',mechanism:'posix-process-group',processGroupId:process.pid,verifiedAt:now}}}];
 proof.ownedClosure.observedAt=now;writePrivateAtomicJson(path.join(f.dir,'process-terminal.json'),proof);
 const expected={runId:f.id,runnerProcessInstanceId:f.runner};assert.equal(ownedClosureObserved(proof.ownedClosure,expected),true);
 const next=acquireSessionLease({sessionFile,runId:randomUUID(),sourceRunId:f.id});next.updateWriter({state:'none'});
 try {assert.equal(ownedClosureWasObserved(proof.ownedClosure,expected),true);assert.equal(ownedClosureObserved(proof.ownedClosure,expected),false);assert.match(text(await f.wait()),/Nothing to wait/);
  proof.ownedClosure.writers[0].sessionLease.released=false;assert.equal(ownedClosureWasObserved(proof.ownedClosure,expected),false);
 }finally{assert.equal(next.release(),true)}
});
test('runner instance mismatch beats historical proof even with an identical PID',async()=>{
 const f=fixture();f.save();f.close();
 const capacity=acquireActiveAsyncCapacity({sessionId:f.session,runId:f.id,asyncDir:f.dir,kind:'runner',limit:1,scope:EXECUTION_STORE.scope});assert.ok(capacity);capacity.markStarted(randomUUID());
 assert.match(text(await f.wait()),/timed out.*1 async/s);
});
test('current capacity binding cannot be bypassed by historical proof',async()=>{
 const f=fixture();f.save();f.close();
 const capacity=acquireActiveAsyncCapacity({sessionId:f.session,runId:f.id,asyncDir:f.dir,kind:'runner',limit:1,scope:EXECUTION_STORE.scope});assert.ok(capacity);capacity.markStarted(f.runner);
 assert.match(text(await f.wait()),/closure unavailable/i);
});
test('queued native revival cannot consume its preceding runner proof',async()=>{
 const f=fixture();f.save();f.close();f.status.pid=process.pid+1;f.save();assert.match(text(await f.wait()),/timed out.*1 async run/s);
});
test('unlimited workflow waits for sealed actual controller closure, not empty steps',async()=>{
 const f=fixture();f.status.mode='workflow';f.job.mode='workflow';f.save();const handle=beginOwnedWorkflow(f.dir,f.id,f.session);
 const sleep=f.deps.sleep;f.deps.sleep=async ms=>{closeOwnedWorkflow(f.dir,handle);await sleep(ms)};
 const r=await f.wait({timeoutMs:1000});assert.ok(f.sleeps>0);assert.match(text(r),/done/);assert.ok(!r.isError);
});
test('headless precheck cannot skip an unpublished admitted run',async()=>{
 const f=fixture();let called=0;
 await drainOutstandingWork({state:f.state,wait:async()=>{called++;f.save();f.close();return {content:[],details:{mode:'management',results:[]}}}});
 assert.equal(called,1);
});
test('headless precheck waits beyond task completion for resource proof',async()=>{
 const f=fixture();f.save();let called=0;
 await drainOutstandingWork({state:f.state,wait:async()=>{called++;f.close();return {content:[],details:{mode:'management',results:[]}}}});
 assert.equal(called,1);
});
test('headless unknown proof cannot silently drain',async()=>{
 const f=fixture();f.save();const proof=f.close();delete proof.ownedClosure;fs.writeFileSync(path.join(f.dir,'process-terminal.json'),JSON.stringify(proof));
 await assert.rejects(drainOutstandingWork({state:f.state}),/closure unavailable/);
});
test('unsealed workflow remains pending without a live controller or capacity slot',async()=>{
 const f=fixture();f.status.mode='workflow';f.job.mode='workflow';f.save();beginOwnedWorkflow(f.dir,f.id,f.session);assert.match(text(await f.wait()),/timed out.*1 async run/s);
});
