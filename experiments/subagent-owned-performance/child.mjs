// One fresh SDK host + one real native Subagent writer. No controller model call.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const stamp=()=>performance.timeOrigin+performance.now();
const readJSON=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}};
const watchdog=setTimeout(()=>{fs.writeFileSync(c.result,JSON.stringify({state:'unknown',reason:'host-deadline'}),{mode:0o600});process.exit(3);},180000);
try {
 const pi=await import(pathToFileURL(c.piEntry));
 const modelRuntime=await pi.ModelRuntime.create(c.dry?{authPath:path.join(c.home,'auth.json'),modelsPath:null,allowModelNetwork:false}:{allowModelNetwork:false});
 let model;
 if(c.dry){
  const {fauxProvider}=await import(pathToFileURL(c.fauxEntry));const f=fauxProvider({provider:'scope-bench',models:[{id:'fixture',contextWindow:100000}]});
  modelRuntime.registerProvider(f.provider.id,{name:f.provider.name,api:f.api,apiKey:'fixture-not-a-credential',streamSimple:f.provider.streamSimple,models:[...f.models]});
  model=modelRuntime.getModel('scope-bench','fixture');
 } else model=modelRuntime.getModel('cc-switch','claude-opus-5');
 assert.ok(model);
 const events=pi.createEventBus();let modules;
 events.on('benchmark:modules',m=>modules=m);
 const loaderPath=path.join(c.root,'loader.ts');
 fs.writeFileSync(loaderPath,`import {createSubagentExecutor} from ${JSON.stringify(path.join(c.source,'src/runs/foreground/subagent-executor.ts'))};\nimport {DIRS} from ${JSON.stringify(path.join(c.source,'src/shared/types.ts'))};\nexport default api=>api.events.emit('benchmark:modules',{createSubagentExecutor,DIRS});`,{mode:0o600});
 const loader=new pi.DefaultResourceLoader({cwd:c.cwd,agentDir:path.join(c.root,'parent-config'),settingsManager:pi.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}}),eventBus:events,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[loaderPath]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);assert.ok(modules);
 // Project settings disable Pi request retry without reading/copying any credentials.
 const settings=pi.SettingsManager.create(c.cwd);
 assert.equal(settings.getRetrySettings().enabled,false);
 const state={baseCwd:c.cwd,currentSessionId:c.id,asyncJobs:new Map(),foregroundControls:new Map(),lastForegroundControlId:null};
 const agent={name:'worker',description:'fixed read-only scope benchmark',model:c.model,thinking:'off',fallbackModels:[],systemPrompt:'Use read exactly once on payload.txt. Return only the requested JSON. Do not delegate or modify files.',systemPromptMode:'replace',inheritProjectContext:false,inheritSkills:false,extensions:[],subagentOnlyExtensions:[c.tap],tools:['read']};
 const executor=modules.createSubagentExecutor({pi:{events,getSessionName:()=>undefined},state,config:{maxActiveAsyncRunsPerSession:1,...(c.owned?{asyncExecutionScope:'owned-process-groups-v2'}:{})},asyncByDefault:true,tempArtifactsDir:c.root,getSubagentSessionRoot:()=>path.join(c.root,'sessions'),expandTilde:x=>x,discoverAgents:()=>({agents:[agent]}),allowMutatingManagementActions:false});
 const ctx={cwd:c.cwd,hasUI:false,ui:{},model,sessionManager:{getSessionId:()=>c.id,getSessionFile:()=>null},modelRegistry:{getAvailable:()=>[model]}};
 const started=stamp();
 // Hold topology constant: public single normalization differs between legacy and owned scopes.
 const receipt=await executor.execute('bench',{agent:'worker',task:'Read payload.txt exactly once. Return only JSON containing its token and the sum of values, with keys token and sum.',async:true,context:'fresh',mission:false,acceptance:false,output:false,timeoutMs:120000,turnBudget:{maxTurns:3,graceTurns:0},toolBudget:{hard:1,block:'*'},usageBudget:{tokens:{hard:20000}}},new AbortController().signal,undefined,ctx);
 const receiptAt=stamp();assert.notEqual(receipt.isError,true);const id=receipt.details.asyncId;assert.ok(id);
 fs.writeFileSync(path.join(c.root,'receipt.json'),JSON.stringify({id,started,receiptAt}),{mode:0o600});
 // Observe authoritative close directly. A bare executor host does not register
 // the extension's live wait tracker; it cannot benchmark the public wait tool.
 const dir=path.join(modules.DIRS.async,id);let proof;
 // A 10ms polling interval is not an error bound: scheduling and I/O can add delay.
 // Observation does not alter package closure rules.
 const deadline=Date.now()+140000;
 while(!(proof=readJSON(path.join(dir,'process-terminal.json')))){
  const current=readJSON(path.join(dir,'status.json'));if(current)assert.equal(current.mode,'single','Benchmark requires identical single-run topology');
  if(Date.now()>deadline)throw Error('closure-unavailable');await new Promise(r=>setTimeout(r,10));
 }
 const closeAt=stamp(),status=readJSON(path.join(dir,'status.json'));
 assert.equal(status.state,'complete');assert.equal(proof.state,'observed');
 if(c.owned){assert.equal(proof.ownedClosure?.state,'observed');assert.ok(proof.ownedClosure.writers.every(w=>w.kind!=='pi-writer'||w.sessionLease?.released===true));}
 const ev=fs.readFileSync(c.events,'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const sessionFile=status.steps[0].sessionFile;assert.ok(sessionFile);
 const entries=fs.readFileSync(sessionFile,'utf8').trim().split('\n').map(x=>JSON.parse(x));
 const messages=entries.filter(x=>x.type==='message').map(x=>x.message);
 const assistants=messages.filter(m=>m.role==='assistant');
 const finalText=assistants.at(-1).content.filter(x=>x.type==='text').map(x=>x.text).join('').trim();let answer;
 try{answer=JSON.parse(finalText);}catch{}
 const tools=messages.filter(m=>m.role==='toolResult');
 const valid=answer?.token==='ORCHID-47'&&answer?.sum===50&&tools.length===1&&tools[0].toolName==='read'&&!tools[0].isError;
 const first=kind=>ev.find(x=>x.kind===kind)?.at,last=kind=>ev.findLast(x=>x.kind===kind)?.at;
 const modelEvents=ev.filter(x=>x.kind==='assistant-end');
 const result={id:c.id,owned:c.owned,dry:c.dry,state:'closed',valid,model:c.model,thinking:'off',runId:id,metrics:{dispatchMs:receiptAt-started,startupToAgentMs:first('before-agent')-started,agentMs:last('agent-end')-first('before-agent'),toolMs:last('tool-end')-first('tool-start'),postAgentCloseMs:closeAt-last('agent-end'),endToEndMs:closeAt-started},assistantMessages:assistants.length,toolCount:tools.length,attempts:status.steps[0].modelAttempts??[],modelEvents,systemBytes:ev.find(x=>x.kind==='before-agent')?.systemBytes,closure:proof.state,ownedClosure:proof.ownedClosure?.state??null};
 fs.writeFileSync(c.result,JSON.stringify(result,null,2),{mode:0o600});
 clearTimeout(watchdog);process.exit(0);
} catch(e) {
 clearTimeout(watchdog);fs.writeFileSync(c.result,JSON.stringify({state:'unknown',errorName:e.name,errorCode:e.code??null,stackFrame:e.stack?.split('\n').find(line=>line.trim().startsWith('at '))?.trim()}),{mode:0o600});process.exit(1);
}
