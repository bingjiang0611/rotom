#!/usr/bin/env python3
"""Real CLI/PTY content smoke, not a desktop screenshot or terminal-layout test.
Sends one trusted slash command. Model dispatch is forbidden by the existing ledger.
Only the fresh private evidence directory retains terminal bytes (including balances).
"""
import argparse, collections, fcntl, hashlib, json, os, pathlib, pty, re, select, signal, shutil, struct, subprocess, termios, time, uuid
p=argparse.ArgumentParser();p.add_argument('--launcher',required=True);p.add_argument('--work',required=True);p.add_argument('--pi-entry');p.add_argument('--session-file');p.add_argument('--model',choices=['lite','smodel'],default='lite');p.add_argument('--columns',type=int,choices=[80,140,200],default=140);a=p.parse_args()
repo=pathlib.Path(__file__).resolve().parents[2];work=pathlib.Path(a.work);launcher=pathlib.Path(a.launcher)
assert work.is_absolute() and work.resolve()==work and work.is_dir() and work.stat().st_uid==os.getuid() and work.stat().st_mode&0o077==0
assert launcher.is_absolute() and launcher.resolve()==launcher and launcher.is_file() and os.access(launcher,os.X_OK)
node=pathlib.Path(shutil.which('node')).resolve();assert node.is_file() and os.access(node,os.X_OK)
for file in ['live-budget.mjs','tui-net-observer.mjs']:assert (repo/'experiments/qoder-provider'/file).is_file()
auth=work/'isolated-auth-2';assert auth.is_dir() and auth.resolve()==auth
os.umask(0o077);run=work/('tui-'+str(uuid.uuid4()));run.mkdir();home=run/'home';home.mkdir();cwd=run/'business';cwd.mkdir()
events=work/('tui-events-'+str(uuid.uuid4())+'.jsonl');events.write_text('');output=run/'terminal.private';result={'mode':'cli-pty-content','pass':False,'evidenceDirectory':str(run),'eventsFile':str(events),'commandDispatches':0}
global_auth=pathlib.Path.home()/'.pi/agent/auth.json'
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
before_global=digest(global_auth);before_auth=digest(auth/'auth.json');before_ledger=int((work/'ledger').read_text())
result.update(launcher=str(launcher),columns=a.columns,launcherSHA256=digest(launcher),piOverrideSHA256=digest(pathlib.Path(a.pi_entry)) if a.pi_entry else None,runtimeDigests={name:digest(launcher.parent.parent/'extensions/qoder'/name) for name in ['credits.mjs','transport.mjs','provider.mjs','session-policy.mjs']})
session_args=['--no-session'];source=None;source_hash=None
if a.session_file:
 source=pathlib.Path(a.session_file);assert source.is_relative_to(work) and source.resolve()==source and source.is_file() and source.stat().st_size<=16*1024*1024 and source.parent.name.startswith('qoder-credit-session-')
 source_hash=digest(source);copy=run/'session.jsonl';shutil.copyfile(source,copy);session_args=['--session',str(copy)]
env={'PATH':str(node.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'LANG':'en_US.UTF-8','TERM':'xterm-256color','COLORTERM':'truecolor','ROTOM_NODE':str(node),'PI_CODING_AGENT_DIR':str(auth),'PI_OFFLINE':'1','PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0','PI_IMAGE_PROTOCOL':'none','PI_HYPERLINKS':'0','ROTOM_OBSERVABILITY':'0','ROTOM_QODER':'1','ROTOM_QODER_AUTH':'browser','ROTOM_QODER_PROBE_LIMIT':'1000','ROTOM_QODER_PROBE_LEDGER':str(work/'ledger'),'ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR':str(auth),'ROTOM_QODER_PROBE_TUI_EVENTS':str(events),'ROTOM_QODER_PROBE_CATALOG':'1','ROTOM_QODER_PROBE_CREDIT':'1','ROTOM_QODER_PROBE_OAUTH':'1','ROTOM_QODER_PROBE_NO_MODELS':'1','NODE_OPTIONS':' '.join('--import '+str(repo/'experiments/qoder-provider'/x) for x in ['live-budget.mjs','tui-net-observer.mjs'])}
if a.pi_entry:
 pi=pathlib.Path(a.pi_entry);assert pi.is_absolute() and pi.resolve()==pi and pi.is_file();env['ROTOM_PI']=str(pi)
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',48,a.columns,0,0));proc=None;raw=b'';sent_at=None;stop_sent=False;query_end=0
ansi=re.compile(r'\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]',re.S)
def records():return [json.loads(x) for x in events.read_text().splitlines()]
def plain(data):return ansi.sub('',data.decode('utf-8','replace'))
try:
 proc=subprocess.Popen([str(launcher),*session_args,'--provider','qoder-experimental','--model',a.model],cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);slave=None;deadline=time.monotonic()+100
 with output.open('wb') as capture:
  while time.monotonic()<deadline:
   if select.select([master],[],[],0.15)[0]:
    try:chunk=os.read(master,65536)
    except OSError:break
    if not chunk:break
    raw+=chunk;capture.write(chunk);capture.flush();assert len(raw)<=2*1024*1024
    for match in re.finditer(b'\x1b\\[6n',raw[query_end:]):os.write(master,b'\x1b[1;1R');query_end+=match.end();break
   rows=records();started={x['id'] for x in rows if x['event']=='start'};ended={x['id'] for x in rows if x['event'] in ['end','error']}
   if sent_at is None and 'Qoder: USD cost unknown' in plain(raw) and any(x['kind']=='catalog' and x['event']=='end' for x in rows) and started==ended:
    sent_at=len(raw);os.write(master,b'/qoder-credits\r');result['commandDispatches']=1
   if sent_at is not None and not stop_sent:
    view=plain(raw[sent_at:]);displayed=all(x in view for x in ['Qoder Credit snapshot (','plan:','addon:','shared:','remaining '])
    if displayed and started==ended:
     result['quotaSnapshotDisplayed']=True;os.write(master,b'\x04');stop_sent=True
   if proc.poll() is not None:break
  if proc.poll() is None:
   proc.wait(timeout=3)
 result['exitCode']=proc.returncode;result['creditFooterDisplayed']='Credit(partial,billable):' in plain(raw)
 counts=dict(collections.Counter(x['kind'] for x in records() if x['event']=='start'));result['requests']=counts
 result['pass']=proc.returncode==0 and result.get('quotaSnapshotDisplayed') is True and result['commandDispatches']==1 and counts.get('quota')==1 and counts.get('model',0)==0 and counts.get('other',0)==0
except Exception as error:result['errorType']=type(error).__name__
finally:
 if proc is not None and proc.poll() is None:
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=4)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
 if slave is not None:os.close(slave)
 os.close(master);result['exitCode']=proc.returncode if proc is not None else None
 try:result['requests']=dict(collections.Counter(x['kind'] for x in records() if x['event']=='start'))
 except Exception:result['requests']=None;result['pass']=False
 result.update(globalAuthUnchanged=digest(global_auth)==before_global,isolatedAuthUnchanged=digest(auth/'auth.json')==before_auth,ledgerDelta=int((work/'ledger').read_text())-before_ledger,ledgerTotal=int((work/'ledger').read_text()))
 result['sourceSessionUnchanged']=source is None or digest(source)==source_hash
 result['pass']=result['pass'] and result['globalAuthUnchanged'] and result['sourceSessionUnchanged'] and (source is None or result.get('creditFooterDisplayed') is True) and result['ledgerDelta']==sum(result['requests'].values());(run/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
raise SystemExit(0 if result['pass'] else 1)
