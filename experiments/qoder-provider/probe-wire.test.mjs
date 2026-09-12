import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {probeWire,decodeProbeBody} from './probe-wire.mjs';
import {gridImage} from './vision-probe.mjs';
import {LEGACY_URL,LEGACY_PATH} from '../../rotom/extensions/qoder/legacy.mjs';
import {CHAT_URL} from '../../rotom/extensions/qoder/transport.mjs';
const credential={accessToken:'fixture',uid:'fixture-user',org:'',machineId:'synthetic-machine-0123456789'},entry={key:'performance',display_name:'Performance',source:'system',enable:true,format:'openai',is_vl:true,is_reasoning:false,max_input_tokens:1000000},base={id:'performance',entry,credential,messages:[{role:'user',content:'Synthetic text 中文'}]};
test('research routing is explicit and cannot silently fall back',()=>{
 const direct=probeWire(base);assert.equal(direct.url,CHAT_URL);assert.equal(direct.route,'direct');
 const legacy=probeWire({...base,route:'legacy'});assert.equal(legacy.url,LEGACY_URL);assert.equal(legacy.headers['X-Model-Key'],'performance');assert.equal(decodeProbeBody(legacy.body).model_config.key,'performance');
});
test('legacy signature covers exact encoded body, length and fixed path',()=>{
 const r=probeWire({...base,route:'legacy'}),md5=s=>createHash('md5').update(s).digest('hex');
 assert.equal(r.headers['Cosy-Bodyhash'],md5(r.body));assert.equal(r.headers['Cosy-Bodylength'],String(Buffer.byteLength(r.body)));assert.equal(r.headers['Cosy-Sigpath'],LEGACY_PATH);
 const [payload,sig]=r.headers.Authorization.slice('Bearer COSY.'.length).split('.');assert.equal(sig,md5(`${payload}\n${r.headers['Cosy-Key']}\n${r.headers['Cosy-Date']}\n${r.body}\n${LEGACY_PATH}`));
});
test('selected context is a wire selector, separate from local input limits; omitted default is not 32K',()=>{
 const none=decodeProbeBody(probeWire({...base,route:'legacy',effort:'default',contextLength:null}).body);assert(!('reasoning_effort' in none.parameters));assert(!('enable_thinking' in none.parameters));assert(!('context_length' in none.parameters));assert.equal(none.model_config.max_input_tokens,1000000);
 const selected=decodeProbeBody(probeWire({...base,route:'legacy',effort:'none',contextLength:272000}).body);assert.equal(selected.parameters.context_length,272000);assert.equal(selected.parameters.enable_thinking,false);assert.equal(selected.model_config.is_reasoning,false);
});
test('direct HTTP context selector is a numeric root field, not gRPC string metadata',()=>{
 const selected=JSON.parse(probeWire({...base,contextLength:400000}).body);assert.equal(selected.context_length,400000);assert(!('context_length' in selected.metadata.context));
 const omitted=JSON.parse(probeWire({...base,contextLength:null}).body);assert(!('context_length' in omitted));
});
test('inline image arrays survive both message fields; no chat_context image URL is invented',()=>{
 const content=[{type:'text',text:'synthetic'},{type:'image_url',image_url:{url:'data:image/png;base64,ZmFrZQ=='}}];
 const r=decodeProbeBody(probeWire({...base,route:'legacy',messages:[{role:'system',content:'system'},{role:'user',content}]}).body);assert.deepEqual(r.messages[0].content,content);assert.deepEqual(r.messages[0].contents,content);assert.equal(r.system,'system');assert.equal(r.chat_context.text,'');assert.equal(r.chat_context.imageUrls,null);
});
test('native tool-only assistant null becomes an empty legacy string without losing calls',()=>{
 const call={id:'fixture-call',type:'function',function:{name:'fixture_tool',arguments:'{}'}},r=decodeProbeBody(probeWire({...base,route:'legacy',messages:[{role:'assistant',content:null,tool_calls:[call]}]}).body);assert.equal(r.messages[0].content,'');assert.deepEqual(r.messages[0].tool_calls,[call]);
});
test('unknown keys, BYOK, disabled rows, modes, routes and oversized limits reject locally',()=>{
 for(const override of [{id:'guessed-model'},{entry:{...entry,key:'auto'}},{entry:{...entry,source:'user'}},{entry:{...entry,enable:false}},{route:'fallback'},{effort:'guessed'},{contextLength:1000001},{maxTokens:4097}])assert.throws(()=>probeWire({...base,...override}));
 assert.throws(()=>decodeProbeBody('invalid encoded bytes'));
});
test('synthetic PNG fixture has the expected raster, colors and coordinate convention',()=>{
 const {png,expected}=gridImage(0,24);assert.deepEqual(expected,{red:[1,1],blue:[5,5]});assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 let i=8;const data=[];while(i<png.length){const n=png.readUInt32BE(i),type=png.subarray(i+4,i+8).toString();if(type==='IHDR'){assert.equal(png.readUInt32BE(i+8),500);assert.equal(png.readUInt32BE(i+12),500);}if(type==='IDAT')data.push(png.subarray(i+8,i+8+n));i+=12+n;}
 const pixels=inflateSync(Buffer.concat(data)),pixel=(x,y)=>[...pixels.subarray(y*1501+1+x*3,y*1501+1+x*3+3)];assert.deepEqual(pixel(50,50),[230,20,40]);assert.deepEqual(pixel(450,450),[30,70,230]);assert.deepEqual(pixel(250,250),[245,245,245]);assert.deepEqual(gridImage(24,24).expected,{red:[5,5],blue:[1,1]});
});
