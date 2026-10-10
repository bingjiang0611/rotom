// File-backed synthetic proofs check diagnostic decisions, not real OS closure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {probePiVersion} from '../../../rotom/runtime/verify-pi-runtime.mjs';
import {snapshot} from '../scripts/source.mjs';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-status-unit-')));
const source=snapshot(root),load=file=>import(pathToFileURL(path.join(source,file)));
const pi=await probePiVersion({executable:process.env.ROTOM_PI??process.env.ROTOM_VERIFIED_PI_EXECUTABLE});
const parentURL=pathToFileURL(path.join(pi.packageRoot,'package.json')).href;
const hooks=registerHooks({resolve(specifier,ctx,next){return next(specifier,specifier.startsWith('@earendil-works/')?{...ctx,parentURL}:ctx)}});
const oldEnv={...process.env},oldFetch=globalThis.fetch;
const base=path.join(root,'store');
const {initializeExecutionStore}=await load('src/shared/execution-store.ts');
initializeExecutionStore(base);
Object.assign(process.env,{HOME:root,PI_SUBAGENTS_TEMP_ROOT:base,PI_SUBAGENTS_EXECUTION_SCOPE:'owned-process-groups-v2'});
globalThis.fetch=()=>{throw Error('Network forbidden in status units')};
const {DIRS,EXECUTION_STORE}=await load('src/shared/types.ts');
const {inspectSubagentStatus}=await load('src/runs/background/run-status.ts');
const {writePrivateAtomicJson}=await load('src/shared/atomic-json.ts');
const {finalizeProcessTerminal,writeProcessTerminalCandidate,readProcessTerminal}=await load('src/runs/background/process-terminal.ts');
const {acquireSessionLease,canonicalSessionId}=await load('src/runs/shared/session-lease.ts');
const {createRunFanoutBudget}=await load('src/runs/shared/run-fanout-budget.ts');
fs.mkdirSync(DIRS.async,{recursive:true,mode:0o700});
test.after(()=>{hooks.deregister();globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv)});
const text=result=>result.content.map(c=>c.text??'').join('\n');

function fixture() {
 const id=randomUUID(),session=randomUUID(),runner=randomUUID(),dir=path.join(DIRS.async,id);
 fs.mkdirSync(dir,{mode:0o700});
 const sessionFile=path.join(EXECUTION_STORE.sessionRoot,randomUUID()+'.jsonl');fs.writeFileSync(sessionFile,'');
 const now=Date.now();
 const status={runId:id,sessionId:session,mode:'single',state:'complete',pid:process.pid,startedAt:now,lastUpdate:now,cwd:root,sessionFile,
  steps:[{agent:'scout',status:'complete',description:'Read-only investigation of session correctness',sessionFile}],
  ownedExecutionScope:EXECUTION_STORE.scope,processTerminal:{version:1,state:'pending',runId:id,runnerProcessInstanceId:runner}};
 const state={currentSessionId:session,asyncJobs:new Map(),foregroundRuns:new Map(),foregroundControls:new Map(),workflowControllers:new Map()};
 const save=()=>writePrivateAtomicJson(path.join(dir,'status.json'),status);
 const inspect=(params={},deps={})=>text(inspectSubagentStatus({id,...params},{state,...deps}));
 const close=()=>{
  const observedAt=Date.now();
  const proof={version:1,state:'observed',observedAt,runId:id,runnerProcessInstanceId:runner,
   instances:[{kind:'runner',processInstanceId:runner,closeObservedAt:observedAt,exitCode:0,signal:null}],
   ownedClosure:{version:2,scope:EXECUTION_STORE.scope,storeId:EXECUTION_STORE.storeId,state:'observed',runId:id,runnerProcessInstanceId:runner,
    observedAt:Date.now(),writers:[],descendantCoverage:'unverified',effectVerification:'unverified'}};
  writePrivateAtomicJson(path.join(dir,'process-terminal.json'),proof);return proof;
 };
 const descriptor=()=>writePrivateAtomicJson(path.join(dir,'recovery-descriptor.json'),{version:1,sourceRunId:id,agent:'scout',cwd:root,
  systemPromptMode:'replace',outputMode:'inline',inheritProjectContext:true,inheritSkills:false,share:false,maxSubagentDepth:1,tools:['read'],extensions:[],runFanoutBudget:createRunFanoutBudget(id,4)});
 return {id,dir,runner,sessionFile,status,state,save,inspect,close,descriptor};
}

test('one status call shows task, bounded output and missing closure without inventing recovery',()=>{
 const f=fixture();f.save();fs.writeFileSync(path.join(f.dir,'output-0.log'),Array.from({length:20},(_,i)=>`line-${i}`).join('\n'));
 const result=f.inspect();assert.match(result,/Task: Read-only investigation/u);assert.match(result,/Process terminal: pending/u);
 assert.match(result,/Registered-resource closure: unavailable/u);assert.match(result,/Resume: unavailable.*Owned execution closure unavailable/u);
 assert.match(result,/Latest output \(bounded tail, not a full transcript\)/u);assert.match(result,/line-19/u);assert.doesNotMatch(result,/line-0\b/u);
 assert.doesNotMatch(result,/Continue original run|Revive:/u);
});
test('output tail retains current-session and contained-path fences',()=>{
 const f=fixture();f.save();fs.writeFileSync(path.join(f.dir,'output-0.log'),'private fixture output');
 assert.doesNotMatch(f.inspect({}, {state:{...f.state,currentSessionId:randomUUID()}}),/private fixture output/u);
 fs.unlinkSync(path.join(f.dir,'output-0.log'));const outside=path.join(root,'outside.log');fs.writeFileSync(outside,'outside fixture output');
 fs.symlinkSync(outside,path.join(f.dir,'output-0.log'));
 assert.doesNotMatch(f.inspect(),/outside fixture output/u);assert.match(f.inspect(),/Refusing/u);
});
test('preflight requires the original contract and stays a snapshot, not a launch receipt',()=>{
 const f=fixture();f.save();f.close();assert.match(f.inspect(),/missing recovery descriptor/u);
 f.descriptor();const before=fs.readFileSync(path.join(f.dir,'process-terminal.json'));
 assert.match(f.inspect(),/Resume: preflight passed; not launch authorization/u);
 assert.match(f.inspect(),/Continue original run/u);assert.deepEqual(fs.readFileSync(path.join(f.dir,'process-terminal.json')),before);
 f.status.state='stopped';f.save();assert.doesNotMatch(f.inspect(),/Continue original run/u);
});
test('historical registered closure does not authorize recovery through an occupied canonical lease',()=>{
 const f=fixture(),lease=acquireSessionLease({sessionFile:f.sessionFile,runId:f.id,sourceRunId:f.id});
 lease.updateWriter({state:'none'});assert.equal(lease.release(),true);f.save();f.descriptor();const proof=f.close(),now=Date.now();
 proof.ownedClosure.writers=[{processInstanceId:randomUUID(),kind:'pi-writer',stepIndex:0,attempt:0,
  sessionLease:{state:'held',sessionFile:f.sessionFile,canonicalSessionId:canonicalSessionId(f.sessionFile),token:lease.owner.token,released:true},
  close:{closeObservedAt:now,processTree:{state:'observed',mechanism:'posix-process-group',processGroupId:process.pid,verifiedAt:now}}}];
 proof.ownedClosure.observedAt=now;writePrivateAtomicJson(path.join(f.dir,'process-terminal.json'),proof);
 assert.match(f.inspect(),/Resume: preflight passed/u);
 const next=acquireSessionLease({sessionFile:f.sessionFile,runId:randomUUID(),sourceRunId:f.id});next.updateWriter({state:'none'});
 try {const result=f.inspect();assert.match(result,/Registered-resource closure: observed \(historical/u);assert.match(result,/Resume: unavailable/u);assert.doesNotMatch(result,/Continue original run/u)}
 finally {assert.equal(next.release(),true)}
});
test('remembered foreground session files do not advertise recovery in owned scope',()=>{
 const f=fixture(),id=randomUUID();
 f.state.foregroundRuns.set(id,{runId:id,sessionId:f.state.currentSessionId,mode:'single',updatedAt:Date.now(),cwd:root,
  children:[{index:0,agent:'scout',status:'completed',sessionFile:f.sessionFile}]});
 const result=text(inspectSubagentStatus({id},{state:f.state}));
 assert.match(result,/owned foreground\/workflow-child recovery is not admitted/u);assert.doesNotMatch(result,/Revive/u);
});
test('store identity failure during close publishes unknown instead of escaping the callback',()=>{
 const f=fixture();f.save();
 writeProcessTerminalCandidate(f.dir,{version:1,runId:f.id,runnerProcessInstanceId:f.runner,writers:{'0':[]},expectedWriters:{'0':0},
  ownedExecution:{version:2,scope:EXECUTION_STORE.scope,storeId:EXECUTION_STORE.storeId,runId:f.id,runnerProcessInstanceId:f.runner,sealed:true,coverageComplete:true,writers:[]}});
 const marker=path.join(base,'.owned-process-groups-v2.json'),original=fs.readFileSync(marker);
 const value=JSON.parse(original);value.storeId=randomUUID();fs.writeFileSync(marker,JSON.stringify(value));
 try {
  const proof=finalizeProcessTerminal(f.dir,f.id,{processInstanceId:f.runner,closeObservedAt:Date.now(),exitCode:0,signal:null});
  assert.equal(proof.state,'unknown');assert.match(proof.diagnostic,/Execution store identity drift/u);assert.equal(proof.ownedClosure,undefined);
  assert.deepEqual(readProcessTerminal(f.dir),proof);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'status.json'))).processTerminal.state,'unknown');
 } finally {fs.writeFileSync(marker,original)}
 assert.match(f.inspect(),/Resume: unavailable/u);assert.doesNotMatch(f.inspect(),/Continue original run/u);
});
test('result-only task success cannot manufacture closure or a replacement-writer hint',()=>{
 const id=randomUUID();fs.mkdirSync(DIRS.results,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(DIRS.results,id+'.json'),JSON.stringify({id,success:true,agent:'scout',state:'complete',ownedExecutionScope:EXECUTION_STORE.scope}));
 const result=text(inspectSubagentStatus({id}));assert.match(result,/result-only view/u);assert.match(result,/Resume: unavailable/u);assert.doesNotMatch(result,/Revive|Start a new run|Continue original run/u);
});
