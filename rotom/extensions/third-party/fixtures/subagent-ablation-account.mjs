// Metadata-only accounting for the explicitly owned synthetic experiment tree.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=fs.realpathSync(process.argv[2]);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));if(manifest.scope!=='subagent candidates only')throw Error('not an experiment root');
const totals={messages:0,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,catalogueUsd:0,missingUsage:0};
const seen=new Set();const trials=[];
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]);}
for(const name of fs.readdirSync(path.join(root,'trials'))){
 const dir=path.join(root,'trials',name);if(!fs.statSync(dir).isDirectory())continue;
 const row={trial:name,messages:0,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,catalogueUsd:0,missingUsage:0};
 for(const file of files(dir)){
  const stat=fs.statSync(file);if(stat.size>16*1024*1024)throw Error('session exceeds accounting bound');
  let sessionId;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
   if(!line)continue;let e;try{e=JSON.parse(line);}catch{throw Error('incomplete session accounting');}
   if(e.type==='session'){sessionId=e.id;continue;}
   if(e.type!=='message'||e.message?.role!=='assistant'||!sessionId)continue;
   const key=sessionId+'/'+(e.id??createHash('sha256').update(line).digest('hex'));if(seen.has(key))continue;seen.add(key);
   const u=e.message.usage;row.messages++;
   if(!u||!Number.isFinite(u.cost?.total)||(['error','aborted'].includes(e.message.stopReason)&&!(u.totalTokens>0))){row.missingUsage++;continue;}
   for(const k of ['input','output','cacheRead','cacheWrite'])row[k]+=u[k]??0;
   row.totalTokens+=u.totalTokens??((u.input??0)+(u.output??0)+(u.cacheRead??0)+(u.cacheWrite??0));row.catalogueUsd+=u.cost.total;
  }
 }
 for(const k of Object.keys(totals))totals[k]+=row[k];trials.push(row);
}
const coordination=JSON.parse(fs.readFileSync(path.join(root,'coordination-usage.json'),'utf8')).reduce((n,r)=>n+r.usage.cost,0);
const result={schemaVersion:1,scope:'native experimental sessions only; no actual billing',totals,coordinationCatalogueUsd:coordination,combinedReportedUsd:coordination+totals.catalogueUsd,trials};
fs.writeFileSync(path.join(root,'usage.json'),JSON.stringify(result,null,2),{mode:0o600});
const budget=JSON.parse(fs.readFileSync(path.join(root,'budget.json'),'utf8'));budget.reportedUsd=result.combinedReportedUsd;budget.missingUsage=totals.missingUsage;fs.writeFileSync(path.join(root,'budget.json'),JSON.stringify(budget,null,2),{mode:0o600});
console.log(JSON.stringify({messages:totals.messages,catalogueUsd:totals.catalogueUsd,combinedReportedUsd:result.combinedReportedUsd,missingUsage:totals.missingUsage}));
