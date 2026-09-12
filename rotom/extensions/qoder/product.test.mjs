import assert from 'node:assert/strict';
import test from 'node:test';
import { MODELS, createQoderProvider } from './provider.mjs';
import { qoderEnabled } from './session-policy.mjs';
import { CHAT_URL, createQoderFetch } from './transport.mjs';

test('bundled provider is enabled by default, supports explicit opt-out, and rejects ambiguous values', () => {
  for (const env of [{}, {ROTOM_QODER:'1'}]) assert.equal(qoderEnabled(env),true);
  assert.equal(qoderEnabled({ROTOM_QODER:'0'}),false);
  for (const value of ['', 'true', 'yes', '2']) assert.throws(() => qoderEnabled({ROTOM_QODER:value}), /invalid_opt_in/);
});
test('reviewed catalog is text-only, reasoning off, with stable existing identity', () => {
  assert.deepEqual(MODELS.map(m=>m.id), ['lite','performance']);
  for (const model of MODELS) {
    assert.equal(model.provider,'qoder-experimental'); assert.equal(model.reasoning,false);
    assert.deepEqual(model.input,['text']); assert.equal(model.maxTokens,4096);
    assert.match(model.name,/experimental; price unknown/);
  }
});
for (const [name, patch] of [
  ['other tier',{model:'efficient'}], ['different reviewed tier',{model:'performance'}],
  ['image',{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid/image'}}]}]}],
  ['thinking',{enable_thinking:true}], ['effort',{reasoning_effort:'high'}],
  ['opaque history',{messages:[{role:'assistant',content:'x',reasoning_item:{secret:'not sent'}}]}],
]) test(`post-hook ${name} rejected before credentials/network`, async () => {
  let reads=0, calls=0;
  const fetch=createQoderFetch({getToken:async()=>{reads++;return 'fixture';},fetchImpl:async()=>{calls++;}});
  await assert.rejects(fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'lite',stream:true,messages:[],...patch})}));
  assert.equal(reads,0);assert.equal(calls,0);
});
test('performance transport keeps selected model and explicitly disables thinking', async () => {
  let body;
  const fetch=createQoderFetch({modelId:'performance',getToken:async()=> 'fixture',fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return new Response('',{status:403});}});
  await assert.rejects(fetch(CHAT_URL,{method:'POST',body:JSON.stringify({model:'performance',stream:true,messages:[]})}),/http_403/);
  assert.equal(body.model,'performance');assert.equal(body.enable_thinking,false);assert.equal(body.reasoning_effort,'none');
});
test('registration performs no credential access, network, or model selection', async () => {
  let reads=0,network=0;
  const provider=await createQoderProvider({piAI:{createProvider:x=>x},getToken:async()=>{reads++;},fetchImpl:async()=>{network++;}});
  assert.equal(provider.models.length,17);assert.deepEqual(provider.filterModels(provider.models),MODELS);assert.equal(reads,0);assert.equal(network,0);
});
