#!/usr/bin/env python3
"""Reproduce isolated source ablations; --products packs/installs only baseline/full/slim.
Does not authorize or invoke models. Never edits the source repo or installed packages.
"""
import argparse,base64,hashlib,io,json,re,shutil,subprocess,tarfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--upstream',required=True);parser.add_argument('--output',required=True);parser.add_argument('--products',action='store_true');args=parser.parse_args()
repo=Path(__file__).resolve().parents[4];maint=Path(__file__).resolve().parent.parent;up=Path(args.upstream).resolve();root=Path(args.output).resolve()
def run(argv,cwd,**kw):return subprocess.run(argv,cwd=cwd,check=True,capture_output=True,timeout=kw.pop('timeout',30),**kw).stdout
assert run(['git','rev-parse','--show-toplevel'],repo).decode().strip()==str(repo)
assert run(['git','rev-parse','--show-toplevel'],up).decode().strip()==str(up)
tag='afa22c811f81883acdb248c84f116ac7534e2fb4';assert run(['git','rev-parse','HEAD'],up).decode().strip()==tag
assert (up/'node_modules').is_dir();assert not root.exists();root.mkdir(parents=True,mode=0o700)
archive=run(['git','archive',tag],up)
layers=['wait','owner-loss','lifeline','startup']
for variant in ['baseline','full','slim','no-idle','no-receipt','no-attention-dedup','no-quarantine','no-cascade']:
 dest=root/'sources'/variant;dest.mkdir(parents=True)
 with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(dest,filter='data')
 if variant!='baseline':
  for layer in layers:run(['git','apply','--unidiff-zero',str(maint/f'subagent-{layer}-candidate.patch')],dest)
 if variant=='slim':run(['git','apply','--unidiff-zero',str(maint/'subagent-slim-candidate.patch')],dest)
 if variant=='no-idle':run(['git','apply','--unidiff-zero',str(maint/'subagent-idle-probe-ablation.patch')],dest)
 if variant=='no-receipt':
  p=dest/'src/runs/background/wait-subscriptions.ts';s=p.read_text();start=s.index('\tconst hasReceipt = ');end=s.index('\n\tconst reconcileDelivery',start);p.write_text(s[:start]+'\tconst hasReceipt = (_record: WaitSubscriptionRecord): boolean => true;\n'+s[end:])
 if variant=='no-attention-dedup':
  p=dest/'src/runs/background/wait-subscriptions.ts';s=p.read_text();needle='\t\tif (record.lastAttentionKey === key) return;\n';assert s.count(needle)==1;p.write_text(s.replace(needle,''))
 if variant=='no-quarantine':
  p=dest/'src/runs/background/stale-run-reconciler.ts';s=p.read_text();lines=[l for l in s.splitlines(True) if 'throw new StaleWorkflowExecutionUnknownError' in l];assert len(lines)==1;p.write_text(s.replace(lines[0],''))
 if variant=='no-cascade':
  p=dest/'src/runs/shared/owner-lifeline.ts';s=p.read_text();needle='try { (options.disconnectChildren ?? disconnectOwnedLifelines)(); }';assert s.count(needle)==1;p.write_text(s.replace(needle,'try { /* cascade disabled for the negative control */ }'))
 (dest/'node_modules').symlink_to(up/'node_modules',target_is_directory=True)
if args.products:
 productArchive=run(['git','archive','HEAD','rotom'],repo)
 for variant in ['baseline','full','slim']:
  product=root/'products'/variant;product.mkdir(parents=True)
  with tarfile.open(fileobj=io.BytesIO(productArchive)) as t:t.extractall(product,filter='data')
  tp=product/'rotom/extensions/third-party'
  if variant!='baseline':
   staging=root/'packs'/variant;shutil.copytree(root/'sources'/variant,staging,ignore=shutil.ignore_patterns('node_modules'))
   package=json.loads((staging/'package.json').read_text());assert package['name']=='pi-subagents' and package['version']=='0.52.1'
   version=f'0.52.1-dev-agent-ablation.{variant}.1';package['version']=version;(staging/'package.json').write_text(json.dumps(package,indent=2)+'\n')
   packed=json.loads(run(['npm','pack','--ignore-scripts','--json','--pack-destination',str(root)],staging))[0];tar=root/packed['filename'];integrity='sha512-'+base64.b64encode(hashlib.sha512(tar.read_bytes()).digest()).decode();assert integrity==packed['integrity']
   package=json.loads((tp/'package.json').read_text());lock=json.loads((tp/'package-lock.json').read_text());assert lock['lockfileVersion']==3
   package['dependencies']['pi-subagents']=version;lock['packages']['']['dependencies']['pi-subagents']=version;lock['packages']['node_modules/pi-subagents'].update(version=version,resolved=tar.as_uri(),integrity=integrity)
   (tp/'package.json').write_text(json.dumps(package,indent=2)+'\n');(tp/'package-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
   config=product/'rotom/runtime/product-config.mjs';s,n=re.subn(r'("pi-subagents": \{ version: ")[^"]+("\, integrity: ")[^"]+',lambda m:m[1]+version+m[2]+integrity,config.read_text());assert n==1;config.write_text(s)
  run(['npm','ci','--ignore-scripts','--omit=optional','--legacy-peer-deps','--registry=https://registry.npmjs.org','--replace-registry-host=always'],tp,timeout=90)
  print('installed isolated product',variant,flush=True)
identity={'schemaVersion':1,'sourceTag':tag,'productHead':run(['git','rev-parse','HEAD'],repo).decode().strip(),'modelAuthorized':False,'sourceHashes':{v.name:{str(p.relative_to(v)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (v/'src').rglob('*.ts')} for v in (root/'sources').iterdir()}}
(root/'prepared-identity.json').write_text(json.dumps(identity,indent=2));print('prepared',root)
