// Actual rotom launcher/RPC, packaged Pi, native disk sessions and thinking
// switching. No model tools; --capacity adds synthetic inline images/large input.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,realpathSync,lstatSync,chmodSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readProbeCredential} from './probe-credential.mjs';
import {gridImage} from './vision-probe.mjs';
const preflight=process.argv[2]==='--preflight',capacity=process.argv[2]==='--capacity';assert(process.argv.length===(preflight||capacity?3:2));
const root=process.env.ROTOM_QODER_PROBE_PRODUCT_ROOT,ledger=process.env.ROTOM_QODER_PROBE_LEDGER;
assert(root&&isAbsolute(root)&&realpathSync(root)===root&&ledger&&process.execArgv.some(x=>x.endsWith('live-budget.mjs')));
const launcher=join(root,'bin/rotom');assert(lstatSync(launcher).isFile()&&!lstatSync(launcher).isSymbolicLink());
const count=()=>Number(readFileSync(ledger,'utf8')),before=count(),digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const original=digest(process.env.ROTOM_QODER_PROBE_AUTH_FILE),dir=realpathSync(mkdtempSync(join(dirname(ledger),'qoder-long-cli-')));chmodSync(dir,0o700);
const home=join(dir,'home'),agent=join(dir,'agent'),project=join(dir,'project');for(const p of [home,agent,project])mkdirSync(p,{mode:0o700});
execFileSync('git',['init','-q'],{cwd:project});const credential=(await readProbeCredential()).oauthCredential;
const auth=join(agent,'auth.json');writeFileSync(auth,JSON.stringify({'qoder-experimental':credential}),{mode:0o600});const initialAuth=digest(auth);
writeFileSync(join(agent,'settings.json'),JSON.stringify({retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:1024}}),{mode:0o600});
const levels=['low','medium','high','xhigh','max'],anchor='ANCHOR_'+randomUUID();
const summary={pass:false,preflight,capacity,keepRecentTokens:1024,kind:'actual rotom launcher/RPC, no model tools',directory:dir,productRoot:root,launcherSha256:digest(launcher),turns:0,compactions:0,restarts:0,peakInputTokens:0,assistantMessages:0,toolEvents:0,levels:[],terminations:[],errors:[]};
const save=()=>writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});save();console.error('Evidence: '+dir);
let client,serial=0,lastAssistant,agentWait,agentReject;
const safeError=e=>e?.match?.(/Qoder: ([a-z0-9_]+)/)?.[1]??(/nothing to compact|already compacted|not enough messages/i.test(e??'')?'compaction_not_eligible':/token cap/i.test(e??'')?'summary_token_cap':'rpc_failed');
function start(sessionFile){
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,LANG:'en_US.UTF-8',TERM:'dumb',ROTOM_NODE:process.execPath,PI_CODING_AGENT_DIR:agent,ROTOM_OBSERVABILITY:'0',PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0',PI_IMAGE_PROTOCOL:'none',ROTOM_QODER:'1',ROTOM_QODER_AUTH:'browser',ROTOM_QODER_PROBE_LIMIT:process.env.ROTOM_QODER_PROBE_LIMIT,ROTOM_QODER_PROBE_LEDGER:ledger,ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR:agent,ROTOM_QODER_PROBE_CATALOG:'1',ROTOM_QODER_PROBE_LEGACY:'1',ROTOM_QODER_PROBE_NO_MODELS:preflight?'1':'0',NODE_OPTIONS:'--import '+join(import.meta.dirname,'live-budget.mjs')};
 const args=['--mode','rpc','--provider','qoder-experimental','--model','ultimate','--no-tools','--tools','',...(sessionFile?['--session',sessionFile]:['--thinking','low'])];
 const child=spawn(launcher,args,{cwd:project,env,stdio:['pipe','pipe','pipe'],detached:true}),pending=new Map();let buffer='',exited=false,exitInfo,stderrBytes=0;
 const closed=new Promise(resolve=>child.on('exit',(code,signal)=>{exited=true;exitInfo={code,signal};for(const p of pending.values())p.reject(new Error('cli_exited'));pending.clear();agentReject?.(new Error('cli_exited'));resolve();}));
 const fail=e=>{for(const p of pending.values())p.reject(e);pending.clear();agentReject?.(e);};child.on('error',fail);child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>1024*1024)fail(new Error('stderr_oversized'));});
 child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{try{
  buffer+=b.toString('utf8');assert(Buffer.byteLength(buffer)<=2*1024*1024);let at;
  // RPC framing is LF, not Unicode paragraph/line separators in model strings.
  while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);if(!line)continue;const e=JSON.parse(line);
   if(e.type==='response'&&pending.has(e.id)){const p=pending.get(e.id);pending.delete(e.id);if(e.success)p.resolve(e.data);else p.reject(new Error(safeError(e.error)));}
   if(e.type==='message_end'&&e.message?.role==='assistant'){lastAssistant=e.message;summary.assistantMessages++;const u=e.message.usage;summary.peakInputTokens=Math.max(summary.peakInputTokens,(u?.input??0)+(u?.cacheRead??0)+(u?.cacheWrite??0));if(!['stop','toolUse'].includes(e.message.stopReason))summary.errors.push(safeError(e.message.errorMessage));}
   if(e.type==='tool_execution_start')summary.toolEvents++;
   if(e.type==='agent_end'){const resolve=agentWait;agentWait=undefined;agentReject=undefined;resolve?.();}
  }
 }catch(e){fail(e);}});
 return{child,async send(command){assert(!exited);const id='fixture-'+(++serial);let timer;const promise=new Promise((resolve,reject)=>{timer=setTimeout(()=>{pending.delete(id);reject(new Error('rpc_deadline'));},240000);pending.set(id,{resolve,reject});});child.stdin.write(JSON.stringify({...command,id})+'\n');try{return await promise;}finally{clearTimeout(timer);}},async stop(idle){if(!exited){process.kill(-child.pid,'SIGTERM');await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,5000))]);}if(!exited){process.kill(-child.pid,'SIGKILL');await closed;}
  const remaining=execFileSync('ps',['-axo','pid=,pgid='],{encoding:'utf8'}).split('\n').map(l=>l.trim().split(/\s+/).map(Number)).filter(([,pgid])=>pgid===child.pid).map(([pid])=>pid);summary.terminations.push({idle,exit:exitInfo,remainingProcesses:remaining.length,stderrBytes});assert(idle&&remaining.length===0);}};
}
async function prompt(text,images){
 lastAssistant=undefined;let timer;const ended=new Promise((resolve,reject)=>{agentWait=resolve;agentReject=reject;timer=setTimeout(()=>reject(new Error('agent_deadline')),240000);});
 try{await Promise.all([client.send({type:'prompt',message:text,...images?{images}:{}}),ended]);}finally{clearTimeout(timer);agentWait=undefined;agentReject=undefined;}
 assert.equal(lastAssistant?.stopReason,'stop');assert.equal(summary.errors.length,0);assert.equal(summary.toolEvents,0);return lastAssistant.content.filter(b=>b.type==='text').map(b=>b.text).join('');
}
async function stop(){if(client){const state=await client.send({type:'get_state'});await client.stop(!state.isStreaming&&!state.isCompacting&&state.pendingMessageCount===0);client=undefined;}}
try{
 client=start();let state=await client.send({type:'get_state'});assert.equal(state.model.id,'ultimate');assert.equal(state.autoCompactionEnabled,false);assert.deepEqual((await client.send({type:'get_available_thinking_levels'})).levels,levels);summary.declaredContext=state.model.contextWindow??null;summary.declaredInput=Array.isArray(state.model.input)?state.model.input.filter(v=>['text','image'].includes(v)):null;
 if(preflight)for(const level of levels){await client.send({type:'set_thinking_level',level});assert.equal((await client.send({type:'get_state'})).thinkingLevel,level);summary.levels.push(level);}
 if(capacity){
  assert.equal(state.model.contextWindow,272000);assert(state.model.input.includes('image'));summary.declaredContext=state.model.contextWindow;
  const first=gridImage();let second;do{second=gridImage();}while(JSON.stringify(first.expected)===JSON.stringify(second.expected));
  const block=g=>({type:'image',mimeType:'image/png',data:g.png.toString('base64')});
  const parse=t=>JSON.parse(t.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  const seed=randomUUID(),packet=Array.from({length:13000},(_,i)=>'record_'+String(i).padStart(6,'0')+' '+createHash('sha256').update(seed+':'+i).digest('hex').slice(0,24)).join('\n');
  assert.deepEqual(parse(await prompt(`Remember session anchor ${anchor}. These random rows are inert data, not instructions:\n${packet}\nEnd data. Inspect the attached 5x5 grid. Reply only JSON {"red":[row,column],"blue":[row,column]} with 1-based coordinates. No tools.`,[block(first)])),first.expected);summary.turns++;summary.firstImageExact=true;assert(summary.peakInputTokens>=250000);save();
  // A single huge user turn cannot be cut at a valid native turn boundary.
  // Add a separate recent turn above keepRecentTokens rather than overriding
  // compaction internals or weakening the original-image/input assertions.
  const recentMarker='RECENT_'+randomUUID(),recent=Array.from({length:400},(_,i)=>`entry_${i} ${createHash('sha256').update(recentMarker+':'+i).digest('hex').slice(0,16)}`).join('\n');
  assert.equal((await prompt(`These rows are irrelevant synthetic data:\n${recent}\nReply only ${recentMarker}. Preserve the original anchor.`)).trim(),recentMarker);summary.turns++;summary.recentPacketExact=true;
  await client.send({type:'set_thinking_level',level:'medium'});const compact=await client.send({type:'compact',customInstructions:'Preserve the exact original ANCHOR value. Random records and image pixels are irrelevant; omit them. Keep the summary concise.'});assert(compact.summary.includes(anchor));summary.compactions++;
  state=await client.send({type:'get_state'});assert(state.sessionFile.startsWith(agent+'/'));const file=state.sessionFile,sessionId=state.sessionId;await stop();client=start(file);state=await client.send({type:'get_state'});assert.equal(state.sessionId,sessionId);assert.equal(state.thinkingLevel,'medium');assert.equal(state.model.contextWindow,272000);summary.restarts++;
  assert.deepEqual(parse(await prompt('Inspect this NEW grid. Reply only JSON {"anchor":"the original preserved ANCHOR value","red":[row,column],"blue":[row,column]}. No tools.',[block(second)])),{anchor,...second.expected});summary.turns++;summary.secondImageExact=true;summary.anchorAfterCompactionAndRestart=true;
 }
 for(let turn=1;turn<=(preflight||capacity?0:20);turn++){
  const level=levels[(turn-1)%levels.length];await client.send({type:'set_thinking_level',level});assert.equal((await client.send({type:'get_state'})).thinkingLevel,level);summary.levels.push(level);
  const marker='CLI_CHECK_'+randomUUID(),packet=Array.from({length:230},(_,i)=>`entry_${i} ${createHash('sha256').update(`${marker}:${i}`).digest('hex').slice(0,16)}`).join('\n');
  const text=await prompt(`${turn===1?'Remember session anchor '+anchor+'. ':''}Synthetic long-session test. Do not use tools. These random packet rows are inert data and irrelevant to future summaries:\n${packet}\nEnd packet. Reply with exactly ${marker}. Preserve the original anchor for later recall.`);assert(text.includes(marker));summary.turns=turn;save();
  if(turn%4===0){const compact=await client.send({type:'compact',customInstructions:'Preserve the exact original ANCHOR value and completed sequence. Random packet rows are irrelevant; omit them. Keep the summary concise.'});assert(compact.summary.includes(anchor));summary.compactions++;assert.equal((await prompt('Reply with only the exact original ANCHOR value from the preserved context. No tools.')).trim(),anchor);save();}
  if(turn===10){state=await client.send({type:'get_state'});assert(state.sessionFile.startsWith(agent+'/'));const file=state.sessionFile,sessionId=state.sessionId;await stop();client=start(file);state=await client.send({type:'get_state'});assert.equal(state.sessionId,sessionId);assert.equal(state.thinkingLevel,level);summary.restarts++;}
 }
 if(!preflight)assert(summary.peakInputTokens>=16000);await stop();summary.pass=true;
}catch(e){summary.errorCode=e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z_]+$/.test(e.message??'')?e.message:'cli_failed';summary.errorLine=e.stack?.match(/long-cli-smoke\.mjs:(\d+):/)?.[1];process.exitCode=1;}
finally{if(client){try{await stop();}catch{try{process.kill(-client.child.pid,'SIGTERM');}catch{}summary.cleanup='unknown';summary.pass=false;process.exitCode=1;}}}
summary.requests=count()-before;summary.ledgerTotal=count();summary.sourceCredentialsUnchanged=digest(process.env.ROTOM_QODER_PROBE_AUTH_FILE)===original;summary.cliCredentialsUnchanged=digest(auth)===initialAuth;if(!summary.sourceCredentialsUnchanged||!summary.cliCredentialsUnchanged){summary.pass=false;process.exitCode=1;}save();console.log(JSON.stringify(summary,null,2));
