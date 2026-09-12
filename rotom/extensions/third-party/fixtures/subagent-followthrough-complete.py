#!/usr/bin/env python3
"""Run a frozen metadata-only coordinate profile through the existing bounded gate."""
import argparse,hashlib,json,os,pathlib,re,signal,subprocess,time
p=argparse.ArgumentParser();p.add_argument('root',type=pathlib.Path);p.add_argument('profile',type=pathlib.Path);p.add_argument('--variant',choices=['baseline','candidate']);p.add_argument('--output',default='complete');a=p.parse_args()
assert re.fullmatch('[a-zA-Z0-9_-]+',a.output)
root=a.root.resolve(strict=True);profile=a.profile.resolve(strict=True);content=profile.read_bytes();digest=hashlib.sha256(content).hexdigest();plan=json.loads(content)['coordinates'];assert plan
for c in plan:
 assert c['phase'] in ['unit','integration'] and pathlib.Path(c['file']).name==c['file'] and c['file'].endswith('.test.ts')
 assert c['pattern'] is None or isinstance(c['pattern'],str) and len(c['pattern'])<=32768
 assert 1<=c.get('seconds',30)<=60
out=root/a.output;out.mkdir(mode=0o700);source=pathlib.Path(__file__).resolve().with_name('subagent-followthrough-gate.py');assert source.is_file()
driver=out/'gate.py';driver.write_bytes(source.read_bytes());os.chmod(driver,0o600)
rows=[];start=time.monotonic();stop=None
for i,c in enumerate(plan):
 if time.monotonic()-start>=3600:stop='profile-window';break
 seconds=c.get('seconds',30);assert 1<=seconds<=60
 name=f'{a.output}-{i:03}';cmd=['python3',str(driver),str(root),'--phase',c['phase'],'--file',c['file'],'--output',name,'--coordinate-timeout',str(seconds)]+(['--pattern',c['pattern']] if c['pattern'] else [])+(['--variant',a.variant] if a.variant else [])
 with (out/f'{i:03}.log').open('xb') as stream:
  os.chmod(stream.name,0o600);proc=subprocess.Popen(cmd,stdout=stream,stderr=stream,start_new_session=True)
  try:proc.wait(timeout=(1 if a.variant else 2)*seconds+20)
  except subprocess.TimeoutExpired:
   if proc.poll() is None:os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=4)
   except subprocess.TimeoutExpired:
    if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL)
    proc.wait(timeout=4)
   stop='driver-closure-unknown'
 file=root/f'{name}-{c["phase"]}/results.json';data=json.loads(file.read_text()) if file.exists() else None
 rows.append({'coordinate':c,'exit':proc.returncode,'complete':data.get('complete') if data else False,'rows':data.get('rows') if data else []})
 if proc.returncode not in [0,1] or not data or not data.get('complete'):stop=stop or 'coordinate-unconfirmed'
 (out/'results.json').write_text(json.dumps({'profileSha256':digest,'complete':len(rows)==len(plan) and stop is None,'plannedCoordinates':len(plan),'seconds':time.monotonic()-start,'stop':stop,'rows':rows},indent=2));os.chmod(out/'results.json',0o600)
 print(i,c['phase'],c['file'],proc.returncode,flush=True)
 if stop:break
(out/'finish.json').write_text(json.dumps({'complete':len(rows)==len(plan) and stop is None,'stop':stop,'seconds':time.monotonic()-start}));os.chmod(out/'finish.json',0o600)
raise SystemExit(2 if stop else 1 if any(r['exit'] for r in rows) else 0)
