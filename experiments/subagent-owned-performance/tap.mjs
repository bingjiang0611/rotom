// Same lightweight, metadata-only instrumentation in both benchmark arms.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export default async function tap(api) {
 const config = JSON.parse(fs.readFileSync(process.env.ROTOM_SCOPE_BENCH_CONFIG, 'utf8'));
 const write = (kind, fields = {}) => fs.appendFileSync(config.events, JSON.stringify({kind, at:performance.timeOrigin+performance.now(), ...fields})+'\n', {mode:0o600});
 // wx rejects an accidental second Pi writer before it can dispatch a model request.
 fs.writeFileSync(config.writerMarker, String(process.pid), {flag:'wx',mode:0o600});
 write('writer-extension-ready');
 if (config.dry) {
  globalThis.fetch=()=>{throw Error('No network in dry benchmark');};
  const {fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText}=await import(pathToFileURL(config.fauxEntry));
  const f=fauxProvider({provider:'scope-bench',models:[{id:'fixture',contextWindow:100000}]});
  f.setResponses([
   ()=>fauxAssistantMessage([fauxToolCall('read',{path:'payload.txt'},{id:'read-payload'})],{stopReason:'toolUse'}),
   ()=>fauxAssistantMessage([fauxText('{"token":"ORCHID-47","sum":50}')],{stopReason:'stop'}),
  ]);
  api.registerProvider(f.provider.id,{name:f.provider.name,api:f.api,apiKey:'fixture-not-a-credential',streamSimple:f.provider.streamSimple,models:[...f.models]});
 }
 api.on('session_start',(_e,ctx)=>write('session-start',{model:ctx.model?.id,provider:ctx.model?.provider}));
 api.on('before_agent_start',e=>write('before-agent',{systemBytes:Buffer.byteLength(e.systemPrompt??''),systemDigest:createHash('sha256').update(e.systemPrompt??'').digest('hex')}));
 api.on('tool_call',e=>write('tool-start',{tool:e.toolName}));
 api.on('tool_result',e=>write('tool-end',{tool:e.toolName,isError:e.isError===true}));
 api.on('message_end',e=>{
  const m=e.message;if(m.role!=='assistant')return;
  const u=m.usage??{};write('assistant-end',{model:m.model,provider:m.provider,stopReason:m.stopReason,usage:{input:u.input,output:u.output,cacheRead:u.cacheRead,cacheWrite:u.cacheWrite,totalTokens:u.totalTokens,reportedCost:u.cost?.total}});
 });
 api.on('agent_end',()=>write('agent-end'));
 api.on('session_shutdown',()=>write('session-shutdown',{cpu:process.cpuUsage()}));
}
