#!/usr/bin/env python3
"""Describe sealed paired results; unknown retirement never becomes an ordinary failure."""
import collections,hashlib,json,pathlib,statistics,sys
root=pathlib.Path(sys.argv[1]).resolve(strict=True)
load=lambda p:json.loads((root/p).read_text())
budget=load('budget.json');assert budget['status'].startswith('model-work-stopped') or budget['status']=='model-work-completed'
usage=load('usage.json');cost={x['trial']:x for x in usage['trials']}
rows=load('v4-canary-results.json')+load('v4-remaining-results.json');groups=collections.defaultdict(dict)
for c in rows:
 key=(c['task'],c['repeat']);assert c['variant'] not in groups[key];groups[key][c['variant']]=c
assert all(set(g)=={'baseline','candidate'} for g in groups.values()),'incomplete checkpoint pair must be classified explicitly'
expected={'direct-range':0,'direct-totals':0,'delegate-range':1,'delegate-dedupe':1,'delegate-csv':1,'sequential-fix-review':2,'parallel-files':2,'attention-completion':1}
records=[]
for key,g in groups.items():
 for variant,c in g.items():
  name=f'v4-{key[0]}-{key[1]}-{variant}';r=load('trials/'+name+'/result.json');u=cost[name]
  assert r['directSpawnsClosed'] and not r['cleanupUnknown'] and r['thinkingAudit']['pass']
  assert c['conservativeSuccess']==r['conservativeSuccess']
  n=expected[key[0]];runs=r['runs'];core=bool(r['correct'] and r['finished'] and r['thinkingAudit']['childSessions']==n and (not runs if n==0 else runs and all(x['state']=='complete' for x in runs) and sum(x['steps'] for x in runs)==n and sum(x['completedSteps'] for x in runs)==n))
  records.append({**c,'structuralSensitivity':core,'observedTokens':u['totalTokens'],'catalogueUsd':u['catalogueUsd'],'missingUsage':u['missingUsage'],'assistantRecords':u['messages'],'parentTokens':r['parentStats']['tokens']['total'],'retirementMs':r['retirementMs'],'timedOut':r['timedOut'],'turnBudgetExceeded':r['turnBudgetExceeded'],'lifecycleErrors':r['lifecycleErrors']})
metrics={}
for variant in ['baseline','candidate']:
 rr=[r for r in records if r['variant']==variant]
 metrics[variant]={'trials':len(rr),**{k:sum(r[k] for r in rr) for k in ['correct','finished','conservativeSuccess','structuralSensitivity','parentTurns','toolErrors','providerErrors','observedTokens','parentTokens','catalogueUsd','missingUsage','assistantRecords','timedOut','turnBudgetExceeded']},'lifecycleErrors':sum(r['lifecycleErrors'] for r in rr),'meanTaskSeconds':statistics.mean(r['elapsedMs'] for r in rr)/1000,'medianTaskSeconds':statistics.median(r['elapsedMs'] for r in rr)/1000,'meanRetirementMs':statistics.mean(r['retirementMs'] for r in rr),'attentionAcceptance':sum(r['attentionCompletionObserved'] for r in rr if r['task']=='attention-completion'),'attentionTrials':sum(r['task']=='attention-completion' for r in rr)}
paired=collections.defaultdict(dict)
for r in records:paired[(r['task'],r['repeat'])][r['variant']]=r
wins=losses=0;shared=[]
for p in paired.values():
 b,c=p['baseline'],p['candidate'];wins+=c['conservativeSuccess'] and not b['conservativeSuccess'];losses+=b['conservativeSuccess'] and not c['conservativeSuccess']
 if b['conservativeSuccess'] and c['conservativeSuccess'] and not b['missingUsage'] and not c['missingUsage']:shared.append({'tokenDifference':c['observedTokens']-b['observedTokens'],'secondsDifference':(c['elapsedMs']-b['elapsedMs'])/1000,'catalogueDifference':c['catalogueUsd']-b['catalogueUsd']})
unknown=[]
for p in sorted(root.glob('v4-*.unknown.json')):
 name=p.name.removesuffix('.unknown.json');d=load('trials/'+name+'/result.json') if (root/'trials'/name/'result.json').is_file() else {};u=cost.get(name,{})
 unknown.append({'trial':name,'classification':'UNKNOWN retirement; not an effective paired sample','correctSnapshot':d.get('correct'),'finishedSnapshot':d.get('finished'),'directSpawnsClosed':d.get('directSpawnsClosed'),'cleanupUnknown':True,'catalogueUsd':u.get('catalogueUsd'),'missingUsage':u.get('missingUsage'),'replayed':False})
planned={f"v4-{c['task']}-{c['repeat']}-{c['variant']}" for c in load('v4-paired-plan.json')}
formal={k:sum(u[k] for name,u in cost.items() if name in planned) for k in ['messages','input','output','cacheRead','cacheWrite','totalTokens','catalogueUsd','missingUsage']}
summary={'schemaVersion':1,'scope':'synthetic autonomous parent; public SDK/explicit tool subset, not interactive UI or general agent quality','metrics':metrics,'effectivePairs':len(paired),'candidatePairedWins':wins,'candidatePairedLosses':losses,'bothSuccessCompleteUsage':{'pairs':len(shared),**{k:statistics.mean(r[k] for r in shared) if shared else None for k in ['tokenDifference','secondsDifference','catalogueDifference']}},'unknownAttempts':unknown,'observedAllAttemptUsage':formal,'localExperimentUsageIncludingDry':usage['totals'],'actualBilling':'UNKNOWN','verdict':'INCONCLUSIVE','sensitivity':'structuralSensitivity is a post-hoc path-independent check, not a replacement for the predeclared attention-wait criterion','records':records}
(root/'paired-summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k not in ['records','observedAllAttemptUsage']},indent=2))
