// Maintenance-only native image/tool-image/disk replay over an explicit research wire.
// Not the product provider, not a capability switch, and not latency evidence (buffered).
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {MODEL} from '../../rotom/extensions/qoder/provider.mjs';
import {CHAT_URL,REASONING_MODEL_IDS,OPAQUE_MODEL_IDS,normalizeSSE,reasoningDetailsToItem} from '../../rotom/extensions/qoder/transport.mjs';
import {createCreditCollector} from '../../rotom/extensions/qoder/credits.mjs';
import {probeWire} from './probe-wire.mjs';
import {readProbeCredential} from './probe-credential.mjs';
import {gridImage} from './vision-probe.mjs';
import {parseProbeFrames} from './reasoning-probe.mjs';
const [mode='--offline',id='auto',userFormat='png',toolFormat='jpeg']=process.argv.slice(2),live=mode==='--live';
assert(['--offline','--live'].includes(mode)&&process.argv.length<=6&&[userFormat,toolFormat].every(x=>['png','jpeg','webp'].includes(x)));
const entry=process.env.ROTOM_PI;assert(isAbsolute(entry)&&lstatSync(entry).isFile()&&realpathSync(entry)===entry);assert(process.execArgv.includes('--experimental-import-meta-resolve'));
const ai=await import(import.meta.resolve('@earendil-works/pi-ai',pathToFileURL(entry).href)),openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',pathToFileURL(entry).href)),sdk=await import(import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,count=()=>live?Number(readFileSync(ledger,'utf8')):0,before=count(),authFile=process.env.ROTOM_QODER_PROBE_AUTH_FILE,hash=()=>live?createHash('sha256').update(readFileSync(authFile)).digest('hex'):null,authBefore=hash();
if(live)assert(process.execArgv.some(x=>x.endsWith('live-budget.mjs')));
const catalog=live?JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8')).scenes.assistant:[{key:id,display_name:'Synthetic',source:'system',enable:true,format:'openai',is_vl:true,is_reasoning:false,max_input_tokens:200000}];
const row=catalog.find(e=>e.key===id);assert(row?.is_vl===true&&row.enable&&row.source==='system');
const credential=live?await readProbeCredential():{accessToken:'fixture',uid:'fixture-user',org:'',machineId:'fixture-machine'};
const reasoning=REASONING_MODEL_IDS.includes(id),route=['auto','performance'].includes(id)?'legacy':'current',effort=reasoning?'high':'none';
const selectedContext=Object.values(row.context_config??{}).find(x=>x.is_default===true)?.token_count??null;
const model={...MODEL,id,provider:'qoder-vision-research',reasoning,input:['text','image']};
function picture(format){const source=gridImage();let bytes=source.png;if(format!=='png')bytes=execFileSync('python3',['-c',"from PIL import Image;import io,sys;im=Image.open(io.BytesIO(sys.stdin.buffer.read()));im.save(sys.stdout.buffer,format=sys.argv[1],quality=95)",format.toUpperCase()],{input:bytes,timeout:30000,maxBuffer:4*1024*1024});return{block:{type:'image',data:bytes.toString('base64'),mimeType:'image/'+format},expected:source.expected};}
const firstImage=picture(userFormat),nonce=randomUUID(),marker='IMAGE_RESULT_'+randomUUID();let secondImage;do{secondImage=picture(toolFormat);}while(['red','blue'].some(k=>JSON.stringify(firstImage.expected[k])===JSON.stringify(secondImage.expected[k])));
const coordinates=ai.Type.Array(ai.Type.Integer({minimum:1,maximum:5}),{minItems:2,maxItems:2}),tools=[{name:'vision_probe',description:'Report the first image coordinates. Returns a fresh marker and a DIFFERENT image to inspect.',parameters:ai.Type.Object({nonce:ai.Type.String(),red:coordinates,blue:coordinates},{additionalProperties:false})}];
const context={messages:[{role:'user',content:[{type:'text',text:`Inspect the attached 5x5 grid. Call vision_probe once with nonce ${nonce} and red/blue cell coordinates [row,column], 1-based. After its result, inspect the DIFFERENT image attached by the tool and reply only JSON {"red":[row,column],"blue":[row,column],"marker":"the exact tool marker"}. Do not reuse the first image coordinates.`},firstImage.block],timestamp:Date.now()}],tools};
const summary={pass:false,scope:'maintenance native SDK; NOT product capability',mode,id,userFormat,toolFormat,route,selectedContext,effort,rounds:[],metering:[]};let dispatches=0,wireCalls=0,firstOpaque;
const event=(d,legacy)=>`data: ${JSON.stringify(legacy?{statusCodeValue:200,body:JSON.stringify(d)}:d)}\n\n`;
async function fetchWire(url,init){
 assert.equal(String(url),CHAT_URL);assert(wireCalls<2);wireCalls++;const body=JSON.parse(init.body);
 for(const message of body.messages){if(message.reasoning_details){message.reasoning_item=reasoningDetailsToItem(message.reasoning_details,id);delete message.reasoning_details;}}
 if(wireCalls===2){const images=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='image_url'):[]);assert.equal(images.length,2);assert(images.some(b=>b.image_url.url===`data:${secondImage.block.mimeType};base64,${secondImage.block.data}`));summary.toolImageOnWire=true;if(firstOpaque){assert.deepEqual(body.messages.find(m=>m.reasoning_item)?.reasoning_item,firstOpaque);summary.opaqueReplay=true;}}
 const wire=probeWire({id,entry:row,credential,messages:body.messages,tools:body.tools,route,effort,contextLength:selectedContext,maxTokens:4096});
 let response;
 if(live){dispatches++;response=await fetch(wire.url,{method:'POST',headers:wire.headers,body:wire.body,redirect:'error',signal:AbortSignal.timeout(90000)});summary.httpStatus=response.status;assert(response.ok);
  const chunks=[];let size=0;for await(const bytes of response.body){size+=bytes.length;assert(size<=4*1024*1024);chunks.push(bytes);}const raw=Buffer.concat(chunks),finishes=new Set();let opaqueFrames=0;
  for(const frame of parseProbeFrames(raw.toString('utf8'))){let data=frame.data;if(typeof data?.body==='string'){try{data=JSON.parse(data.body);}catch{continue;}}for(const c of data?.choices??[]){if(typeof c.finish_reason==='string')finishes.add(/^[a-z_]{1,32}$/.test(c.finish_reason)?c.finish_reason:'nonstandard');if(c.delta?.reasoning_item)opaqueFrames++;}}
  summary.upstreamShape??=[];summary.upstreamShape.push({finishReasons:[...finishes].slice(0,8),opaqueFrames});response=new Response(raw);
 }
 else{const delta=wireCalls===1?{tool_calls:[{index:0,id:'vision-call',type:'function',function:{name:'vision_probe',arguments:JSON.stringify({nonce,...firstImage.expected})}}]}:{content:JSON.stringify({...secondImage.expected,marker})};response=new Response(event({choices:[{delta,finish_reason:null}]},wire.route==='legacy')+event({choices:[{delta:{},finish_reason:wireCalls===1?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,credits:.2,billable:true}},wire.route==='legacy')+'data: [DONE]\n\n');}
 const meter=createCreditCollector(),frames=[];let bytes=0;
 try{for await(const frame of normalizeSSE(response.body,{allowReasoning:reasoning,allowOpaqueReasoning:OPAQUE_MODEL_IDS.includes(id),opaqueModelId:id,allowLegacyEnvelope:wire.route==='legacy',allowLegacyMetricsDone:wire.route==='legacy',toolNames:['vision_probe'],onCreditUsage:v=>meter.observe(v)})){bytes+=Buffer.byteLength(frame);assert(bytes<=4*1024*1024);frames.push(frame);if(wireCalls===1&&OPAQUE_MODEL_IDS.includes(id)&&frame!=='data: [DONE]\n\n'){const data=JSON.parse(frame.slice(6));const details=data.choices?.find(x=>x.delta?.reasoning_details)?.delta.reasoning_details;if(details)firstOpaque=reasoningDetailsToItem(details,id);}}
 summary.metering.push(meter.finish('complete'));return new Response(frames.join(''),{headers:{'content-type':'text/event-stream'}});
 }catch(e){summary.metering.push(meter.finish('error'));summary.protocolError=/^[a-z_]+$/.test(e.code??'')?e.code:'probe_normalizer_failed';throw e;}
}
const options={apiKey:'research-transport-resolves-auth',maxTokens:4096,maxRetries:0,fetch:fetchWire};
const dir=realpathSync(mkdtempSync(join(live?dirname(ledger):tmpdir(),'qoder-vision-sdk-')));
try{
 const first=await openAI.stream(model,context,options).result();summary.rounds.push({stopReason:first.stopReason,usage:first.usage});assert.equal(first.stopReason,'toolUse');const calls=first.content.filter(b=>b.type==='toolCall');summary.toolCalls=calls.length;assert.equal(calls.length,1);summary.toolNameExact=calls[0].name==='vision_probe';summary.firstNonceExact=calls[0].arguments.nonce===nonce;summary.firstCoordinatesExact=['red','blue'].every(k=>JSON.stringify(calls[0].arguments[k])===JSON.stringify(firstImage.expected[k]));assert.equal(calls[0].name,'vision_probe');assert.deepEqual(calls[0].arguments,{nonce,...firstImage.expected});
 const toolResult={role:'toolResult',toolCallId:calls[0].id,toolName:'vision_probe',isError:false,timestamp:Date.now(),content:[{type:'text',text:`Marker: ${marker}. Inspect the attached second grid, not the first grid.`},secondImage.block]};
 const manager=sdk.SessionManager.create(dir,dir);for(const message of [...context.messages,first,toolResult])manager.appendMessage(message);assert(existsSync(manager.getSessionFile()));context.messages=sdk.SessionManager.open(manager.getSessionFile(),dir).buildSessionContext().messages;
 const second=await openAI.stream(model,context,options).result();summary.rounds.push({stopReason:second.stopReason,usage:second.usage});assert.equal(second.stopReason,'stop');let text=second.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(/^```(?:json)?\s*[\s\S]*\s*```$/.test(text))text=text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');const parsed=JSON.parse(text);summary.coordinatesExact=['red','blue'].every(k=>JSON.stringify(parsed[k])===JSON.stringify(secondImage.expected[k]));summary.markerExact=parsed.marker===marker;assert.deepEqual(parsed,{...secondImage.expected,marker});assert.equal(wireCalls,2);assert(summary.toolImageOnWire);summary.opaqueObserved=Boolean(firstOpaque);if(firstOpaque)assert(summary.opaqueReplay);summary.diskImageReplay=true;summary.pass=true;
}catch(e){summary.errorCode=e.code==='ERR_ASSERTION'?'assertion_failed':/^[a-z_]+$/.test(e.code??'')?e.code:'native_vision_failed';summary.errorLocation=e.stack?.match(/vision-sdk-probe\.mjs:(\d+):/)?.[1]??'unknown';process.exitCode=1;}
summary.requests=count()-before;summary.ledgerTotal=count();summary.credentialsUnchanged=authBefore===hash();if(summary.requests!==dispatches||!summary.credentialsUnchanged){summary.pass=false;process.exitCode=1;}writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary,null,2));
