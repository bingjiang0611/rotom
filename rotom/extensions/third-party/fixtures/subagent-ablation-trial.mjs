// Bounded real-model synthetic trial. No raw messages/tool arguments in the result.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadProductRuntime} from '../../../evals/src/product-runtime.ts';
import {tasks,scope,taskTimeoutMs} from './subagent-ablation-profile.mjs';
import {observeSpawnClosure} from './subagent-ablation-spawns.mjs';
import {auditThinking} from './subagent-followthrough-model-audit.mjs';
const [rootArg,variant,taskId,repeatArg,mode='live',revision='v2']=process.argv.slice(2);
if(!['v2','v3','v4'].includes(revision)||!['live','dry'].includes(mode))throw Error('invalid trial revision/mode');
const root=fs.realpathSync(rootArg);
if(!(revision==='v4'?['baseline','candidate']:['baseline','full','slim']).includes(variant)||!/^\d$/.test(repeatArg))throw Error('invalid trial coordinate');
const task=tasks.find(t=>t.id===taskId);if(!task)throw Error('unknown fixed task');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
if(manifest.authorization?.estimatedUsdMax!==20||manifest.authorization?.modelWindowMs!==7200000)throw Error('missing current authorization');
const trial=path.join(root,'trials',`${revision}-${taskId}-${repeatArg}-${variant}`);
fs.mkdirSync(trial,{recursive:false,mode:0o700});
const stage=name=>fs.writeFileSync(path.join(trial,'stage.json'),JSON.stringify({stage:name,pid:process.pid,at:new Date().toISOString()}),{mode:0o600});
stage('fixture');
const cwd=path.join(trial,'project');fs.mkdirSync(cwd,{mode:0o700});
const agentDir=path.join(trial,'config');fs.mkdirSync(agentDir,{mode:0o700});
const sessions=path.join(trial,'sessions');fs.mkdirSync(sessions,{mode:0o700});
for(const [name,body]of Object.entries(task.files))fs.writeFileSync(path.join(cwd,name),body,{mode:0o600});
fs.mkdirSync(path.join(cwd,'.pi/agents'),{recursive:true});
fs.writeFileSync(path.join(cwd,'.pi/agents/fixture.md'),`---\nname: fixture\ndescription: Bounded local fixture worker\nmodel: openai-codex/gpt-5.4-mini\n${revision==='v4'?'thinking: "off"\ndefaultContext: fresh\ninheritProjectContext: false\ninheritSkills: false\n':''}tools: read, bash, edit, write\n---\nWork only in the task cwd, without network or platform calls. Do not inspect parent directories or credentials. Implement only the specified task, test it and return a concise result. Never spawn another agent.\n`,{mode:0o600});
function command(cmd,args,options={}){return spawnSync(cmd,args,{cwd,encoding:'utf8',timeout:5000,maxBuffer:1024*1024,...options});}
for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@invalid'],['add','.'],['commit','-qm','fixed fixture']]){const r=command('git',args);if(r.status!==0)throw Error('fixture git preflight failed');}
for(const key of Object.keys(process.env))if(key.startsWith('PI_SUBAGENT'))delete process.env[key];
process.env.PI_SUBAGENTS_TEMP_ROOT=path.join(trial,'runtime');
process.env.ROTOM_OBSERVABILITY='0';
process.env.ROTOM_DEFERRED_TOOLS='1';
process.env.PI_SUBAGENT_STARTUP_GATE=variant==='baseline'?'0':'1';
const spawns=observeSpawnClosure();
stage('runtime-verification');
const p=await loadProductRuntime({agentDir:path.join(root,'products',variant,'rotom')});
stage('model-runtime');
const pi=p.runtime;
process.env.PI_SUBAGENT_PI_BINARY=p.verified.executable;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=p.verified.packageRoot;
const mr=await pi.ModelRuntime.create({allowModelNetwork:false,signal:AbortSignal.timeout(15000)});
const baseModel=mr.getModel('openai-codex','gpt-5.4-mini');if(!baseModel)throw Error('authorized model unavailable');
const settings=pi.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
const eventBus=pi.createEventBus();
const resourcePaths=kind=>p.selectedResources.filter(r=>r.kind===kind).map(r=>path.join(p.agentDir,r.loadPath??r.path));
const loader=new pi.DefaultResourceLoader({cwd,agentDir,eventBus,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:resourcePaths('extension'),additionalSkillPaths:resourcePaths('skill'),additionalPromptTemplatePaths:resourcePaths('prompt'),appendSystemPrompt:[scope]});
stage('loader');
await loader.reload();if(loader.getExtensions().errors.length)throw Error('extension load failed');
stage('create-session');
const sm=pi.SessionManager.create(cwd,sessions);
const {session}=await pi.createAgentSession({cwd,agentDir,modelRuntime:mr,model:{...baseModel,maxTokens:2048},thinkingLevel:'off',tools:['read','write','edit','bash','search_tools','subagent','subagent_wait','subagent_supervisor'],resourceLoader:loader,settingsManager:settings,sessionManager:sm,sessionStartEvent:{type:'session_start',reason:'startup'}});
const unexpectedDialog=async()=>{throw Error('unexpected eval dialog');};
const ui={select:unexpectedDialog,confirm:unexpectedDialog,input:unexpectedDialog,editor:unexpectedDialog,custom:unexpectedDialog,notify(){},setStatus(){},setWidget(){},setFooter(){},setHeader(){},setWorkingMessage(){},setTitle(){},setEditorText(){},getEditorText(){return '';},setEditorComponent(){},getEditorComponent(){},getToolsExpanded(){return false;},setToolsExpanded(){},getAllThemes(){return [];},getTheme(){},setTheme(){return {success:false};},theme:{fg:(_c,s)=>s,bg:(_c,s)=>s,bold:s=>s,italic:s=>s,dim:s=>s,underline:s=>s}};
const result={schemaVersion:1,revision,variant,taskId,repeat:Number(repeatArg),piVersion:p.verified.version,mode,startedAt:new Date().toISOString(),toolCalls:{},toolErrors:0,parentTurns:0,providerErrors:0,lifecycleErrors:0,launches:0,runIds:[],attentionNotices:0,completionNotices:0,timedOut:false,turnBudgetExceeded:false,correct:false,finished:false,cleanupUnknown:false};
stage('bind');
await session.bindExtensions({mode:'rpc',uiContext:ui,onError:()=>result.lifecycleErrors++});
stage('bound');
result.initialTools=session.agent.state.tools.map(t=>t.name);
result.skills=loader.getSkills().skills.map(s=>s.name);
result.templates=loader.getPrompts().prompts.map(t=>t.name);
const runtimeRuns=()=>{
 const base=path.join(trial,'runtime','async-subagent-runs');if(!fs.existsSync(base))return [];
 return fs.readdirSync(base).flatMap(id=>{try{const s=JSON.parse(fs.readFileSync(path.join(base,id,'status.json'),'utf8'));return [{id,state:s.state,mode:s.mode,steps:s.steps?.length??0,completedSteps:s.steps?.filter(step=>step.status==='completed').length??0}];}catch{return [];}});
};
let timer;
const unsub=session.subscribe(e=>{
 if(e.type==='tool_execution_start'){
  result.toolCalls[e.toolName]=(result.toolCalls[e.toolName]??0)+1;
  if(e.toolName==='subagent'&&!e.args?.action)result.launches++;
 }
 if(e.type==='tool_execution_end'&&e.isError)result.toolErrors++;
 if(e.type==='message_end'&&e.message.role==='assistant'){
  result.parentTurns++;
  if(e.message.stopReason==='error')result.providerErrors++;
  if(result.parentTurns>=12){result.turnBudgetExceeded=true;void session.abort();}
 }
 if(e.type==='message_end'&&e.message.role==='custom'&&e.message.customType==='subagent-wait-subscription'){
  if(e.message.details?.outcome==='needs attention')result.attentionNotices++;
  if(e.message.details?.outcome==='completed')result.completionNotices++;
 }
});
result.waitReturns=[];
const waitUnsub=session.subscribe(e=>{
 if(e.type==='tool_execution_end'&&e.toolName==='subagent_wait')result.waitReturns.push({error:!!e.isError,terminalRunIds:runtimeRuns().filter(r=>r.state==='complete').map(r=>r.id)});
});
const begin=performance.now();
try{
 if(mode==='dry')result.finished=true;
 else{
  const budget=JSON.parse(fs.readFileSync(path.join(root,'budget.json'),'utf8'));
  if(Date.now()>budget.deadlineAt||budget.reportedUsd>=18)throw Error('budget exhausted');
  if(revision==='v4'&&(budget.status!=='model-authorized'||!fs.existsSync(path.join(root,'local-gates-reviewed.json'))))throw Error('local gates not reviewed');
  timer=setTimeout(()=>{result.timedOut=true;void session.abort();},taskTimeoutMs);timer.unref();
  stage('prompt');
  await session.prompt(task.prompt);
  await session.waitForIdle();
  result.finished=!result.timedOut&&!result.turnBudgetExceeded&&result.providerErrors===0;
  const verified=command(process.execPath,['--input-type=module','-e',task.verify]);
  result.correct=verified.status===0;
  result.verifierExit=verified.status;
 }
}catch(e){result.errorClass=e?.name??'Error';}
finally{
 clearTimeout(timer);
 result.elapsedMs=performance.now()-begin;
 result.parentStats=session.getSessionStats();
 result.runs=runtimeRuns();
 result.runIds=result.runs.map(r=>r.id);
 // Cleanup uses legal run IDs and the owning live API, never guessed PIDs.
 const stop=session.agent.state.tools.find(t=>t.name==='subagent');
 for(const r of result.runs.filter(r=>!['complete','completed','failed','cancelled','stopped'].includes(r.state))){
  if(!stop){result.cleanupUnknown=true;continue;}
  try{const outcome=await stop.execute(randomUUID(),{action:'stop',id:r.id},new AbortController().signal,()=>{});if(outcome.isError)result.cleanupUnknown=true;}catch{result.cleanupUnknown=true;}
 }
 try{await session.abort();await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});}catch{result.cleanupUnknown=true;}
 // Observe direct ChildProcess close, rather than confusing a terminal disk
 // status with stdio closure or waiting for Node beforeExit while Pi owns timers.
 stage('shutdown-requested');
 result.directSpawnCount=spawns.count;
 result.directSpawnsClosed=await spawns.wait();
 result.cleanupUnknown ||= !result.directSpawnsClosed;
 result.parentStats=session.getSessionStats();
 result.finalRuns=runtimeRuns();
 result.retirementMs=performance.now()-begin-result.elapsedMs;
 if(mode!=='dry')result.correct=command(process.execPath,['--input-type=module','-e',task.verify]).status===0;
 result.finished=result.finished&&!result.turnBudgetExceeded&&result.providerErrors===0;
 unsub();waitUnsub();
 if(revision==='v4'&&mode==='live'){
  try{result.thinkingAudit=auditThinking(sessions,sm.getSessionFile());}catch{result.thinkingAudit={pass:false,unknown:true};}
  result.conservativeSuccess=result.correct&&result.finished&&!result.cleanupUnknown&&result.thinkingAudit.pass
   &&result.thinkingAudit.childSessions===task.delegates
   &&result.runs.every(r=>r.state==='complete')
   &&result.runs.reduce((n,r)=>n+r.steps,0)===task.delegates
   &&result.runs.reduce((n,r)=>n+r.completedSteps,0)===task.delegates;
  result.attentionCompletionObserved=task.id==='attention-completion'&&result.attentionNotices>0&&result.waitReturns.some(w=>!w.error&&w.terminalRunIds.some(id=>result.runIds.includes(id)));
  if(task.id==='attention-completion')result.conservativeSuccess&&=result.attentionCompletionObserved;
 }
 if(result.directSpawnsClosed){session.dispose();spawns.restore();stage('disposed');}
 result.traceDigest=createHash('sha256').update(JSON.stringify({toolCalls:result.toolCalls,runs:result.runs})).digest('hex');
 fs.writeFileSync(path.join(trial,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify({variant,taskId,repeat:result.repeat,correct:result.correct,finished:result.finished,turns:result.parentTurns,launches:result.launches,elapsedMs:result.elapsedMs,cleanupUnknown:result.cleanupUnknown}));
}
