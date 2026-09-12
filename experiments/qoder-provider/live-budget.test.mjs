import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const preload = join(import.meta.dirname,'live-budget.mjs');
const target={origin:'https://api2-v2.qoder.sh',path:'/model/v1/chat/completions',method:'POST'};
function fixture(t, initial=0) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'qoder-ledger-test-'))),file=join(dir,'ledger');
  writeFileSync(file,String(initial),{mode:0o600});t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {file,run:(request,realm=false,env={})=>spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',`import {channel} from 'node:diagnostics_channel';import vm from 'node:vm'; const publish=()=>channel('undici:request:create').publish({request:${JSON.stringify(request)}}); ${realm?"vm.runInNewContext('publish()',{publish})":"publish()"}`],{env:{...env,ROTOM_QODER_PROBE_LEDGER:file},encoding:'utf8'})};
}
test('process-wide dispatch counting survives a separate JS realm and serial processes',t=>{
  const {file,run}=fixture(t);assert.equal(run(target,true).status,0);assert.equal(run(target).status,0);assert.equal(readFileSync(file,'utf8'),'2');
});
test('real native fetch from another realm is intercepted before socket connection',t=>{
  const {file}=fixture(t);
  const result=spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',`import vm from 'node:vm';import {channel} from 'node:diagnostics_channel';channel('undici:client:beforeConnect').subscribe(()=>process.exit(87)); await vm.runInNewContext("nativeFetch('http://127.0.0.1:45678/')",{nativeFetch:globalThis.fetch});`],{env:{ROTOM_QODER_PROBE_LEDGER:file},encoding:'utf8'});
  assert.equal(result.status,86);assert.equal(readFileSync(file,'utf8'),'0');
});
test('catalog scope is explicit, exact and uses the same request allowance',t=>{
  const {file,run}=fixture(t);
  const catalog={origin:'https://api2.qoder.sh',path:'/algo/api/v2/model/list?Encode=1',method:'GET'};
  assert.equal(run(catalog).status,86);
  assert.equal(run(catalog,false,{ROTOM_QODER_PROBE_CATALOG:'1'}).status,0);
  assert.equal(run({...catalog,path:'/api/v1/deviceToken/refresh'},false,{ROTOM_QODER_PROBE_CATALOG:'1'}).status,86);
  assert.equal(run(target).status,0);assert.equal(readFileSync(file,'utf8'),'2');
});
test('legacy inference scope is explicit and cannot become a general COSY proxy',t=>{
  const {file,run}=fixture(t);const request={origin:'https://api2.qoder.sh',path:'/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',method:'POST'};
  assert.equal(run(request).status,86);assert.equal(run(request,false,{ROTOM_QODER_PROBE_LEGACY:'1'}).status,0);
  assert.equal(run({...request,path:'/api/v1/deviceToken/refresh'},false,{ROTOM_QODER_PROBE_LEGACY:'1'}).status,86);
  assert.equal(readFileSync(file,'utf8'),'1');
});
test('credit scope permits only the reviewed account snapshot GET',t=>{
 const {file,run}=fixture(t);const req={origin:'https://openapi.qoder.sh',path:'/api/v2/quota/usage',method:'GET'},env={ROTOM_QODER_PROBE_CREDIT:'1'};
 assert.equal(run(req).status,86);assert.equal(run(req,false,env).status,0);
 for(const patch of [{method:'POST'},{path:'/api/v1/deviceToken/refresh'},{path:'/api/v2/quota/usage?org=foreign'},{origin:'https://example.invalid'}])assert.equal(run({...req,...patch},false,env).status,86);
 assert.equal(readFileSync(file,'utf8'),'1');
});
test('UI-only probes can forbid all model dispatch while retaining explicit read scopes',t=>{
 const {file,run}=fixture(t),env={ROTOM_QODER_PROBE_NO_MODELS:'1',ROTOM_QODER_PROBE_LEGACY:'1',ROTOM_QODER_PROBE_CREDIT:'1'};
 assert.equal(run(target,false,env).status,86);
 assert.equal(run({origin:'https://api2.qoder.sh',path:'/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',method:'POST'},false,env).status,86);
 assert.equal(run({origin:'https://openapi.qoder.sh',path:'/api/v2/quota/usage',method:'GET'},false,env).status,0);
 assert.equal(run(target,false,{ROTOM_QODER_PROBE_NO_MODELS:'2'}).status,86);assert.equal(readFileSync(file,'utf8'),'1');
});
test('OAuth requires an isolated private directory and exact auth endpoints',t=>{
  const {file,run}=fixture(t);const dir=join(file,'..','isolated-auth');mkdirSync(dir,{mode:0o700});
  const env={ROTOM_QODER_PROBE_OAUTH:'1',ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR:dir};
  const request={origin:'https://openapi.qoder.sh',path:'/api/v1/deviceToken/refresh',method:'POST'};
  assert.equal(run(request).status,86);assert.equal(run(request,false,{ROTOM_QODER_PROBE_OAUTH:'1'}).status,86);assert.equal(run(request,false,env).status,0);
  const poll={...request,method:'GET',path:'/api/v1/deviceToken/poll?'+new URLSearchParams({nonce:'a'.repeat(36),verifier:'v'.repeat(43),challenge_method:'S256'})};
  assert.equal(run(poll,false,env).status,0);assert.equal(run({...poll,path:poll.path+'&extra=1'},false,env).status,86);
  assert.equal(run({...request,path:'/api/v1/userinfo',method:'GET'},false,env).status,0);
  assert.equal(run({...request,path:'/api/v2/billing/purchase'},false,env).status,86);assert.equal(readFileSync(file,'utf8'),'3');
});
test('exhausted budget terminates before dispatch construction can continue',t=>{
  const {file,run}=fixture(t,30);assert.equal(run(target).status,86);assert.equal(readFileSync(file,'utf8'),'30');
});
test('explicit self-limit validates syntax and preserves cumulative counting',t=>{
  const {file,run}=fixture(t,99);assert.equal(run(target,false,{ROTOM_QODER_PROBE_LIMIT:'100'}).status,0);assert.equal(readFileSync(file,'utf8'),'100');assert.equal(run(target,false,{ROTOM_QODER_PROBE_LIMIT:'100'}).status,86);
  for(const value of ['0','-1','Infinity','10001','1.5','001',''])assert.equal(run(target,false,{ROTOM_QODER_PROBE_LIMIT:value}).status,86);
  assert.equal(readFileSync(file,'utf8'),'100');
});
test('unexpected request target never consumes allowance or continues dispatch',t=>{
  const {file,run}=fixture(t);assert.equal(run({...target,origin:'https://example.invalid'}).status,86);assert.equal(readFileSync(file,'utf8'),'0');
});
