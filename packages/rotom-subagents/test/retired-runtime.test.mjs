// Invoke maintained registration/lifecycle code with a recording API. No model
// or child is started; real SDK/process paths are exercised by test:sdk separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {probePiVersion} from '../../../rotom/runtime/verify-pi-runtime.mjs';
import {snapshot} from '../scripts/source.mjs';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-retired-unit-')));
const source=snapshot(root),load=file=>import(pathToFileURL(path.join(source,file)));
const pi=await probePiVersion({executable:process.env.ROTOM_PI??process.env.ROTOM_VERIFIED_PI_EXECUTABLE});
const parentURL=pathToFileURL(path.join(pi.packageRoot,'package.json')).href;
const hooks=registerHooks({resolve(specifier,ctx,next){return next(specifier,specifier.startsWith('@earendil-works/')?{...ctx,parentURL}:ctx)}});
const oldEnv={...process.env},oldFetch=globalThis.fetch;
const base=path.join(root,'store'),agentDir=path.join(root,'agent'),cwd=path.join(root,'business');
const {initializeExecutionStore}=await load('src/shared/execution-store.ts');initializeExecutionStore(base);
Object.assign(process.env,{HOME:root,PI_CODING_AGENT_DIR:agentDir,PI_SUBAGENTS_TEMP_ROOT:base,PI_SUBAGENTS_EXECUTION_SCOPE:'owned-process-groups-v2'});
globalThis.fetch=()=>{throw Error('Network forbidden in retired-runtime units')};
fs.mkdirSync(cwd,{mode:0o700});fs.mkdirSync(path.join(agentDir,'extensions/subagent'),{recursive:true,mode:0o700});
const retiredSchedules=path.join(root,'retired-schedules'),retiredMissions=path.join(cwd,'.pi/subagents/missions');
fs.mkdirSync(retiredSchedules,{mode:0o700});fs.mkdirSync(retiredMissions,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(retiredSchedules,'due.json'),JSON.stringify({id:'fixture-due',paused:false,trigger:{nextRunAt:'2000-01-01T00:00:00.000Z'}}));
fs.writeFileSync(path.join(retiredMissions,'goal.json'),'{}');
fs.writeFileSync(path.join(agentDir,'extensions/subagent/config.json'),JSON.stringify({scheduledRuns:{enabled:true,storeRoot:retiredSchedules},fleetView:false,asyncWidget:false}));
const {default:register}=await load('src/extension/index.ts');
const {SUBAGENT_ACTIONS}=await load('src/shared/types.ts');
test.after(()=>{hooks.deregister();globalThis.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in oldEnv))delete process.env[k];Object.assign(process.env,oldEnv)});

test('session start/end never bind retired schedules, scan missions or start legacy continuation',async()=>{
 const handlers=new Map(),tools=new Map(),publications=[],accesses=[];
 const emitters=new EventEmitter();
 const api={events:{on(name,fn){emitters.on(name,fn);return()=>emitters.off(name,fn)},emit:(...args)=>emitters.emit(...args)},
  on(name,fn){handlers.set(name,[...(handlers.get(name)??[]),fn]);return()=>{}},registerTool(def){tools.set(def.name,def)},registerCommand(){},registerShortcut(){},registerMessageRenderer(){},
  getActiveTools(){return[]},getAllTools(){return[]},sendMessage(...args){publications.push(args)},sendUserMessage(...args){publications.push(args)},appendEntry(){},exec(){throw Error('No external command authorized')}};
 const sessionManager={getSessionId:()=> 'retired-fixture',getSessionFile:()=>null,getBranch:()=>[],getEntries:()=>[],getLeafId:()=>undefined};
 const ctx={cwd,hasUI:false,mode:'print',sessionManager,isIdle:()=>true,ui:{notify(){},setStatus(){},setWidget(){},theme:{fg:(_color,text)=>text}}};
 const originals=Object.fromEntries(['readFileSync','readdirSync','existsSync','mkdirSync','writeFileSync'].map(name=>[name,fs[name]]));
 for(const [name,fn] of Object.entries(originals))fs[name]=function(file,...args){const p=String(file);if(p.includes(retiredSchedules)||p.includes(retiredMissions)||p.includes('mission-observers'))accesses.push({name,path:p});return fn.call(this,file,...args)};
 syncBuiltinESMExports();
 try {
  register(api);
  for(const fn of handlers.get('session_start')??[])await fn({reason:'startup'},ctx);
  for(const fn of handlers.get('agent_end')??[])await fn({messages:[]},ctx);
  assert.deepEqual(accesses,[]);assert.deepEqual(publications,[]);
  assert.ok(tools.has('subagent'));assert.ok(tools.has('subagent_wait'));
  assert.equal(SUBAGENT_ACTIONS.some(action=>action.startsWith('schedule.')),false);
 } finally {
  for(const fn of handlers.get('session_shutdown')??[])await fn({reason:'quit'},ctx);
  Object.assign(fs,originals);syncBuiltinESMExports();
 }
 assert.ok(fs.existsSync(path.join(retiredSchedules,'due.json')),'retirement must not delete historical schedules');
 assert.ok(fs.existsSync(path.join(retiredMissions,'goal.json')),'retirement must not delete historical missions');
});
