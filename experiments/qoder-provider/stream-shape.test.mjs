import test from 'node:test';
import assert from 'node:assert/strict';
import {streamShape,observeStream} from './stream-shape.mjs';
const frame=tools=>'data: '+JSON.stringify({choices:[{delta:{tool_calls:tools},finish_reason:null}]})+'\n\n';
const tool=(id,index)=>({id,index,type:'function',function:{name:'PRIVATE_TOOL',arguments:'PRIVATE_ARGUMENTS'}});
test('tool diagnostics distinguish null, changed and missing identities without retaining values',()=>{
 const wire=frame([tool('PRIVATE_ID_1',0)])+frame([tool(null,0)])+frame([tool('PRIVATE_ID_2',0)])+frame([tool('PRIVATE_ID_3',undefined)]);
 const s=streamShape(wire);assert(s.originalCollectorRejects);assert.equal(s.tools[1].idType,'null');assert.equal(s.tools[2].relation,'changed');assert.equal(s.tools[3].indexType,'missing');assert.doesNotMatch(JSON.stringify(s),/PRIVATE/);
});
test('split field diagnostics retain only literal prefix structure, not payload values',()=>{
 const s=streamShape('da\nta: '+JSON.stringify({model:'PRIVATE_MODEL',choices:[{delta:{content:'PRIVATE_TEXT'},finish_reason:null}]})+'\n\n');
 assert.equal(s.unprefixedFrames[0].first.literal,'da');assert.equal(s.unprefixedFrames[0].splitPrefixParts,2);assert.doesNotMatch(JSON.stringify(s),/PRIVATE/);
 const error=streamShape(JSON.stringify({error:{message:'PRIVATE_ERROR'},authorization:'PRIVATE_TOKEN'})+'\n\n');assert.doesNotMatch(JSON.stringify(error),/PRIVATE/);
});
test('opaque diagnostics never expose ciphertext, even when it matches a public enum',()=>{
 const s=streamShape('data: '+JSON.stringify({choices:[{delta:{reasoning_item:{id:'PRIVATE_ID',encrypted_content:'stop',target_hash:'h'.repeat(64),PRIVATE_FIELD:'PRIVATE_VALUE'}},finish_reason:null}]})+'\n\n');
 assert.equal(s.opaque[0].item.fieldCount,4);assert.deepEqual(s.opaque[0].item.fields.encrypted_content,{type:'string',bytes:4});assert.doesNotMatch(JSON.stringify(s),/PRIVATE|enum|stop/);
});
test('stream inspection is bounded and leaves the original response available',async()=>{
 const response=new Response(frame([tool('fixture',0)]));assert((await observeStream(response)).complete);assert.match(await response.text(),/PRIVATE_TOOL/);
 const large=new Response('x'.repeat(1024*1024+1));assert.deepEqual(await observeStream(large),{complete:false,reason:'oversized'});assert.equal((await large.text()).length,1024*1024+1);
});
