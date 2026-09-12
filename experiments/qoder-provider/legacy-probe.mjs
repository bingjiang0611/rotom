// Maintenance-only comparison, never a runtime fallback or nested agent loop.
// Protocol/encoding reference: 9router d2fd11b11698795a2c4479ef6906304f22162475,
// body.js/chat.js/encoding.js. Copyright (c) 2024-2026 decolua and contributors,
// MIT license retained in rotom/THIRD_PARTY_NOTICES.md.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {LEGACY_URL,LEGACY_MODEL_IDS,encodeBody,legacyHeaders} from '../../rotom/extensions/qoder/legacy.mjs';
export {LEGACY_PATH,LEGACY_URL,encodeBody,legacyHeaders} from '../../rotom/extensions/qoder/legacy.mjs';
import {readProbeCredential} from './probe-credential.mjs';
import {parseProbeFrames,summarizeFrames,shape} from './reasoning-probe.mjs';
import {pathToFileURL} from 'node:url';

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const [mode,modelId='dfmodel',kind='text']=process.argv.slice(2);
  assert(mode==='--live'&&process.argv.length<=5&&LEGACY_MODEL_IDS.includes(modelId)&&['text','tool'].includes(kind));
  const ledger=process.env.ROTOM_QODER_PROBE_LEDGER;assert(ledger&&process.env.ROTOM_QODER_PROBE_LEGACY==='1'&&process.execArgv.some(a=>a.endsWith('live-budget.mjs')));
  const before=Number(readFileSync(ledger,'utf8'));const digest=()=>createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex');
  const summary={model:modelId,kind,transport:'legacy',pass:false};let original,dispatches=0;
  try{
    original=digest();const c=await readProbeCredential();
    const catalog=JSON.parse(readFileSync(process.env.ROTOM_QODER_PROBE_CATALOG_FILE,'utf8'));assert(catalog.pass);
    const model=catalog.scenes.assistant.find(m=>m.key===modelId);assert(model?.enable&&model.source==='system'&&model.format==='openai');
    const requestId=randomUUID(),marker=`LEGACY_${randomUUID()}`,prompt=`Synthetic inference transport test. Reply with exactly ${marker}. No tools or explanation.`;
    const payload={request_id:requestId,request_set_id:requestId,chat_record_id:requestId,session_id:randomUUID(),chat_task:'FREE_INPUT',stream:true,is_reply:true,is_retry:false,source:1,version:'3',agent_id:'agent_common',task_id:'common',aliyun_user_type:'',session_type:'qodercli',
      model_config:{key:model.key,display_name:model.display_name,model:'',format:model.format,is_vl:model.is_vl,is_reasoning:model.is_reasoning,api_key:'',url:'',source:model.source,max_input_tokens:model.max_input_tokens},
      system:'',messages:[{role:'user',content:prompt}],tools:[],parameters:{max_tokens:1024,reasoning_effort:'high',context_length:32000},
      chat_context:{text:prompt,features:[],extra:{context:[],modelConfig:{key:modelId,is_reasoning:model.is_reasoning},originalContent:prompt},chatPrompt:'',imageUrls:null}};
    if(kind==='tool'){
      const instruction=`Synthetic protocol framing test. Compute 37*41+29 internally, then call protocol_probe once with nonce ${marker}. No answer before the tool result.`;
      payload.messages=[{role:'user',content:instruction}];payload.chat_context.text=instruction;payload.chat_context.extra.originalContent=instruction;
      payload.tools=[{type:'function',function:{name:'protocol_probe',description:'Synthetic no-effect function.',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}}];
    }
    const body=encodeBody(JSON.stringify(payload)),headers=legacyHeaders(c,body,modelId);dispatches++;
    const response=await fetch(LEGACY_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers,body});summary.httpStatus=response.status;
    let size=0;const chunks=[];for await(const b of response.body){size+=b.length;assert(size<=8*1024*1024);chunks.push(b);}
    const text=Buffer.concat(chunks).toString('utf8');
    if(!response.ok){let parsed;try{parsed=JSON.parse(text);}catch{}summary.responseShape=shape(parsed);throw new Error('legacy_http_error');}
    const raw=parseProbeFrames(text),frames=[];
    summary.envelopeShapes=raw.slice(0,3).map(f=>shape(f.data));
    summary.tail=raw.slice(-8).map(f=>({eventFinish:f.eventFinish===true,eventError:f.eventError===true,shape:shape(f.data),control:f.data==='[DONE]'||f.data?.body==='[DONE]'?'DONE':null}));
    summary.afterDone=[];let doneSeen=false;
    for(const f of raw){
      const body=f.data?.body??f.data;
      if(doneSeen&&summary.afterDone.length<12)summary.afterDone.push({outer:typeof f.data,wrapped:typeof f.data?.body==='string',control:typeof body==='string'&&['[DONE]','[NOT_EXCEED_QUOTA]'].includes(body)?body:typeof body==='string'&&body.startsWith('[NOTIFICATIONS]')?'notification':'unknown',shape:shape(f.data)});
      if(body==='[DONE]')doneSeen=true;
      if(f.data&&typeof f.data==='object'&&typeof f.data.body==='string'){
        let d;try{d=JSON.parse(f.data.body);}catch{d=f.data.body;}
        frames.push({data:d,eventError:f.eventError||f.data.statusCodeValue!==200});
      }else frames.push(f);
    }
    Object.assign(summary,summarizeFrames(frames));
    const answer=frames.flatMap(f=>f.data?.choices??[]).map(c=>c.delta?.content??'').join('').trim();
    summary.answerMatched=answer===marker;summary.pass=(kind==='text'?summary.answerMatched:summary.toolDeltas>0)&&summary.done&&summary.errors.length===0&&summary.finish.some(f=>['stop','tool_calls'].includes(f));
    if(!summary.pass)process.exitCode=1;
  }catch(e){summary.errorCode=/^[a-z_]+$/.test(e.code??'')?e.code:'legacy_probe_failed';process.exitCode=1;}
  summary.requests=Number(readFileSync(ledger,'utf8'))-before;summary.ledgerTotal=Number(readFileSync(ledger,'utf8'));summary.credentialsUnchanged=original?original===digest():null;
  if(summary.requests!==dispatches||summary.credentialsUnchanged===false)process.exitCode=1;
  console.log(JSON.stringify(summary,null,2));
}
