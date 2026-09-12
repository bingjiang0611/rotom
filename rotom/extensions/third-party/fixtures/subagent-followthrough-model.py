#!/usr/bin/env python3
"""Fixed v4 baseline/candidate A/B; no replay, no budget extension, no credentials copied."""
import pathlib,json,subprocess,os,hashlib,signal,time,sys
root=pathlib.Path(sys.argv[1]).resolve(strict=True);phase=sys.argv[2];assert phase in ['canary','remaining']
resume=len(sys.argv)==4 and sys.argv[3]=='resume';assert len(sys.argv)==3 or resume
h=root/'model-harness';lock=json.loads((root/'model-harness-lock.json').read_text())
for name,digest in lock.items():assert hashlib.sha256((h/name).read_bytes()).hexdigest()==digest,'harness drift'
assert (root/'local-gates-reviewed.json').is_file(),'coordinator must review local gates first'
ids=['direct-range','direct-totals','delegate-range','delegate-dedupe','delegate-csv','sequential-fix-review','parallel-files','attention-completion']
plan=[{'task':task,'repeat':repeat,'variant':v} for repeat in range(2) for i,task in enumerate(ids) for v in (['baseline','candidate'] if (i+repeat)%2==0 else ['candidate','baseline'])]
planfile=root/'v4-paired-plan.json'
if planfile.exists():assert json.loads(planfile.read_text())==plan
else:planfile.write_text(json.dumps(plan,indent=2))
canary=lambda c:c['repeat']==0 and c['task'] in ['direct-range','delegate-range']
if phase=='remaining':
 previous=json.loads((root/'v4-canary-results.json').read_text());assert len(previous)==4 and all(r['conservativeSuccess'] for r in previous),'canary not accepted'
selection=[c for c in plan if canary(c)==(phase=='canary')];checkpoint=root/f'v4-{phase}-results.json'
assert resume or not checkpoint.exists(),'no implicit replay/resume'
rows=json.loads(checkpoint.read_text()) if resume and checkpoint.exists() else []
for c in selection:
 name=f"v4-{c['task']}-{c['repeat']}-{c['variant']}";dest=root/'trials'/name
 previous=next((r for r in rows if all(r[k]==c[k] for k in c)),None)
 if previous:
  observed=json.loads((dest/'result.json').read_text());assert observed['directSpawnsClosed'] and not observed['cleanupUnknown']
  assert previous['conservativeSuccess']==observed['conservativeSuccess'];continue
 budget=json.loads((root/'budget.json').read_text())
 if time.time()*1000+125000>=budget['deadlineAt'] or budget['reportedUsd']+budget.get('missingUsage',0)>=18:raise SystemExit('authorization admission stopped')
 env=dict(os.environ);env['NODE_USE_ENV_PROXY']='1';env.pop('NODE_OPTIONS',None)
 recovered=False
 if dest.exists():
  assert resume,'existing coordinate is not replay authorization'
  receipt=dest/'driver-retirement.json';assert receipt.is_file(),'uncheckpointed trial lacks retirement evidence'
  observed=json.loads((dest/'result.json').read_text());proof=json.loads(receipt.read_text());assert proof['exit']==0 and observed['directSpawnsClosed'] and not observed['cleanupUnknown']
  assert observed['variant']==c['variant'] and observed['taskId']==c['task'] and observed['repeat']==c['repeat'];recovered=True
 cmd=['node','--experimental-strip-types',str(h/'subagent-ablation-trial.mjs'),str(root),c['variant'],c['task'],str(c['repeat']),'live','v4']
 if not recovered:
  with (root/f'{name}.driver.log').open('xb') as stream:
   os.chmod(stream.name,0o600);p=subprocess.Popen(cmd,env=env,stdout=stream,stderr=stream,start_new_session=True)
   (root/'active-trial.json').write_text(json.dumps({**c,'pid':p.pid,'startedAt':time.time(),'argvDigest':hashlib.sha256(json.dumps(cmd).encode()).hexdigest()}))
   try:p.wait(timeout=125)
   except subprocess.TimeoutExpired:
    if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=8)
    except subprocess.TimeoutExpired:
     if p.poll() is None:os.killpg(p.pid,signal.SIGKILL)
     p.wait(timeout=5)
    (root/f'{name}.unknown.json').write_text(json.dumps({'cleanupUnknown':True,'driverTimeout':True}))
    raise SystemExit('unknown closure; no further model admission')
  if p.returncode or not (dest/'result.json').is_file():raise SystemExit('trial infrastructure failure')
  (dest/'driver-retirement.json').write_text(json.dumps({'exit':p.returncode,'observedAt':time.time()}));os.chmod(dest/'driver-retirement.json',0o600)
 result=json.loads((dest/'result.json').read_text());subprocess.run(['node',str(h/'subagent-ablation-account.mjs'),str(root)],env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME']},check=True,timeout=30,stdout=subprocess.DEVNULL)
 row={**c,**{k:result.get(k) for k in ['correct','finished','conservativeSuccess','thinkingAudit','attentionCompletionObserved','parentTurns','toolErrors','elapsedMs','cleanupUnknown','directSpawnsClosed','providerErrors']}}
 rows.append(row);checkpoint.write_text(json.dumps(rows,indent=2));os.chmod(checkpoint,0o600);print(json.dumps(row),flush=True)
 if result['cleanupUnknown'] or not result.get('directSpawnsClosed'):raise SystemExit('closure unconfirmed')
 if not result.get('thinkingAudit',{}).get('pass'):raise SystemExit('configuration unconfirmed; stop expansion')
 if result['providerErrors'] and not (result['timedOut'] or result['turnBudgetExceeded']):raise SystemExit('provider infrastructure failure')
 # A known-closed task/budget failure remains a failure, not replay authorization.
print('completed '+phase,flush=True)
