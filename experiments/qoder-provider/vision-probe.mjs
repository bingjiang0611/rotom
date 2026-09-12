// Authorized raw vision protocol probe; synthetic random pixels, no image URLs/files or tools.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomInt,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {SUPPORTED_MODEL_IDS,REASONING_MODEL_IDS,OPAQUE_MODEL_IDS,normalizeSSE,CHAT_URL} from '../../rotom/extensions/qoder/transport.mjs';
import {LEGACY_MODEL_IDS,LEGACY_URL,legacyBody,legacyHeaders} from '../../rotom/extensions/qoder/legacy.mjs';
import {readProbeCredential} from './probe-credential.mjs';
import {parseProbeFrames,shape} from './reasoning-probe.mjs';
import {probeWire} from './probe-wire.mjs';
function crc32(b){let c=0xffffffff;for(const n of b){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),h=Buffer.alloc(4),c=Buffer.alloc(4);h.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([h,t,data,c]);}
export function gridImage(red=randomInt(25),blue=randomInt(25)){
 if(blue===red)blue=(blue+1)%25;assert(Number.isInteger(red)&&red>=0&&red<25&&Number.isInteger(blue)&&blue>=0&&blue<25);
 const w=500,h=500,raw=Buffer.alloc(h*(1+w*3));
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const cell=Math.floor(y/100)*5+Math.floor(x/100),grid=x%100<3||y%100<3;
  const rgb=grid?[40,40,40]:cell===red?[230,20,40]:cell===blue?[30,70,230]:[245,245,245];
  const i=y*(1+w*3)+1+x*3;for(let k=0;k<3;k++)raw[i+k]=rgb[k];
 }
 const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
 return {png:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]),expected:{red:[Math.floor(red/5)+1,red%5+1],blue:[Math.floor(blue/5)+1,blue%5+1]}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const [mode,id,override,effortOverride]=process.argv.slice(2);assert(mode==='--live'&&process.argv.length<=6&&SUPPORTED_MODEL_IDS.includes(id)&&(override===undefined||override==='--legacy')&&(effortOverride===undefined||override==='--legacy'&&['default','none','high'].includes(effortOverride)));
 assert(process.execArgv.some(a=>a.endsWith('live-budget.mjs')));const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,before=Number(readFileSync(ledger,'utf8'));
 const digest=()=>createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex'),original=digest();
 const legacy=override==='--legacy'||LEGACY_MODEL_IDS.includes(id),result={model:id,pass:false,level:'raw HTTP only',transport:legacy?'legacy':'direct'};let attempted=false;
 try{
  const catalog=JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8'));assert(catalog.pass);
  const e=catalog.scenes.assistant.find(e=>e.key===id);assert(e?.enable&&e.source==='system'&&e.format==='openai'&&e.is_vl===true);
  const c=await readProbeCredential(),request=randomUUID(),image=gridImage(),thinking=REASONING_MODEL_IDS.includes(id);
  const prompt='This image is a 5 by 5 grid. Locate the red and blue filled cells. Rows count top to bottom and columns left to right, both starting at 1. Reply only JSON with keys red and blue, each containing [row,column].';
  const content=[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:image/png;base64,'+image.png.toString('base64')}}];
  const payload={model:id,messages:[{role:'user',content}],stream:true,stream_options:{include_usage:true},max_tokens:2048,enable_thinking:thinking,...thinking?{}:{reasoning_effort:'none'}};
  let body,headers;
  if(override==='--legacy'){
   assert(process.env.ROTOM_QODER_PROBE_LEGACY==='1');
   const selectedContext=effortOverride===undefined?32000:Object.values(e.context_config??{}).find(v=>v.is_default===true)?.token_count??null;
   result.selectedContext=selectedContext;result.selectedEffort=effortOverride??(thinking?'high':'none');
   const wire=probeWire({id,entry:e,credential:c,messages:payload.messages,effort:result.selectedEffort,contextLength:selectedContext,route:'legacy'});body=wire.body;headers=wire.headers;
  }else if(legacy){
   assert(process.env.ROTOM_QODER_PROBE_LEGACY==='1');
   // Product remains text-only: use its fixed envelope with placeholder text,
   // then replace only the synthetic message with the observed CLI image shape.
   const encoded=legacyBody({...payload,messages:[{role:'user',content:prompt}]},{id,name:e.display_name,enabled:true,reviewed:true,format:'openai',reportedImages:true,reportedReasoning:thinking,reportedContextWindow:e.max_input_tokens,contextWindow:32000},request,request);
   const standard='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
   const shuffled=[...encoded].map(c=>standard[custom.indexOf(c)]).join(''),n=shuffled.length,a=Math.floor(n/3);
   const envelope=JSON.parse(Buffer.from(shuffled.slice(n-a)+shuffled.slice(a,n-a)+shuffled.slice(0,a),'base64').toString());
   envelope.messages=[{role:'user',content,contents:content}];envelope.chat_context.text='';envelope.chat_context.extra.originalContent='';
   const {encodeBody}=await import('../../rotom/extensions/qoder/legacy.mjs');body=encodeBody(JSON.stringify(envelope));headers=legacyHeaders(c,body,id);
  }else{body=JSON.stringify(payload);headers={Authorization:`Bearer ${c.accessToken}`,'Content-Type':'application/json',Accept:'text/event-stream'};}
  attempted=true;const response=await fetch(legacy?LEGACY_URL:CHAT_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers,body});result.httpStatus=response.status;
  let size=0;const chunks=[];for await(const b of response.body){size+=b.length;assert(size<=4*1024*1024);chunks.push(b);}assert(response.ok);
  const wireText=Buffer.concat(chunks).toString('utf8'),frames=parseProbeFrames(wireText);let answer='',usage,done=false,finished=false,errors=false;
  result.opaqueShapes=[];result.metering={};
  for(const f of frames){let d=f.data;if(d==='[DONE]'||d?.body==='[DONE]'){done=true;continue;}if(d?.statusCodeValue!==undefined){if(d.statusCodeValue!==200){errors=true;continue;}try{d=JSON.parse(d.body);}catch{continue;}}
   errors ||= f.eventError||Boolean(d?.error);if(d?.usage){usage=d.usage;for(const k of ['credits','original_credits','billable'])if(k==='billable'?typeof usage[k]==='boolean':typeof usage[k]==='number'&&Number.isFinite(usage[k])&&usage[k]>=0)result.metering[k]=usage[k];}
   for(const c of d?.choices??[]){if(c.finish_reason==='stop')finished=true;answer+=c.delta?.content??'';if(c.delta?.reasoning_item&&result.opaqueShapes.length<2)result.opaqueShapes.push(shape(c.delta.reasoning_item));}
  }
  const tail=frames.at(-1)?.data;
  const metrics=legacy&&tail&&Object.keys(tail).sort().join(',')==='firstTokenDuration,serverDuration,totalDuration'&&Object.values(tail).every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0);
  result.literalDone=done;result.metricsTrailer=Boolean(metrics);result.normalizerAccepted=false;
  // Research-only terminal policy; this does not extend product model allowlists.
  try{for await(const unused of normalizeSSE(new Response(wireText).body,{allowReasoning:true,allowOpaqueReasoning:OPAQUE_MODEL_IDS.includes(id),opaqueModelId:id,allowLegacyEnvelope:legacy,allowLegacyMetricsDone:legacy})){void unused;}result.normalizerAccepted=true;}catch(e){result.normalizationError=e.code??'normalizer_failed';}
  result.protocolComplete=result.normalizerAccepted&&finished&&Boolean(usage)&&(done||Boolean(metrics))&&!errors;
  const trimmed=answer.trim(),fence=trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);result.fenced=Boolean(fence);result.answerBytes=Buffer.byteLength(trimmed);
  let parsed;try{parsed=JSON.parse(fence?fence[1]:trimmed);result.jsonParsed=true;}catch{result.jsonParsed=false;}
  try{assert.deepEqual(parsed,image.expected);result.answerMatched=true;}catch{result.answerMatched=false;}
  result.usage=usage?{input:usage.prompt_tokens,output:usage.completion_tokens,total:usage.total_tokens}:null;
  result.pass=result.protocolComplete&&result.answerMatched;
 }catch(e){result.errorCode=typeof e.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'vision_probe_failed';}
 result.requests=Number(readFileSync(ledger,'utf8'))-before;result.ledgerTotal=Number(readFileSync(ledger,'utf8'));result.credentialsUnchanged=original===digest();if(!result.pass||!result.credentialsUnchanged||result.requests!==Number(attempted))process.exitCode=1;
 console.log(JSON.stringify(result,null,2));
}
