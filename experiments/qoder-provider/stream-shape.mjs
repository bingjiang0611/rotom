// Bounded maintenance diagnostics: types, lengths and fixed enums only, never
// response content, tool arguments, IDs, opaque items or upstream error prose.
import {parseProbeFrames,shape} from './reasoning-probe.mjs';
const kind=v=>v===undefined?'missing':v===null?'null':Array.isArray(v)?'array':typeof v;
const opaqueShape=v=>({type:kind(v),...v!==null&&typeof v==='object'&&!Array.isArray(v)?{fieldCount:Object.keys(v).length,fields:Object.fromEntries(['id','encrypted_content','target_hash'].filter(k=>Object.hasOwn(v,k)).map(k=>[k,{type:kind(v[k]),...typeof v[k]==='string'?{bytes:Buffer.byteLength(v[k])}:{}}]))}:Array.isArray(v)?{length:v.length}:{}});
export function streamShape(text){
 const describe=line=>({bytes:Buffer.byteLength(line),kind:line.startsWith('data:')?'data':/^(event|id|retry):/.test(line)?'field':line.startsWith(':')?'comment':/^data\s+:/.test(line)?'spaced-data':/^(d|da|dat|data|a:|ta:|ata:)$/.test(line)?'data-fragment':line.startsWith('{')?'json-object':line.startsWith('[')?'json-array':/^\s/.test(line)?'whitespace':'other',...['d','da','dat','data','a:','ta:','ata:','[DONE]','[NOT_EXCEED_QUOTA]','[NOTIFICATIONS]','DONE'].includes(line)?{literal:line}:{}});
 const malformed=[],unexpected=[],frameKinds=[];
 for(const block of text.split(/\r\n\r\n|\n\n|\r\r/)){
  if(!block.trim())continue;const lines=block.split(/\r\n|\n|\r/);
  const firstData=lines.find(l=>l.startsWith('data:')),payload=firstData?.slice(5).trimStart();
  frameKinds.push(payload?.startsWith('[NOTIFICATIONS]')?'notifications':payload==='[DONE]'?'done':payload?.startsWith('[NOT_')?'quota':firstData?'data':'unprefixed');
  if(!firstData&&malformed.length<12){
   const raw=lines.filter(Boolean),joined=raw.join('');let schema;try{schema=shape(JSON.parse(joined));}catch{}
   let prefix='',splitPrefixParts=0;for(let i=0;i<Math.min(raw.length,5);i++){prefix+=raw[i];if(prefix.startsWith('data:')){splitPrefixParts=i+1;break;}if(!'data:'.startsWith(prefix))break;}
   malformed.push({lines:lines.length,splitPrefixParts,first:describe(raw[0]??''),last:describe(raw.at(-1)??''),knownFields:['usage','choices','reasoning_content','raw_usage','tool_calls','credits','firstTokenDuration','model','message','error'].filter(k=>joined.includes('"'+k+'"')),schema,after:frameKinds.at(-2)});
  }
  const standard=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');let standardValid=standard==='[DONE]';try{JSON.parse(standard);standardValid=true;}catch{}
  const raw=lines.filter(l=>l&&!/^(data:|event:|id:|retry:|:)/.test(l));
  if((raw.length&&standardValid||raw.includes(lines[0]))&&unexpected.length<12)unexpected.push({lines:lines.length,standardValid,rawLines:raw.length,first:describe(raw[0]??''),last:describe(raw.at(-1)??'')});
 }
 const result={frames:0,terminals:[],tools:[],opaque:[],originalCollectorRejects:false,unprefixedFrames:malformed,unexpectedFieldFrames:unexpected,tailKinds:frameKinds.slice(-10),parsed:true},ids=new Map();
 let frames;try{frames=parseProbeFrames(text);}catch{result.parsed=false;return result;}
 for(const frame of frames){
  result.frames++;let d=frame.data;
  if(typeof d?.body==='string'){try{d=JSON.parse(d.body);}catch{continue;}}
  if(!Array.isArray(d?.choices))continue;
  if(d.usage)result.usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isSafeInteger(d.usage[k])&&d.usage[k]>=0).map(k=>[k,d.usage[k]]));
  for(const c of d.choices){
   if(result.opaque.length<8&&(c?.delta?.reasoning_item!==undefined||c?.delta?.reasoning_details!==undefined))result.opaque.push({frame:result.frames,item:opaqueShape(c.delta.reasoning_item),details:opaqueShape(c.delta.reasoning_details)});
   if(c?.finish_reason!=null&&result.terminals.length<8)result.terminals.push({finish:['stop','tool_calls','length','function_call'].includes(c.finish_reason)?c.finish_reason:'other',delta:kind(c.delta)});
   for(const t of Array.isArray(c?.delta?.tool_calls)?c.delta.tool_calls:[]){
    const index=t?.index??0,prior=ids.get(index),id=t?.id;
    const changed=typeof id==='string'&&id!==''&&prior!==undefined&&prior!==id;
    const invalid=id!==undefined&&id!==''&&(typeof id!=='string'||id.length>512||changed);
    if(invalid)result.originalCollectorRejects=true;
    if(result.tools.length<96)result.tools.push({index:Number.isSafeInteger(index)&&index>=0&&index<64?index:'other',indexType:kind(t?.index),idType:kind(id),idLength:typeof id==='string'?id.length:null,relation:id===prior?'same':prior===undefined?'first':changed?'changed':'absent',prefixExtension:changed&&id.startsWith(prior),suffixFragment:changed&&prior.endsWith(id),functionType:kind(t?.function),nameType:kind(t?.function?.name),argumentType:kind(t?.function?.arguments),originalCollectorRejects:invalid});
    if(typeof id==='string'&&id.length&&id.length<=512)ids.set(index,id);
   }
  }
 }
 return result;
}
export async function observeStream(response){
 let reader;
 try{
  reader=response.clone().body.getReader();let size=0;const chunks=[];
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)return{complete:false,reason:'oversized'};chunks.push(value);}
  return{complete:true,...streamShape(Buffer.concat(chunks).toString('utf8'))};
 }catch{return{complete:false,reason:'unavailable'};}
 finally{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
}
