#!/usr/bin/env python3
"""Metadata-only paired audit; scheduled steps are not proof of successful children."""
import hashlib,json,statistics,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve();plan=json.loads((root/'v2-paired-plan.json').read_text());usage=json.loads((root/'usage.json').read_text());u={r['trial']:r for r in usage['trials']}
profile=Path(__file__).resolve().with_name('subagent-ablation-profile.mjs')
legacy=root/'harness-v2'/profile.name
if not legacy.exists():legacy=profile
assert hashlib.sha256(legacy.read_bytes()).hexdigest()==plan['profileSha256']
correction=json.loads((root/'v3-paired-plan.json').read_text()) if (root/'v3-paired-plan.json').exists() else None
if correction:assert hashlib.sha256(profile.read_bytes()).hexdigest()==correction['profileSha256']
profiles=json.loads(subprocess.run(['node','--input-type=module','-e',f'import {{tasks}} from {json.dumps(profile.as_uri())};console.log(JSON.stringify(tasks.map(t=>({{id:t.id,expectedChildren:t.delegates}}))));'],check=True,capture_output=True,timeout=5).stdout)
rows=[];missing=[];models={};thinking={v:{} for v in ['baseline','full','slim']}
for c in plan['plan']:
 revision='v3' if correction and c['task']=='sequential-fix-review' else 'v2'
 name=f"{revision}-{c['task']}-{c['repeat']}-{c['variant']}";trial=root/'trials'/name;file=trial/'result.json'
 if not file.exists():missing.append(c);continue
 r=json.loads(file.read_text());statuses=[json.loads(p.read_text()) for p in (trial/'runtime').glob('async-subagent-runs/*/status.json')]
 steps=[s for w in statuses for s in w.get('steps',[])];completed=sum(s.get('status') in ['complete','completed'] for s in steps)
 expected=next(x['expectedChildren'] for x in profiles if x['id']==c['task'])
 categories=[]
 for s in steps+statuses:
  error=str(s.get('error','')).lower()
  if error:categories.append('unknown_agent' if 'unknown agent' in error else 'timeout' if 'timeout' in error or 'timed out' in error else 'budget' if 'budget' in error else 'other')
 scheduled=len(steps);workflowComplete=all(w.get('state') in ['complete','completed'] for w in statuses)
 safeExit=not r['cleanupUnknown'] and r['directSpawnsClosed']
 kinds={};armCalls=0;receipts=set();duplicateReceipts=0
 for sessionFile in trial.rglob('*.jsonl'):
  if sessionFile.is_symlink():continue
  assert sessionFile.stat().st_size<=16*1024*1024
  for line in sessionFile.read_text().splitlines():
   e=json.loads(line)
   if e.get('type')=='thinking_level_change':
    levels=thinking[c['variant']];level=str(e.get('thinkingLevel'));levels[level]=levels.get(level,0)+1
   if e.get('type')=='message' and e.get('message',{}).get('role')=='assistant':
    m=e['message'];model=f"{m.get('provider')}/{m.get('model')}";models[model]=models.get(model,0)+1
   if sessionFile.parent!=trial/'sessions':continue
   if e.get('type')=='custom_message':
    kind=e.get('customType','');assert len(kind)<=128;kinds[kind]=kinds.get(kind,0)+1
    d=e.get('details') or {}
    if kind=='subagent-wait-subscription' and d.get('token') and d.get('runId'):
     key=tuple(d.get(k) for k in ['token','runId','attemptId','outcome']);duplicateReceipts+=key in receipts;receipts.add(key)
   if e.get('type')=='message' and e.get('message',{}).get('role')=='assistant':
    armCalls+=sum(x.get('type')=='toolCall' and x.get('name')=='subagent_wait' and x.get('arguments',{}).get('nonBlocking') is True for x in e['message'].get('content',[]) if isinstance(x,dict))
 row={**c,'revision':revision,'fileCorrect':r['correct'],'finished':r['finished'],'scheduledSteps':scheduled,'expectedChildren':expected,'completedChildren':completed,'workflowComplete':workflowComplete,'safeExit':safeExit,'strictSuccess':r['correct'] and r['finished'] and scheduled==expected and completed==expected and workflowComplete and safeExit,'parentTurns':r['parentTurns'],'parentTokens':r['parentStats']['tokens']['total'],'totalTokens':u[name]['totalTokens'],'catalogueUsd':u[name]['catalogueUsd'],'missingUsage':u[name]['missingUsage'],'elapsedMs':r['elapsedMs'],'retirementMs':r['retirementMs'],'toolCalls':r['toolCalls'],'toolErrors':r['toolErrors'],'lifecycleErrors':r['lifecycleErrors'],'budgetFailure':r['timedOut'] or r['turnBudgetExceeded'],'providerErrors':r['providerErrors'],'attentionNotices':r['attentionNotices'],'completionNotices':r['completionNotices'],'stepErrorCategories':sorted(set(categories)),'parentCustomTypes':kinds,'nonBlockingWaitCalls':armCalls,'duplicateExactWaitReceipts':duplicateReceipts,'resultSha256':hashlib.sha256(file.read_bytes()).hexdigest()};rows.append(row)
summary={}
for variant in ['baseline','full','slim']:
 subset=[r for r in rows if r['variant']==variant]
 summary[variant]={'trials':len(subset),**{k:sum(r[k] for r in subset) for k in ['fileCorrect','finished','strictSuccess','toolErrors','lifecycleErrors','budgetFailure','parentTurns','parentTokens','totalTokens','catalogueUsd','missingUsage','attentionNotices','completionNotices']},'meanElapsedMs':statistics.mean(r['elapsedMs'] for r in subset),'medianElapsedMs':statistics.median(r['elapsedMs'] for r in subset),'meanRetirementMs':statistics.mean(r['retirementMs'] for r in subset)}
paired={}
for candidate,base in [('full','baseline'),('slim','baseline'),('slim','full')]:
 pairs=[(r,next((b for b in rows if b['variant']==base and b['task']==r['task'] and b['repeat']==r['repeat']),None)) for r in rows if r['variant']==candidate];pairs=[(a,b) for a,b in pairs if b]
 paired[candidate+'-vs-'+base]={'pairs':len(pairs),'strictWins':sum(a['strictSuccess'] and not b['strictSuccess'] for a,b in pairs),'strictLosses':sum(b['strictSuccess'] and not a['strictSuccess'] for a,b in pairs),'bothStrictSuccess':sum(a['strictSuccess'] and b['strictSuccess'] for a,b in pairs),'meanLatencyDifferenceMs':statistics.mean(a['elapsedMs']-b['elapsedMs'] for a,b in pairs),'meanParentTokenDifference':statistics.mean(a['parentTokens']-b['parentTokens'] for a,b in pairs),'meanTotalTokenDifference':statistics.mean(a['totalTokens']-b['totalTokens'] for a,b in pairs)}
for key,data in paired.items():
 candidate,base=key.split('-vs-');matches=[(a,b) for a in rows for b in rows if a['variant']==candidate and b['variant']==base and a['task']==b['task'] and a['repeat']==b['repeat'] and a['strictSuccess'] and b['strictSuccess']]
 data['bothSuccessMeanLatencyDifferenceMs']=statistics.mean(a['elapsedMs']-b['elapsedMs'] for a,b in matches) if matches else None
 data['bothSuccessMeanTokenDifference']=statistics.mean(a['totalTokens']-b['totalTokens'] for a,b in matches) if matches else None
out={'schemaVersion':1,'scope':'Fixed SDK RPC synthetic trials; not full launcher or UI acceptance','modelEvidence':{'assistantModels':models,'thinkingChangesByVariant':thinking,'interpretation':'Observed native session metadata, not proof that natural-language thinking instructions configured children.'},'excludedLegacySequentialTrials':6 if correction else 0,'profileHashes':{'v2':plan['profileSha256'],'v3':correction['profileSha256'] if correction else None},'complete':not missing,'missing':missing,'judgeNote':'file verifier is primary task output; conservative audit additionally requires parent finished, exact scheduled/completed child count, all workflows complete and observed direct spawn closure. Not an exactly-once/whole-graph proof. Original driver admittedChildren field counted scheduled steps.','summary':summary,'paired':paired,'rows':rows}
(root/'paired-summary.json').write_text(json.dumps(out,indent=2));print(json.dumps({'complete':not missing,'summary':summary,'paired':paired},indent=2))
