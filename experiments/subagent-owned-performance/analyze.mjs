import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export function summarize(rows) {
 assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.id)).size,6);
 for(const r of rows){
  assert.equal(r.dry,false);assert.equal(r.state,'closed');assert.equal(r.valid,true);
  assert.equal(r.model,'cc-switch/claude-opus-5');assert.equal(r.thinking,'off');assert.equal(r.toolCount,1);assert.equal(r.assistantMessages,2);
  assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].success,true);assert.equal(r.attempts[0].model,'cc-switch/claude-opus-5:off');
  assert.equal(r.closure,'observed');if(r.owned)assert.equal(r.ownedClosure,'observed');
 }
 const keys=['dispatchMs','startupToAgentMs','agentMs','toolMs','postAgentCloseMs','endToEndMs'];
 const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
 const describe=xs=>{const a=[...xs].sort((a,b)=>a-b);return {mean:mean(a),median:a[1],min:a[0],max:a[2]};};
 const metrics={};
 for(const key of keys){
  const a=rows.filter(r=>!r.owned).map(r=>r.metrics[key]),b=rows.filter(r=>r.owned).map(r=>r.metrics[key]);
  assert.equal(a.length,3);assert.equal(b.length,3);assert.ok([...a,...b].every(x=>Number.isFinite(x)&&x>=0));
  metrics[key]={off:describe(a),on:describe(b),meanDeltaMs:mean(b)-mean(a)};
 }
 const pairs=[1,2,3].map(i=>{const a=rows.find(r=>r.id===`pair${i}-A`),b=rows.find(r=>r.id===`pair${i}-B`);assert.ok(a&&!a.owned&&b&&b.owned);return {pair:i,offMs:a.metrics.endToEndMs,onMs:b.metrics.endToEndMs,deltaMs:b.metrics.endToEndMs-a.metrics.endToEndMs};});
 const usage={};for(const key of ['input','output','cacheRead','cacheWrite','totalTokens','reportedCost']){
  const values=rows.flatMap(r=>r.modelEvents.map(e=>e.usage[key]));assert.equal(values.length,12);assert.ok(values.every(x=>Number.isFinite(x)&&x>=0));usage[key]=values.reduce((a,b)=>a+b,0);
 }
 return {functionalDecision:'PASS',performanceDecision:'INCONCLUSIVE',reason:'Three pairs do not prove performance equivalence or isolate network/cache effects.',pairedDirection:pairs.every(p=>p.deltaMs>0)?'all-slower':pairs.every(p=>p.deltaMs<0)?'all-faster':'mixed',metrics,pairs,usage,billableCost:'unknown',nativeTasks:6,assistantResponses:12,controllerModelCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(JSON.stringify(summarize(rows),null,2));
}
