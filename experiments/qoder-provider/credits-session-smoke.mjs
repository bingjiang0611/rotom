// Native AgentSession, real synthetic file edit/tests, isolated auth and SDK UI callbacks.
// Not a terminal-rendering test or a general filesystem/command sandbox.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,lstatSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const productRoot=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT??resolve(import.meta.dirname,'../../rotom');
assert(isAbsolute(productRoot)&&realpathSync(productRoot)===productRoot&&lstatSync(productRoot).isDirectory());
function runtime(name){const file=join(productRoot,'extensions/qoder',name);assert(lstatSync(file).isFile()&&realpathSync(file)===file);return import(pathToFileURL(file).href);}
const {MODEL,PROVIDER_ID}=await runtime('provider.mjs');
const {installQoderExtension}=await runtime('session-policy.mjs');
const {CREDIT_ENTRY,QUOTA_URL,creditSummary}=await runtime('credits.mjs');
const {CATALOG_URL}=await runtime('catalog-auth.mjs');
const {CHAT_URL}=await runtime('transport.mjs');
const {LEGACY_URL}=await runtime('legacy.mjs');
const {createRefreshGuard}=await runtime('refresh-guard.mjs');
import {decodeProbeBody} from './probe-wire.mjs';
const [mode='--offline',id='lite']=process.argv.slice(2),live=mode==='--live';assert(process.argv.length<=4&&['--offline','--live'].includes(mode)&&['lite','smodel'].includes(id));assert(live||id==='lite');
const entry=process.env.ROTOM_PI;assert(isAbsolute(entry)&&lstatSync(entry).isFile()&&realpathSync(entry)===entry);assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const piAI=await import(import.meta.resolve('@earendil-works/pi-ai',pathToFileURL(entry).href)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',pathToFileURL(entry).href)),sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,count=()=>live?Number(readFileSync(ledger,'utf8')):0,before=count();
if(live)assert(process.execArgv.some(a=>a.endsWith('live-budget.mjs'))&&process.env.ROTOM_QODER_PROBE_CREDIT==='1'&&process.env.ROTOM_QODER_PROBE_OAUTH==='1');
const authFile=process.env.ROTOM_QODER_PROBE_AUTH_FILE,globalAuth=join(homedir(),'.pi/agent/auth.json'),digest=p=>p&&existsSync(p)?createHash('sha256').update(readFileSync(p)).digest('hex'):null;
if(live)assert(isAbsolute(authFile)&&realpathSync(authFile)===authFile&&!(lstatSync(authFile).mode&0o077)&&dirname(authFile)===process.env.ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR&&authFile!==globalAuth);
const authBefore=digest(authFile),globalBefore=digest(globalAuth);
const dir=realpathSync(mkdtempSync(join(live?dirname(ledger):tmpdir(),'qoder-credit-session-')));chmodSync(dir,0o700);
const bad='export function add(a,b) { return a-b; }\n',good='export function add(a,b) { return a+b; }\n',testCode="import assert from 'node:assert/strict'; import {add} from './calculator.mjs'; assert.equal(add(2,3),5); assert.equal(add(-2,2),0);\n";
writeFileSync(join(dir,'calculator.mjs'),bad,{mode:0o600});writeFileSync(join(dir,'calculator.test.mjs'),testCode,{mode:0o600});
const marker='FIXED_'+randomUUID(),resumeMarker='RESUMED_'+randomUUID(),branchMarker='ABANDONED_'+randomUUID(),summary={pass:false,mode,model:id,uiScope:'SDK callbacks; terminal rendering not tested',modelRequests:0,catalogRequests:0,quotaRequests:0,authRequests:0,reads:0,tests:0,failedTests:0,patches:0};
let provider,session,phase='repair';const status=new Map();
const ui={setStatus:(key,value)=>status.set(key,value),notify(text){if(text.startsWith('Qoder Credit snapshot ('))summary.quotaDisplayed=true;}};
const tools=[
 {name:'fixture_read',label:'Read synthetic source',description:'Read only calculator.mjs or calculator.test.mjs in the synthetic fixture.',parameters:piAI.Type.Object({path:piAI.Type.Union([piAI.Type.Literal('calculator.mjs'),piAI.Type.Literal('calculator.test.mjs')])},{additionalProperties:false}),async execute(_id,args){assert(['calculator.mjs','calculator.test.mjs'].includes(args.path));assert(++summary.reads<=4);return{content:[{type:'text',text:readFileSync(join(dir,args.path),'utf8')}],details:{}};}},
 {name:'fixture_test',label:'Run fixed synthetic tests',description:'Run a fixed local Node assertion test; no arbitrary commands or arguments.',parameters:piAI.Type.Object({},{additionalProperties:false}),async execute(_id,args){assert.equal(Object.keys(args).length,0);assert(++summary.tests<=3);assert.equal(readFileSync(join(dir,'calculator.test.mjs'),'utf8'),testCode);assert([bad,good].includes(readFileSync(join(dir,'calculator.mjs'),'utf8')));const p=spawnSync(process.execPath,[join(dir,'calculator.test.mjs')],{cwd:dir,env:{HOME:dir,LANG:'C',TZ:'UTC'},timeout:5000,encoding:'utf8',maxBuffer:65536});assert(!p.error&&[0,1].includes(p.status));if(p.status===1)summary.failedTests++;return{content:[{type:'text',text:p.status===0?'Tests PASS.':'Tests FAIL: add(2,3) must equal 5 and add(-2,2) must equal 0.'}],details:{passed:p.status===0}};}},
 {name:'fixture_patch',label:'Apply one approved fix',description:'After reading source and observing a failing test, apply the single approved subtraction-to-addition fix. Cannot write arbitrary code; execute at most once.',parameters:piAI.Type.Object({operation:piAI.Type.Literal('replace_subtraction_with_addition')},{additionalProperties:false}),async execute(_id,args){assert.deepEqual(args,{operation:'replace_subtraction_with_addition'});assert(summary.reads>0&&summary.failedTests===1&&summary.patches===0);assert.equal(readFileSync(join(dir,'calculator.mjs'),'utf8'),bad);summary.patches++;writeFileSync(join(dir,'calculator.mjs'),good);assert.equal(readFileSync(join(dir,'calculator.mjs'),'utf8'),good);return{content:[{type:'text',text:'Approved patch applied once and read back successfully.'}],details:{}};}},
];
const settingsManager=sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false,reserveTokens:1024,keepRecentTokens:64}}),credentials=new piAI.InMemoryCredentialStore();
if(!live){const machineId=randomUUID(),uid='fixture-user',org='';await credentials.modify(PROVIDER_ID,async()=>({type:'oauth',qoderAuthVersion:1,access:'fixture',refresh:'fixture-refresh',expires:Date.now()+3600000,refreshExpires:Date.now()+86400000,machineId,uid,org,fingerprint:createHmac('sha256',machineId).update(JSON.stringify(['rotom-qoder-browser-v1',uid,org])).digest('hex')}));}
const modelRuntime=await sdk.ModelRuntime.create({...live?{authPath:authFile}:{credentials},modelsPath:null,modelsStorePath:null,refreshOnCreate:false,allowModelNetwork:false});
const event=d=>`data: ${JSON.stringify(d)}\n\n`;
const loader=new sdk.DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Synthetic coding test. Only provided fixture tools are available. Execute dependent steps sequentially, not in one batch. Never request external operations.',extensionFactories:[async pi=>{
 provider=await installQoderExtension(pi,{piAI,openAI,authMode:'browser',getCredential:()=>assert.fail('CLI credentials forbidden'),oauthOptions:live?{claimRefresh:createRefreshGuard(dirname(authFile)),fetchImpl:(url,init)=>{summary.authRequests++;return fetch(url,init);}}:{fetchImpl:()=>assert.fail('offline auth network forbidden')},fetchImpl:async(url,init)=>{
  if(url===CATALOG_URL){summary.catalogRequests++;return live?fetch(url,init):Response.json({assistant:[{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',max_input_tokens:200000,is_vl:false,is_reasoning:false}]});}
  if(url===QUOTA_URL){summary.quotaRequests++;return live?fetch(url,init):Response.json({user_id:'fixture-user',user_quota:{total:100,used:3,remaining:97,unit:'Credits'}});}
  assert([CHAT_URL,LEGACY_URL].includes(url));assert(summary.modelRequests<14);summary.modelRequests++;
  const payload=url===LEGACY_URL?decodeProbeBody(init.body):JSON.parse(init.body);
  assert(!JSON.stringify(payload).includes('Qoder Credit snapshot'));assert(!JSON.stringify(payload).includes(CREDIT_ENTRY));
  if(phase==='compact'){summary.compactionSourceHadTarget=JSON.stringify(payload.messages).includes(marker);assert(summary.compactionSourceHadTarget);}
  if(live)return fetch(url,init);
  let delta;
  if(phase==='resume')delta={content:resumeMarker};
  else if(phase==='branch')delta={content:branchMarker};
  else if(phase==='compact')delta={content:`The repair passed; preserve ${marker}. No more tool calls are needed.`};
  else if(phase==='recall')delta={content:marker};
  else if(!summary.reads)delta={tool_calls:[{index:0,id:'read-call',type:'function',function:{name:'fixture_read',arguments:JSON.stringify({path:'calculator.mjs'})}}]};
  else if(!summary.tests)delta={tool_calls:[{index:0,id:'test-before',type:'function',function:{name:'fixture_test',arguments:'{}'}}]};
  else if(!summary.patches)delta={tool_calls:[{index:0,id:'patch-call',type:'function',function:{name:'fixture_patch',arguments:JSON.stringify({operation:'replace_subtraction_with_addition'})}}]};
  else if(summary.tests===1)delta={tool_calls:[{index:0,id:'test-after',type:'function',function:{name:'fixture_test',arguments:'{}'}}]};
  else delta={content:marker};
  return new Response(event({choices:[{delta,finish_reason:null}]})+event({choices:[{delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,credits:.25,original_credits:.5,billable:true}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
}]});
async function open(manager){await loader.reload();assert.equal(loader.getExtensions().errors.length,0);assert.equal(loader.getAgentsFiles().agentsFiles.length,0);const model=provider.getModels().find(m=>m.id===id)??MODEL;const result=await sdk.createAgentSession({cwd:dir,agentDir:dir,modelRuntime,model,thinkingLevel:model.reasoning?'medium':'off',tools:tools.map(t=>t.name),customTools:tools,settingsManager,resourceLoader:loader,sessionManager:manager});assert.deepEqual(result.session.getActiveToolNames().sort(),tools.map(t=>t.name).sort());await result.session.bindExtensions({mode:'tui',uiContext:ui});return result.session;}
function answer(){const m=session.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(m.stopReason,'stop');return m.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();}
try{
 session=await open(sdk.SessionManager.create(dir,dir));const beforeMessages=session.messages.length,beforeModel=summary.modelRequests;
 await session.prompt('/qoder-credits');assert(summary.quotaDisplayed);assert.equal(summary.quotaRequests,1);assert.equal(summary.modelRequests,beforeModel);assert.equal(session.messages.length,beforeMessages);
 await session.prompt(`Read calculator.mjs, then run fixture_test to prove failure, then apply the one approved fix, then run fixture_test again to verify PASS. Use separate dependent calls. Reply only ${marker} after the tests pass.`);
 assert.equal(answer(),marker);assert.equal(summary.patches,1);assert.equal(summary.failedTests,1);assert.equal(summary.tests,2);assert.equal(readFileSync(join(dir,'calculator.mjs'),'utf8'),good);summary.nativeFileRepair=true;
 const manager=session.sessionManager,file=session.sessionFile,sessionId=manager.getSessionId();assert(file&&existsSync(file));
 const base=manager.getLeafId();phase='branch';await session.prompt(`Temporary branch only: reply exactly ${branchMarker}, no tools.`);assert.equal(answer(),branchMarker);
 const navigation=await session.navigateTree(base,{summarize:false});assert.equal(navigation.cancelled,false);assert(!JSON.stringify(session.messages).includes(branchMarker));summary.branchIsolated=true;
 const observed=creditSummary(manager.getEntries(),sessionId);assert.equal(observed.reported+observed.unknown,summary.modelRequests);assert(status.get('qoder-credit-usage'));
 assert(!JSON.stringify(session.messages).includes(CREDIT_ENTRY));assert(!JSON.stringify(manager.getEntries()).includes('Qoder Credit snapshot'));
 session.dispose();session=await open(sdk.SessionManager.open(file,dir));assert.deepEqual(creditSummary(session.sessionManager.getEntries(),sessionId),observed);summary.creditDiskResume=true;
 phase='resume';await session.prompt(`The repair is already verified. Do not run any tool; reply only ${resumeMarker}.`);assert.equal(answer(),resumeMarker);assert.equal(summary.patches,1);assert.equal(summary.tests,2);
 phase='compact';const compacted=await session.compact('Preserve the exact FIXED_ marker from the completed repair and its verified status. No further tools are needed.');assert(compacted.summary.includes(marker));summary.manualCompaction=true;
 phase='recall';await session.prompt('Reply only with the exact FIXED_ marker preserved by compaction, no tools.');assert.equal(answer(),marker);assert.equal(summary.patches,1);assert.equal(summary.tests,2);
 summary.metering=creditSummary(session.sessionManager.getEntries(),sessionId);assert.equal(summary.metering.reported+summary.metering.unknown,summary.modelRequests);summary.noQuotaInHistory=!JSON.stringify(session.sessionManager.getEntries()).includes('Qoder Credit snapshot');assert(summary.noQuotaInHistory);
 summary.pass=true;
}catch(e){summary.errorCode=e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z_]+$/.test(e.code??'')?e.code:'sdk_workflow_failed';summary.errorLocation=e.stack?.match(/credits-session-smoke\.mjs:(\d+):\d+/)?.[1]??'unknown';process.exitCode=1;}
finally{session?.dispose();}
summary.requests=count()-before;summary.ledgerTotal=count();summary.globalAuthUnchanged=globalBefore===digest(globalAuth);summary.isolatedAuthUnchanged=authBefore===digest(authFile);
if(!summary.globalAuthUnchanged||live&&(summary.requests!==summary.modelRequests+summary.catalogRequests+summary.quotaRequests+summary.authRequests||!summary.isolatedAuthUnchanged&&summary.authRequests===0)){summary.pass=false;process.exitCode=1;}
summary.runtimeDigests=Object.fromEntries(['credits.mjs','transport.mjs','provider.mjs','session-policy.mjs'].map(name=>[name,digest(join(productRoot,'extensions/qoder',name))]));
writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary,null,2));
