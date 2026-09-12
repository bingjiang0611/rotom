// Actual product provider + native AgentSession in a private synthetic project.
// Fixed tools only; this is not arbitrary shell execution or a security sandbox.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,lstatSync,chmodSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readProbeCredential} from './probe-credential.mjs';
import {observeStream} from './stream-shape.mjs';
import {decodeProbeBody} from './probe-wire.mjs';
const [mode='--offline',id='ultimate',turnsText='20',levelText='medium']=process.argv.slice(2),live=mode==='--live',turns=Number(turnsText),selectedLevels=levelText.split(',');
assert(selectedLevels.length&&new Set(selectedLevels).size===selectedLevels.length&&selectedLevels.every(l=>['off','low','medium','high','xhigh','max'].includes(l)));let currentLevel=selectedLevels[0];
assert(process.argv.length<=6&&['--offline','--live'].includes(mode)&&Number.isInteger(turns)&&turns>=2&&turns<=24);assert(live||id==='ultimate');
const compactEvery=Number(process.env.ROTOM_QODER_LONG_COMPACT_EVERY??6);assert(Number.isInteger(compactEvery)&&compactEvery>=2&&compactEvery<=6);
const root=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT??resolve(import.meta.dirname,'../../rotom');assert(isAbsolute(root)&&realpathSync(root)===root);
const load=name=>import(pathToFileURL(join(root,'extensions/qoder',name)).href);
const {installQoderExtension}=await load('session-policy.mjs'),{PROVIDER_ID}=await load('provider.mjs'),{CATALOG_URL}=await load('catalog-auth.mjs'),{CHAT_URL,SUPPORTED_MODEL_IDS}=await load('transport.mjs'),{LEGACY_URL}=await load('legacy.mjs');
assert(SUPPORTED_MODEL_IDS.includes(id));
const entry=process.env.ROTOM_PI;assert(isAbsolute(entry)&&realpathSync(entry)===entry&&lstatSync(entry).isFile());assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const piAI=await import(import.meta.resolve('@earendil-works/pi-ai',pathToFileURL(entry).href)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',pathToFileURL(entry).href)),sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,count=()=>live?Number(readFileSync(ledger,'utf8')):0,before=count();
if(live)assert(ledger&&process.execArgv.some(x=>x.endsWith('live-budget.mjs')));
const dir=realpathSync(mkdtempSync(join(live?dirname(ledger):tmpdir(),'qoder-long-session-')));chmodSync(dir,0o700);
const digestFile=p=>{assert(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());return createHash('sha256').update(readFileSync(p)).digest('hex');};
const identity={productRoot:root,piEntry:entry,piEntrySha256:digestFile(entry),sdkModule:import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href),qoderDigests:Object.fromEntries(['auth.mjs','catalog-auth.mjs','catalog.mjs','credits.mjs','index.ts','legacy.mjs','oauth.mjs','provider.mjs','refresh-guard.mjs','session-policy.mjs','transport.mjs'].map(f=>[f,digestFile(join(root,'extensions/qoder',f))]))};
const summary={pass:false,mode,model:id,identity,levels:selectedLevels,compactEvery,turnsRequested:turns,turnsCompleted:0,modelRequests:0,catalogRequests:0,reads:0,inspections:0,writes:0,plainAcknowledgements:0,compactions:0,diskResumes:0,peakInputTokens:0,diagnostics:{},wire:[],errors:[],toolEvents:0,directory:dir};
const save=()=>writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});save();console.error('Evidence: '+dir);
const seed=randomUUID(),anchor='ANCHOR_'+randomUUID(),markers=Array.from({length:turns},(_,i)=>'CHECKPOINT_'+(i+1)+'_'+randomUUID());
for(let n=1;n<=turns;n++)writeFileSync(join(dir,`packet-${n}.txt`),`Remember session anchor ${anchor}. Current marker ${markers[n-1]}.\n`+Array.from({length:230},(_,i)=>`entry_${i} ${createHash('sha256').update(`${seed}:${n}:${i}`).digest('hex').slice(0,16)}`).join('\n'),{mode:0o600});
const reads=new Set(),inspections=new Set(),writes=new Set();let active=1,provider,session,phase='work';
const tools=[
 {name:'fixture_inspect',label:'Inspect synthetic sequence',description:'Read independent sequence metadata. May be requested with fixture_read; both must finish before recording.',parameters:piAI.Type.Object({sequence:piAI.Type.Integer({minimum:1,maximum:turns})},{additionalProperties:false}),async execute(_id,args){assert.equal(args.sequence,active);assert(!inspections.has(active));inspections.add(active);summary.inspections++;return{content:[{type:'text',text:`Sequence ${active} is open. Exactly one read and one record are permitted.`}],details:{}};}},
 {name:'fixture_read',label:'Read synthetic packet',description:'Read the packet for the current sequence. This reveals its unique checkpoint marker. No access outside the fixture.',parameters:piAI.Type.Object({sequence:piAI.Type.Integer({minimum:1,maximum:turns})},{additionalProperties:false}),async execute(_id,args){assert.equal(args.sequence,active);assert(!reads.has(active));reads.add(active);summary.reads++;return{content:[{type:'text',text:readFileSync(join(dir,`packet-${active}.txt`),'utf8')}],details:{}};}},
 {name:'fixture_record',label:'Record checked marker',description:'After fixture_read returns, record its exact checkpoint marker once. Do not guess the marker or batch this dependent action with the read.',parameters:piAI.Type.Object({sequence:piAI.Type.Integer({minimum:1,maximum:turns}),marker:piAI.Type.String()},{additionalProperties:false}),async execute(_id,args){assert.equal(args.sequence,active);assert(reads.has(active)&&inspections.has(active)&&!writes.has(active));assert.equal(args.marker,markers[active-1]);appendFileSync(join(dir,'checkpoints.jsonl'),JSON.stringify({sequence:active,marker:args.marker})+'\n',{mode:0o600});writes.add(active);summary.writes++;return{content:[{type:'text',text:`Checkpoint ${active} verified and recorded once.`}],details:{}};}},
];
const credentials=new piAI.InMemoryCredentialStore();let authHash;
if(live){authHash=createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');await credentials.modify(PROVIDER_ID,async()=>(await readProbeCredential()).oauthCredential);}
// Keep the native reserve default: 1024 would cap summaries at only 819 tokens
// (Pi allocates 80% of reserve), which is not representative of normal rotom.
const settings=sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:64}});
summary.compactionReserveTokens=settings.getCompactionSettings().reserveTokens;assert(summary.compactionReserveTokens>=5120);
const runtime=await sdk.ModelRuntime.create({credentials,modelsPath:null,modelsStorePath:null,refreshOnCreate:false,allowModelNetwork:false});
const event=x=>'data: '+JSON.stringify(x)+'\n\n';
const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Synthetic long coding-session acceptance. Use only fixture tools. Dependent read then record steps must be separate. Retain exact checkpoint markers and session anchor across compaction. No outside operations.',extensionFactories:[async pi=>{
 provider=await installQoderExtension(pi,{piAI,openAI,onDiagnostic:d=>{if(['field_prefix_continuation','frame_continuation','usage_continuation','invalid_sse_json','legacy_error'].includes(d.code))summary.diagnostics[d.code]=(summary.diagnostics[d.code]??0)+1;},authMode:live?'browser':'qodercli',getCredential:async()=>{assert(!live);return{accessToken:'fixture',uid:'fixture',org:'',machineId:'fixture-machine',fingerprint:'a'.repeat(64)};},oauthOptions:{fetchImpl:()=>assert.fail('refresh or login is not authorized in this test')},fetchImpl:async(url,init)=>{
  if(url===CATALOG_URL){summary.catalogRequests++;return live?fetch(url,init):Response.json({assistant:[{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',max_input_tokens:200000,is_reasoning:true,is_vl:true,context_config:{'400K':{token_count:400000}},thinking_config:{disabled:{},enabled:{efforts:Object.fromEntries(['low','medium','high','xhigh','max'].map(l=>[l,{is_default:l==='high'}]))}}}]});}
  assert([CHAT_URL,LEGACY_URL].includes(url));assert(++summary.modelRequests<=100);
  const body=url===LEGACY_URL?decodeProbeBody(init.body):JSON.parse(init.body);
  if(phase==='compact')assert(JSON.stringify(body.messages).includes(anchor));
  const effort=url===LEGACY_URL?body.parameters.reasoning_effort:body.reasoning_effort;assert.equal(effort,currentLevel==='off'?'none':currentLevel);
  if(live){const started=Date.now(),response=await fetch(url,init),shape=await observeStream(response);summary.wire.push({request:summary.modelRequests,phase,selectedLevel:currentLevel,effort,requestedMaxTokens:url===LEGACY_URL?body.parameters.max_tokens:body.max_tokens,bufferedResponseMs:Date.now()-started,...shape});save();return response;}
  let delta;
  if(phase==='compact')delta={content:`Preserve ${anchor}. Last recorded sequence ${active}. Continue with fresh packets, do not repeat writes.`};
  else if(phase==='recall')delta={content:anchor};
  else if(!reads.has(active))delta={tool_calls:[{index:0,id:`call_read_${active}`,type:'function',function:{name:'fixture_read',arguments:JSON.stringify({sequence:active})}},{index:url===LEGACY_URL?1:0,id:`call_inspect_${active}`,type:'function',function:{name:'fixture_inspect',arguments:JSON.stringify({sequence:active})}}]};
  else if(!inspections.has(active))delta={tool_calls:[{index:0,id:`call_inspect_${active}`,type:'function',function:{name:'fixture_inspect',arguments:JSON.stringify({sequence:active})}}]};
  else if(!writes.has(active))delta={tool_calls:[{index:0,id:`call_record_${active}`,type:'function',function:{name:'fixture_record',arguments:JSON.stringify({sequence:active,marker:markers[active-1]})}}]};
  else delta={content:markers[active-1]};
  const emit=x=>event(url===LEGACY_URL?{statusCodeValue:200,body:JSON.stringify(x)}:x);
  if(id==='ultimate')delta.reasoning_item={id:`fixture-reasoning-${summary.modelRequests}`,encrypted_content:'fixture-opaque',...url===LEGACY_URL?{target_hash:'t'.repeat(64)}:{}};
  return new Response(emit({choices:[{delta,finish_reason:null}]})+emit({choices:[{delta:{},finish_reason:delta.tool_calls?(url===LEGACY_URL&&id==='ultimate'?'function_call':'tool_calls'):'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
}]});
async function open(manager){
 await loader.reload();assert.equal(loader.getExtensions().errors.length,0);const model=provider.getModels().find(m=>m.id===id);assert(model);
 const result=await sdk.createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,thinkingLevel:manager.getEntries().length?undefined:currentLevel,tools:tools.map(t=>t.name),customTools:tools,settingsManager:settings,resourceLoader:loader,sessionManager:manager});
 await result.session.bindExtensions({mode:'rpc',uiContext:{setStatus(){},notify(){}}});
 assert.equal(result.session.model.id,id);assert.equal(result.session.thinkingLevel,currentLevel);
 result.session.subscribe(e=>{
  if(e.type==='tool_execution_end'){summary.toolEvents++;if(e.isError)summary.errors.push({type:'tool_error'});}
  if(e.type==='message_end'&&e.message.role==='assistant'){
   const m=e.message;summary.peakInputTokens=Math.max(summary.peakInputTokens,(m.usage?.input??0)+(m.usage?.cacheRead??0));
   if(['error','aborted','length'].includes(m.stopReason))summary.errors.push({type:m.stopReason,code:m.errorMessage?.match(/Qoder: ([a-z0-9_]+)/)?.[1]??'native_failure'});
  }
 });return result.session;
}
function answer(){assert.equal(summary.errors.length,0);const m=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(m.stopReason,'stop');return m.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();}
try{
 session=await open(sdk.SessionManager.create(dir,dir));
 for(active=1;active<=turns;active++){
  currentLevel=selectedLevels[(active-1)%selectedLevels.length];session.setThinkingLevel(currentLevel,{persist:false});assert.equal(session.thinkingLevel,currentLevel);
  await session.prompt(`Sequence ${active}: briefly plan your next step. First request fixture_read and fixture_inspect independently for this sequence (they may share a batch). Only after both return, record the exact marker using fixture_record. Finish with the current CHECKPOINT_ marker.`);
  const text=answer();if(text===markers[active-1])summary.plainAcknowledgements++;
  // Exact tool arguments plus file readback are the write oracle. Narrative
  // acknowledgements may also mention earlier, already-recorded checkpoints.
  assert(text.includes(markers[active-1]));assert((text.match(/CHECKPOINT_\d+_[a-f0-9-]{36}/g)??[]).every(m=>markers.slice(0,active).includes(m)));assert(writes.has(active));summary.turnsCompleted++;save();
  if(active%compactEvery===0){phase='compact';const c=await session.compact('Preserve the exact ANCHOR_ value and the last verified sequence. All previous writes are complete; do not repeat any.');assert(c.summary.includes(anchor));summary.compactions++;phase='recall';await session.prompt('Reply ONLY with the exact ANCHOR_ value retained from earlier history. No tools.');assert.deepEqual([...new Set(answer().match(/ANCHOR_[a-f0-9-]{36}/g)??[])],[anchor]);phase='work';save();}
  if(active===Math.floor(turns/2)){const file=session.sessionFile;session.dispose();session=await open(sdk.SessionManager.open(file,dir));summary.diskResumes++;save();}
 }
 assert.equal(summary.reads,turns);assert.equal(summary.writes,turns);assert.equal(summary.inspections,turns);assert.equal(summary.toolEvents,turns*3);
 const lines=readFileSync(join(dir,'checkpoints.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(lines,markers.map((marker,i)=>({sequence:i+1,marker})));
 if(live&&turns>=20)assert(summary.peakInputTokens>=16000);summary.pass=true;
}catch(e){summary.errorCode=e.message?.match(/Qoder: ([a-z0-9_]+)/)?.[1]??(e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z0-9_]+$/.test(e.code??'')?e.code:'workflow_failed');summary.errorLine=e.stack?.match(/long-session-smoke\.mjs:(\d+):/)?.[1];process.exitCode=1;}
finally{session?.dispose();}
summary.requests=count()-before;summary.ledgerTotal=count();summary.credentialsUnchanged=!live||authHash===createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');
if(live)assert.equal(summary.requests,summary.modelRequests+summary.catalogRequests);
assert(summary.credentialsUnchanged);save();const {wire,...publicSummary}=summary;console.log(JSON.stringify(publicSummary,null,2));
