// Read-only, metadata-only protocol reconnaissance. No tool execution or retry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHAT_URL } from '../../rotom/extensions/qoder/transport.mjs';
import { readProbeCredential } from './probe-credential.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = new Set('choices delta usage error code message type status id encrypted_content summary text data format headers body statusCodeValue statusCode signature hash checksum digest target_hash cache_key provider model reasoning_item reasoning_content reasoning_details reasoning_content_signature reasoning_summary_already_streamed content tool_calls index function name arguments finish_reason prompt_tokens completion_tokens total_tokens firstTokenDuration totalDuration serverDuration'.split(' '));
const enums = new Set(['reasoning','reasoning.encrypted','reasoning.text','reasoning.summary','summary_text','text','completed','in_progress','incomplete','redacted_thinking','tool_use','end_turn','max_tokens','stop_sequence','pause_turn','null','tool_calls','stop','length','function_call','tool_call','finish','finished','complete','eos']);
export function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (typeof value === 'string') return { type:'string',bytes:Buffer.byteLength(value),...(enums.has(value)?{enum:value}:{}) };
  if (typeof value !== 'object') return typeof value;
  if (depth >= 5) return Array.isArray(value)?'array':'object';
  if (Array.isArray(value)) return { type:'array',length:value.length,items:value.slice(0,3).map(v=>shape(v,depth+1)) };
  return Object.fromEntries(Object.entries(value).slice(0,32).map(([k,v],i)=>[fields.has(k)?k:`unknown_${i}`,fields.has(k)?shape(v,depth+1):{keyDigest:createHash('sha256').update(k).digest('hex'),value:shape(v,depth+1)}]));
}
export function parseProbeFrames(text) {
  assert(Buffer.byteLength(text)<=8*1024*1024);
  const frames=[];
  for(const frame of text.split(/\r?\n\r?\n/)) {
    if(!frame.trim())continue;
    assert(Buffer.byteLength(frame)<=1024*1024);
    const lines=frame.split(/\r?\n/), at=lines.findIndex(l=>l.startsWith('data:'));
    if(at<0){frames.push({eventError:lines.some(l=>l==='event: error')});continue;}
    const standard=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
    const joined=lines[at].slice(5).replace(/^ /,'')+lines.slice(at+1).join('');
    let data;
    if(standard==='[DONE]'||standard.startsWith('[NOT_')||standard.startsWith('[NOTIFICATIONS]')||standard.startsWith('[EXCEED_QUOTA]'))data=standard;
    else {try{data=JSON.parse(standard);}catch{data=JSON.parse(joined);}}
    frames.push({data,eventError:lines.some(l=>l==='event: error'),eventFinish:lines.some(l=>l==='event: finish')});
  }
  return frames;
}
export function summarizeFrames(frames) {
  const result={frames:frames.length,done:false,finish:[],reasoningChars:0,textChars:0,toolDeltas:0,opaque:[],errors:[],usage:[],deltaKinds:[]};
  for(const {data:d,eventError} of frames){
    if(d==='[DONE]'){result.done=true;continue;}
    if(eventError||d?.error||(record(d)&&d.code!==undefined&&d.code!==0&&d.code!==200)||typeof d==='string'&&d.startsWith('[EXCEED_QUOTA]')){
      // Error strings stay in memory; output only structural metadata and fixed
      // diagnostic categories, never service prose, identifiers or raw bodies.
      const prose=(JSON.stringify(d)??'').toLowerCase();
      result.errors.push({shape:shape(d),categories:['thinking','reasoning','quota','permission','unsupported','invalid','balance','capacity','rate limit','model'].filter(t=>prose.includes(t))});
    }
    for(const c of d?.choices??[]){
      if(c.finish_reason)result.finish.push(['stop','tool_calls','length','tool_use','end_turn','max_tokens','null','stop_sequence','pause_turn','function_call','tool_call','finish','finished','complete','eos'].includes(c.finish_reason)?c.finish_reason:'unknown');
      const delta=record(c.delta)?c.delta:{};
      const kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
      if(result.deltaKinds.length<48)result.deltaKinds.push({delta:kind(c.delta),finish:kind(c.finish_reason),fields:Object.fromEntries(['role','content','reasoning_content'].filter(k=>k in delta).map(k=>[k,kind(delta[k])]))});
      result.reasoningChars+=typeof delta.reasoning_content==='string'?delta.reasoning_content.length:0;
      result.textChars+=typeof delta.content==='string'?delta.content.length:0;
      result.toolDeltas+=(delta.tool_calls??[]).length;
      for(const key of ['reasoning_item','reasoning_details','reasoning_content_signature','reasoning_summary_already_streamed'])if(delta[key]!==undefined&&result.opaque.length<32)result.opaque.push({field:key,shape:shape(delta[key])});
    }
    if(d?.usage)result.usage.push(Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isSafeInteger(d.usage[k])&&d.usage[k]>=0).map(k=>[k,d.usage[k]])));
  }
  return result;
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const [model,mode]=process.argv.slice(2);
  assert(process.argv.length===4&&['ultimate','dfmodel'].includes(model)&&['on','off','text'].includes(mode));
  const ledger=process.env.ROTOM_QODER_PROBE_LEDGER;
  assert(ledger&&process.execArgv.some(a=>a.endsWith('live-budget.mjs')));
  const before=Number(readFileSync(ledger,'utf8'));
  const digest=()=>createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');
  const summary={model,mode,observed:false};let original,dispatches=0;
  try{
    original=digest();const c=await readProbeCredential();const nonce=randomUUID(),requestId=randomUUID();
    const signal=AbortSignal.timeout(60000);
    const payload={model,stream:true,max_tokens:1024,enable_thinking:mode!=='off',...(mode==='off'?{reasoning_effort:'none'}:{}),stream_options:{include_usage:true},messages:[{role:'user',content:`Synthetic protocol test. Call protocol_probe exactly once with nonce ${nonce}. Do not produce an answer before the tool result.`}],tools:[{type:'function',function:{name:'protocol_probe',description:'Synthetic echo, no external effects.',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}}],metadata:{context:{request_id:requestId,request_set_id:requestId,session_id:requestId,task_id:'common',client_type:'rotom'}}};
    if(mode==='text'){payload.messages=[{role:'user',content:`Synthetic framing test. Reply with exactly TEXT_${nonce}. No tools or explanation.`}];delete payload.tools;}
    dispatches++;
    const response=await fetch(CHAT_URL,{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${c.accessToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(payload)});
    summary.httpStatus=response.status;
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;assert(size<=8*1024*1024);chunks.push(chunk);}
    assert(response.ok);Object.assign(summary,summarizeFrames(parseProbeFrames(Buffer.concat(chunks).toString('utf8'))));summary.observed=true;
  }catch(e){summary.errorCode=/^[a-z_]+$/.test(e.code??'')?e.code:'probe_failed';process.exitCode=1;}
  summary.requests=Number(readFileSync(ledger,'utf8'))-before;summary.ledgerTotal=Number(readFileSync(ledger,'utf8'));summary.credentialsUnchanged=original?original===digest():null;
  if(summary.requests!==dispatches||summary.credentialsUnchanged===false)process.exitCode=1;
  console.log(JSON.stringify(summary,null,2));
}
