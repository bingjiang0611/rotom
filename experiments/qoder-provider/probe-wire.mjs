// Maintenance-only request builder for explicitly authorized capability experiments.
// Never registered as a provider or used as a runtime fallback. Exact observed keys only.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {SUPPORTED_MODEL_IDS,CHAT_URL} from '../../rotom/extensions/qoder/transport.mjs';
import {LEGACY_MODEL_IDS,LEGACY_URL,LEGACY_PATH,encodeBody} from '../../rotom/extensions/qoder/legacy.mjs';
import {catalogHeaders} from '../../rotom/extensions/qoder/catalog-auth.mjs';
export function decodeProbeBody(encoded){
 const standard='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',custom='_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
 assert(typeof encoded==='string'&&encoded.length<=24*1024*1024);
 const shuffled=[...encoded].map(c=>{assert(custom.includes(c));return standard[custom.indexOf(c)];}).join(''),n=shuffled.length,a=Math.floor(n/3);
 return JSON.parse(Buffer.from(shuffled.slice(n-a)+shuffled.slice(a,n-a)+shuffled.slice(0,a),'base64').toString('utf8'));
}
export function probeWire({id,entry,credential,messages,effort='high',contextLength=32000,route='current',maxTokens=2048,tools=[]}){
 assert(SUPPORTED_MODEL_IDS.includes(id)&&entry?.key===id&&entry.enable&&entry.source==='system'&&entry.format==='openai');
 assert(['current','legacy','direct'].includes(route)&&['default','none','low','medium','high','xhigh','max'].includes(effort));
 assert(contextLength===null||Number.isSafeInteger(contextLength)&&contextLength>0&&contextLength<=1000000);assert(Number.isSafeInteger(maxTokens)&&maxTokens>0&&maxTokens<=4096);
 const legacy=route==='legacy'||route==='current'&&LEGACY_MODEL_IDS.includes(id),requestId=randomUUID(),thinking=effort==='default'?entry.is_reasoning===true:effort!=='none';
 const controls={...effort==='default'?{}:{enable_thinking:thinking,reasoning_effort:effort},...contextLength===null?{}:{context_length:contextLength}};
 if(!legacy){
  // Qoder CLI 1.1.45 HTTP Cfn/GOc uses a numeric root context_length.
  // Do not confuse it with mfn's string metadata selector for gRPC.
  const body=JSON.stringify({model:id,messages,tools,stream:true,stream_options:{include_usage:true},max_tokens:maxTokens,...controls,metadata:{context:{request_id:requestId,request_set_id:requestId,session_id:requestId,client_type:'rotom'}}});
  assert(Buffer.byteLength(body)<=16*1024*1024);
  return{url:CHAT_URL,body,headers:{Authorization:`Bearer ${credential.accessToken}`,'Content-Type':'application/json',Accept:'text/event-stream'},route:'direct'};
 }
 const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),conversation=messages.filter(m=>m.role!=='system').map(m=>({...m,content:m.content??'',...Array.isArray(m.content)?{contents:m.content}:{}}));
 const prompt=[...conversation].reverse().find(m=>m.role==='user'&&typeof m.content==='string')?.content??'';
 const body=encodeBody(JSON.stringify({request_id:requestId,request_set_id:requestId,chat_record_id:requestId,session_id:requestId,chat_task:'FREE_INPUT',stream:true,is_reply:true,is_retry:false,source:1,version:'3',agent_id:'agent_common',task_id:'common',aliyun_user_type:'',session_type:'qodercli',model_config:{key:id,display_name:entry.display_name,model:'',format:'openai',is_vl:entry.is_vl===true,is_reasoning:thinking,api_key:'',url:'',source:'system',max_input_tokens:entry.max_input_tokens},system,messages:conversation,tools,parameters:{max_tokens:maxTokens,...controls},chat_context:{text:prompt,features:[],extra:{context:[],modelConfig:{key:id,is_reasoning:thinking},originalContent:prompt},chatPrompt:'',imageUrls:null}}));
 assert(Buffer.byteLength(body)<=24*1024*1024);
 const h=catalogHeaders(credential),payload=h.Authorization.slice('Bearer COSY.'.length).split('.')[0],md5=s=>createHash('md5').update(s).digest('hex');
 return{url:LEGACY_URL,body,route:'legacy',headers:{...h,Authorization:`Bearer COSY.${payload}.${md5(`${payload}\n${h['Cosy-Key']}\n${h['Cosy-Date']}\n${body}\n${LEGACY_PATH}`)}`,'Cosy-Sigpath':LEGACY_PATH,'Cosy-Bodyhash':md5(body),'Cosy-Bodylength':String(Buffer.byteLength(body)),Accept:'text/event-stream','Content-Type':'application/json','X-Model-Key':id,'X-Model-Source':'system'}};
}
