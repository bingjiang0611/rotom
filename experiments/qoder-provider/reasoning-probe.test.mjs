import test from 'node:test';
import assert from 'node:assert/strict';
import {shape,parseProbeFrames,summarizeFrames} from './reasoning-probe.mjs';
test('diagnostics preserve structure but never opaque values or service prose',()=>{
  const d={choices:[{delta:{reasoning_content:'PRIVATE THOUGHT',reasoning_item:{type:'reasoning',id:'PRIVATE_ID',encrypted_content:'PRIVATE_BLOB',summary:[{type:'summary_text',text:'PRIVATE_SUMMARY'}]}},finish_reason:'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7,private:'PRIVATE_USAGE'}};
  const text=`data: ${JSON.stringify(d)}\n\nevent: error\ndata: ${JSON.stringify({error:{message:'PRIVATE thinking disabled',code:'PRIVATE_CODE'}})}\n\ndata: [DONE]\n\n`;
  const result=summarizeFrames(parseProbeFrames(text));assert.equal(result.done,true);assert.equal(result.opaque[0].shape.type.enum,'reasoning');assert.deepEqual(result.errors[0].categories,['thinking']);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  assert.deepEqual(shape('PRIVATE'),{type:'string',bytes:7});
  assert.doesNotMatch(JSON.stringify(shape({PRIVATE_KEY:'PRIVATE_VALUE'})),/PRIVATE/);
});
test('raw same-frame wrapping and body-less error events are bounded and readable',()=>{
  const raw=JSON.stringify({choices:[{delta:{content:'synthetic'},finish_reason:'stop'}]});
  const frames=parseProbeFrames(`data: ${raw.slice(0,35)}\n${raw.slice(35)}\n\nevent: error\n\n`);
  assert.equal(summarizeFrames(frames).textChars,9);assert.equal(summarizeFrames(frames).errors.length,1);
});
