#!/usr/bin/env python3
"""Serial, bounded synthetic model trials. Stops on unknown cleanup/driver timeout."""
import hashlib,json,os,shutil,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]).resolve(); phase=sys.argv[2]
assert phase in ('canary','remaining','correction')
revision='v3' if phase=='correction' else 'v2'
here=Path(__file__).resolve().parent
profile=here/'subagent-ablation-profile.mjs'; trial=here/'subagent-ablation-trial.mjs'; account=here/'subagent-ablation-account.mjs'
for p in (profile,trial,account):assert p.is_file()
metadata=json.loads(subprocess.run(['node','--input-type=module','-e',f'import {{tasks}} from {json.dumps(profile.as_uri())};console.log(JSON.stringify(tasks.map(t=>({{id:t.id,delegates:t.delegates}}))));'],check=True,capture_output=True,timeout=5).stdout)
ids=[t['id'] for t in metadata];expectedById={t['id']:t['delegates'] for t in metadata}
plan=[]
for repeat in range(2):
 for index,task in enumerate(ids):
  order=['baseline','full','slim'];shift=index%3;order=order[shift:]+order[:shift]
  if repeat:order=list(reversed(order))
  for variant in order:plan.append({'task':task,'repeat':repeat,'variant':variant})
if phase=='correction':plan=[p for p in plan if p['task']=='sequential-fix-review']
planfile=root/(revision+'-paired-plan.json')
locked={'profileSha256':hashlib.sha256(profile.read_bytes()).hexdigest(),'trialSha256':hashlib.sha256(trial.read_bytes()).hexdigest(),'spawnObserverSha256':hashlib.sha256((here/'subagent-ablation-spawns.mjs').read_bytes()).hexdigest(),'plan':plan}
if planfile.exists():assert json.loads(planfile.read_text())==locked,'changed harness/profile after locking the paired plan'
else:
 frozen=root/('harness-'+revision);frozen.mkdir(mode=0o700)
 for p in [profile,trial,account,here/'subagent-ablation-spawns.mjs',Path(__file__).resolve()]:shutil.copy2(p,frozen/p.name)
 planfile.write_text(json.dumps(locked,indent=2))
selection=plan if phase=='correction' else [p for p in plan if (p['repeat']==0 and p['task'] in ['direct-range','delegate-range'])==(phase=='canary')]
checkpoint=root/(revision+'-'+phase+'-results.json')
resume=len(sys.argv)>3 and sys.argv[3]=='resume'
rows=json.loads(checkpoint.read_text()) if resume and checkpoint.exists() else []
for coordinate in selection:
 previous=next((r for r in rows if all(r[k]==coordinate[k] for k in coordinate)),None)
 if previous:
  # Only an exit-0, checkpointed coordinate may be skipped. Never replay it.
  prior=root/'trials'/f"{revision}-{coordinate['task']}-{coordinate['repeat']}-{coordinate['variant']}"/'result.json'
  observed=json.loads(prior.read_text())
  assert not observed['cleanupUnknown'] and observed.get('directSpawnsClosed') is True
  assert previous['correct']==observed['correct'] and previous['finished']==observed['finished']
  continue
 budget=json.loads((root/'budget.json').read_text())
 # Reserve an extra catalogue dollar per unreturned usage record; not a billing claim.
 if time.time()*1000>=budget['deadlineAt'] or budget['reportedUsd']+budget.get('missingUsage',0)>=18:raise SystemExit('budget admission stopped')
 name=f"{revision}-{coordinate['task']}-{coordinate['repeat']}-{coordinate['variant']}";dest=root/'trials'/name
 if dest.exists():raise SystemExit('existing trial is not replay authorization: '+name)
 env=dict(os.environ);env['NODE_USE_ENV_PROXY']='1';env.pop('NODE_OPTIONS',None)
 args=['node','--experimental-strip-types',str(trial),str(root),coordinate['variant'],coordinate['task'],str(coordinate['repeat']),'live',revision]
 log=root/(name+'.driver.log')
 started=time.time()
 with log.open('wb') as out:
  p=subprocess.Popen(args,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
  (root/'active-trial.json').write_text(json.dumps({**coordinate,'pid':p.pid,'startedAt':started,'argvDigest':hashlib.sha256(json.dumps(args).encode()).hexdigest()}))
  try:p.wait(timeout=125)
  except subprocess.TimeoutExpired:
   # Popen still owns the unreaped group leader. This does not prove escaped children stopped.
   if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=8)
   except subprocess.TimeoutExpired:
    if p.poll() is None:os.killpg(p.pid,signal.SIGKILL)
    p.wait(timeout=5)
   (root/(name+'.unknown.json')).write_text(json.dumps({'driverTimeout':True,'cleanupUnknown':True}))
   raise SystemExit('unknown execution; stop further trials: '+name)
 if p.returncode!=0 or not (dest/'result.json').is_file():raise SystemExit('trial infrastructure failure: '+name)
 result=json.loads((dest/'result.json').read_text())
 subprocess.run(['node',str(account),str(root)],check=True,timeout=10,stdout=subprocess.DEVNULL)
 admitted=sum(r['steps'] for r in result['runs'])
 expected=expectedById[coordinate['task']]
 row={**coordinate,'correct':result['correct'],'finished':result['finished'],'admittedChildren':admitted,'expectedChildren':expected,'adherence':admitted==expected,'parentTurns':result['parentTurns'],'toolErrors':result['toolErrors'],'elapsedMs':result['elapsedMs'],'cleanupUnknown':result['cleanupUnknown'],'providerErrors':result['providerErrors']}
 rows.append(row);checkpoint.write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
 if result['cleanupUnknown'] or not result.get('directSpawnsClosed'):raise SystemExit('unconfirmed cleanup; stop expansion')
 if result['providerErrors'] and not (result['timedOut'] or result['turnBudgetExceeded']):raise SystemExit('provider infrastructure failure; stop expansion')
 # A budget failure with observed closure remains a failed fixed-profile sample,
 # not permission to replay it or silently increase its budget.
print('completed '+phase,flush=True)
