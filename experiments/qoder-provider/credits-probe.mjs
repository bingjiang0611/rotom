// Read-only account snapshot. Missing fields stay unknown; no inferred request debit.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readProbeCredential} from './probe-credential.mjs';
assert.deepEqual(process.argv.slice(2),['--live']);
assert(process.env.ROTOM_QODER_PROBE_CREDIT==='1'&&process.execArgv.some(a=>a.endsWith('live-budget.mjs')));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,before=Number(readFileSync(ledger,'utf8'));
const digest=()=>createHash('sha256').update(readFileSync(process.env.ROTOM_QODER_PROBE_AUTH_FILE)).digest('hex'),original=digest();
const result={pass:false};
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
try{
 const c=await readProbeCredential();
 const r=await fetch('https://openapi.qoder.sh/api/v2/quota/usage',{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json',Authorization:`Bearer ${c.accessToken}`}});
 result.httpStatus=r.status;let bytes=0;const chunks=[];for await(const chunk of r.body){bytes+=chunk.length;assert(bytes<=65536);chunks.push(chunk);}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));result.json=true;}catch{result.json=false;}
 assert(r.ok&&data&&typeof data==='object'&&!Array.isArray(data));
 result.accountMatched=String(data.user_id??data.userId)===String(c.uid);assert(result.accountMatched);
 result.pools={};
 for(const [label,snake,camel] of [['plan','user_quota','userQuota'],['addon','add_on_quota','addOnQuota'],['shared','org_resource_package','orgResourcePackage']]){
  const pool=data[snake]??data[camel];if(pool==null){result.pools[label]=null;continue;}
  result.pools[label]={total:number(pool.total??pool.cap),used:number(pool.used),remaining:number(pool.remaining),unit:typeof pool.unit==='string'&&/^credits?$/i.test(pool.unit)?'credits':'unknown'};
 }
 result.pass=true;
}catch{result.errorCode='quota_snapshot_unproven';process.exitCode=1;}
result.requests=Number(readFileSync(ledger,'utf8'))-before;result.ledgerTotal=Number(readFileSync(ledger,'utf8'));result.credentialsUnchanged=original===digest();
console.log(JSON.stringify(result,null,2));
