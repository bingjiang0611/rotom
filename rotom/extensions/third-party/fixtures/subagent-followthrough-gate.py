#!/usr/bin/env python3
"""Serial, file-isolated upstream comparison. No credentials or model admission.

This is not the package's concurrent all-files command. Stop the entire matrix
on a timeout/output overflow; never interpret a killed leader as graph closure.
Logs go to files, not communicate() pipes that descendants could keep open.
"""
import argparse, hashlib, json, os, pathlib, re, signal, subprocess, tempfile, time
p=argparse.ArgumentParser();p.add_argument('root',type=pathlib.Path);p.add_argument('--phase',choices=['unit','integration'],default='unit');p.add_argument('--file',action='append',default=[]);p.add_argument('--output',default='gate-v2');p.add_argument('--pattern');p.add_argument('--coordinate-timeout',type=int,choices=range(1,61),default=30);p.add_argument('--variant',choices=['baseline','candidate']);a=p.parse_args()
assert not a.pattern or len(a.file)==1
assert re.fullmatch(r'[a-zA-Z0-9_-]+',a.output)
root=a.root.resolve(strict=True);variants={'baseline':root/'sources/baseline','candidate':root/'candidate'}
if a.variant:variants={a.variant:variants[a.variant]}
out=root/(a.output+'-'+a.phase);out.mkdir(mode=0o700)
runnerHash=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
plans={};hashes={}
for name,source in variants.items():
 pkg=json.loads((source/'package.json').read_text());assert pkg['name']=='pi-subagents' and pkg['version']=='0.52.1'
 assert 'test:'+a.phase in pkg['scripts'];assert (source/'node_modules').is_dir()
 # Preflight must not inherit user Git overrides/config unlike the clean test children.
 gitEnv={'PATH':os.environ['PATH'],'HOME':str(root),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
 git=subprocess.run(['git','rev-parse','--show-toplevel'],cwd=source,env=gitEnv,capture_output=True,text=True,timeout=5)
 if git.returncode==0:assert pathlib.Path(git.stdout.strip()).resolve()==source.resolve(), 'source must not inherit an aggregate Git root'
 else:assert git.returncode==128 and 'not a git repository' in git.stderr
 support=source/('test/support/isolated-temp-root.mjs' if a.phase=='unit' else 'test/support/register-loader.mjs');assert support.is_file()
 plans[name]=sorted(str(f.relative_to(source)) for f in (source/'test'/a.phase).glob('*.test.ts'));assert plans[name]
 hashes[name]={str(f.relative_to(source)):hashlib.sha256(f.read_bytes()).hexdigest() for base in ['src','test/'+a.phase] for f in sorted((source/base).rglob('*.ts'))}
assert len(plans)==1 or plans['baseline']==plans['candidate']
if a.file:
 selected=['test/'+a.phase+'/'+name for name in a.file];assert all(f in next(iter(plans.values())) for f in selected)
 for name in plans:plans[name]=[f for f in plans[name] if f in selected]
files=next(iter(plans.values()));expected=len(files)*len(variants)
rows=[];start=time.monotonic();stopped=False
for index,file in enumerate(files):
 for name in [n for n in (['baseline','candidate'] if index%2==0 else ['candidate','baseline']) if n in variants]:
  case=out/(name+'-'+pathlib.Path(file).stem);case.mkdir(mode=0o700)
  # Tests create projects under os.tmpdir(): placing it inside this repository
  # changes Git-root/package discovery. Keep private HOME/TMP outside any repo.
  sandbox=pathlib.Path(tempfile.mkdtemp(prefix='dev-agent-upstream-gate-'));home=sandbox/'home';home.mkdir(mode=0o700);tmp=sandbox/'tmp';tmp.mkdir(mode=0o700)
  (case/'sandbox.json').write_text(json.dumps({'path':str(sandbox),'retained':True}));os.chmod(case/'sandbox.json',0o600)
  env={'PATH':os.environ['PATH'],'HOME':str(home),'TMPDIR':str(tmp),'LANG':'en_US.UTF-8','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_AUTHOR_NAME':'fixture','GIT_COMMITTER_NAME':'fixture','GIT_AUTHOR_EMAIL':'fixture@example.invalid','GIT_COMMITTER_EMAIL':'fixture@example.invalid'}
  support='./test/support/isolated-temp-root.mjs' if a.phase=='unit' else './test/support/register-loader.mjs'
  command=['node','--experimental-strip-types','--import',support,'--test','--test-concurrency=1','--test-reporter=tap']+(['--test-name-pattern='+a.pattern] if a.pattern else [])+[file]
  log=case/'output.log';then=time.monotonic();reason=None
  with log.open('xb') as stream:
   os.chmod(log,0o600)
   proc=subprocess.Popen(command,cwd=variants[name],env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
   while proc.poll() is None:
    if time.monotonic()-then>=a.coordinate_timeout:reason='deadline'
    if log.stat().st_size>16*1024*1024:reason='output-budget'
    if reason:
     # The still-unreaped direct child owns this freshly allocated group.
     if proc.poll() is None:
      try:os.killpg(proc.pid,signal.SIGTERM)
      except ProcessLookupError:pass
     try:proc.wait(timeout=3)
     except subprocess.TimeoutExpired:
      if proc.poll() is None:
       try:os.killpg(proc.pid,signal.SIGKILL)
       except ProcessLookupError:pass
      try:proc.wait(timeout=3)
      except subprocess.TimeoutExpired:pass
     stopped=True;break
    try:proc.wait(timeout=.1)
    except subprocess.TimeoutExpired:pass
  text=log.read_bytes()[:16*1024*1024].decode(errors='replace')
  counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|cancelled|todo) (\d+)$',text,re.M)}
  # Node may report an empty/filtered file as one passing wrapper test.
  declared=any(title not in [file,str(variants[name]/file)] for title in re.findall(r'^\s*# Subtest: (.+)$',text,re.M))
  rows.append({'variant':name,'file':file,'pattern':a.pattern,'coordinateTimeoutSeconds':a.coordinate_timeout,'exit':proc.returncode,'seconds':round(time.monotonic()-then,3),'reason':reason,'cleanupUnknown':bool(reason),'counts':counts,'declaredTestsObserved':declared,'failureNames':re.findall(r'^\s*not ok \d+ - (.+)$',text,re.M),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()})
  (out/'results.json').write_text(json.dumps({'phase':a.phase,'seconds':round(time.monotonic()-start,3),'plannedFiles':len(files),'complete':len(rows)==expected and not stopped,'modelAuthorized':False,'runnerSha256':runnerHash,'temporaryProjectsOutsideRepo':True,'sourceAndTestHashes':hashes,'rows':rows},indent=2));os.chmod(out/'results.json',0o600)
  print(name,file,proc.returncode,counts,reason,flush=True)
  if stopped:break
 if stopped:break
 if time.monotonic()-start>900:break
complete=len(rows)==expected and not stopped
failed=any(row['exit']!=0 or row['counts'].get('tests',0)==0 or not row['declaredTestsObserved'] for row in rows)
raise SystemExit(2 if stopped else 3 if not complete else 1 if failed else 0)
