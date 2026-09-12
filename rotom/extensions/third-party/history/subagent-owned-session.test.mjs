import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareOwnedSessionCandidate,verifyOwnedSessionPreimages} from './fixtures/prepare-owned-session.mjs';
import {prepareOwnedStoreCandidate} from './fixtures/prepare-owned-store.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rotom-session-unit-'));
const source=process.env.SUBAGENT_OWNED_SESSION_SOURCE??prepareOwnedSessionCandidate(root);
const baseline=prepareOwnedStoreCandidate(fs.mkdtempSync(path.join(root,'baseline-')));
const installed=path.join(import.meta.dirname,'node_modules/pi-subagents'),legacy=path.join(root,'legacy');
function digest(dir){const files=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='node_modules')continue;assert.equal(e.isSymbolicLink(),false);const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.ts')||p===path.join(dir,'package.json'))files.push(path.relative(dir,p));}}walk(dir);assert.equal(files.length,210);const h=createHash('sha256');for(const f of files.sort())h.update(f).update('\0').update(fs.readFileSync(path.join(dir,f))).update('\0');return h.digest('hex');}
assert.equal(digest(installed),'8fe0ee443eeedc633566b8575358609e952d69bf6971dcd21b80e26d1be022b6');
fs.cpSync(installed,legacy,{recursive:true,filter:p=>path.basename(p)!=='node_modules'});assert.equal(digest(legacy),digest(installed));
for(const name of ['acorn','jiti','typebox','yaml'])fs.cpSync(path.join(installed,'..',name),path.join(root,'node_modules',name),{recursive:true});
const load=f=>import(pathToFileURL(path.join(source,'src',f))),old=f=>import(pathToFileURL(path.join(legacy,'src',f)));
const store=await load('shared/execution-store.ts'),oldStore=await import(pathToFileURL(path.join(baseline,'src/shared/execution-store.ts')));
const fresh=()=>fs.mkdtempSync(path.join(root,'case-'));
const runtime=store.initializeExecutionStore(path.join(root,'runtime'));
process.env.PI_SUBAGENTS_TEMP_ROOT=runtime.baseRoot;process.env.PI_SUBAGENTS_EXECUTION_SCOPE=store.OWNED_EXECUTION_SCOPE;
const lease=await load('runs/shared/session-lease.ts'),oldLease=await old('runs/shared/session-lease.ts');
function file(){const f=path.join(fresh(),'session.jsonl');fs.writeFileSync(f,'');return f;}
function request(sessionFile,runId='fixture'){return {sessionFile,runId,sourceRunId:'source'};}
const gone={pid:901,hostname:'synthetic-host',isProcessAlive:()=>false,getProcessStartIdentity:()=>undefined};
test('sixth layer rejects drift and already applied source',()=>{verifyOwnedSessionPreimages(baseline);assert.throws(()=>verifyOwnedSessionPreimages(source));});
test('v3 anchor pins native sessions and shared leases; v2 reader cannot open it',()=>{const s=store.initializeExecutionStore(path.join(fresh(),'base'));const m=JSON.parse(fs.readFileSync(path.join(s.baseRoot,store.EXECUTION_STORE_MARKER)));assert.equal(m.version,3);assert.equal(s.sessionRoot,path.join(s.root,'sessions'));assert.equal(s.leaseRoot,path.join(s.baseRoot,'session-leases'));assert.throws(()=>oldStore.resolveExecutionStore(s.baseRoot,store.OWNED_EXECUTION_SCOPE));});
test('v2 store cannot be upgraded by runtime open or initializer',()=>{const s=oldStore.initializeExecutionStore(path.join(fresh(),'base')),p=path.join(s.baseRoot,store.EXECUTION_STORE_MARKER),before=fs.readFileSync(p);assert.throws(()=>store.resolveExecutionStore(s.baseRoot,store.OWNED_EXECUTION_SCOPE));assert.throws(()=>store.initializeExecutionStore(s.baseRoot));assert.deepEqual(fs.readFileSync(p),before);});
for(const key of ['leaseRoot','sessionRoot'])for(const mode of ['missing','replaced','symlink'])test(`${key} ${mode} cannot reset or redirect its epoch`,()=>{const s=store.initializeExecutionStore(path.join(fresh(),'base')),p=s[key];fs.renameSync(p,p+'-original');if(mode==='replaced')fs.mkdirSync(p,{mode:0o700});if(mode==='symlink')fs.symlinkSync(p+'-original',p);assert.throws(()=>store.assertExecutionStore(s));assert.throws(()=>store.resolveExecutionStore(s.baseRoot,store.OWNED_EXECUTION_SCOPE));assert.throws(()=>store.initializeExecutionStore(s.baseRoot));if(mode==='missing')assert.equal(fs.existsSync(p),false);});
test('scoped destinations exclude legacy trees and symlinks',()=>{const s=store.initializeExecutionStore(path.join(fresh(),'base'));store.assertScopedSessionPath(s,path.join(s.sessionRoot,'new','session.jsonl'));assert.throws(()=>store.assertScopedSessionPath(s,path.join(s.baseRoot,'legacy.jsonl')),/external destination/);const alias=path.join(s.sessionRoot,'alias');fs.symlinkSync(fresh(),alias);assert.throws(()=>store.assertScopedSessionPath(s,path.join(alias,'session.jsonl')),/symlink/);});
test('scoped lease is opaque to old readers even when both recorded PIDs are gone',()=>{const f=file(),h=lease.acquireSessionLease(request(f),gone);h.updateWriter({state:'running',pid:902});assert.equal(h.owner.version,2);assert.equal(h.owner.storeId,runtime.storeId);assert.equal(oldLease.inspectSessionLease(f).state,'unreadable');assert.throws(()=>oldLease.acquireSessionLease(request(f,'old'),gone),/unreadable owner metadata/);assert.throws(()=>lease.acquireSessionLease(request(f,'new'),gone),/already owned/);assert.equal(h.release(),true);});
test('scoped reader cannot reap a legacy stale owner; legacy positive control can',()=>{const f=file(),h=oldLease.acquireSessionLease(request(f,'legacy'),gone);h.updateWriter({state:'running',pid:902});assert.throws(()=>lease.acquireSessionLease(request(f,'new'),gone),/already owned/);const replacement=oldLease.acquireSessionLease(request(f,'legacy-next'),gone);assert.notEqual(replacement.owner.token,h.owner.token);assert.equal(h.release(),false);assert.equal(replacement.release(),true);});
test('a custom scoped lease root cannot fork canonical exclusion',()=>{const f=file(),other=fresh();assert.throws(()=>lease.acquireSessionLease(request(f),{rootDir:other}),/second canonical/);assert.deepEqual(fs.readdirSync(other),[]);});
test('a dangling lease slot is unavailable, not free',()=>{const f=file(),p=lease.sessionLeaseDir(f),target=path.join(fresh(),'missing');fs.symlinkSync(target,p);assert.equal(lease.inspectSessionLease(f).state,'unreadable');assert.throws(()=>lease.acquireSessionLease(request(f)));assert.equal(fs.existsSync(target),false);});
test('same token with changed ownership cannot be updated or released',()=>{const f=file(),h=lease.acquireSessionLease(request(f)),p=path.join(h.leaseDir,'owner.json'),data=JSON.parse(fs.readFileSync(p));data.runId='foreign';fs.writeFileSync(p,JSON.stringify(data));assert.throws(()=>h.updateWriter({state:'none'}),/ownership changed/);assert.equal(h.release(),false);});
for(const [name,src,expected] of [['baseline',baseline,true],['candidate',source,false]])test(`real ${name}: owner/direct writer die while same-group descendant survives`,{timeout:40000},()=>{const probe=path.join(import.meta.dirname,'fixtures/owned-session-lease-loss.mjs');const r=spawnSync(process.execPath,['--experimental-strip-types',probe,src,legacy],{cwd:root,encoding:'utf8',timeout:35000,env:{PATH:process.env.PATH,HOME:root,TMPDIR:root}});assert.ifError(r.error);assert.equal(r.status,0,r.stderr);const proof=JSON.parse(r.stdout);assert.equal(proof.oldReaderAcquired,expected);assert.equal(proof.sameGroupDescendantSurvivedOwnerAndWriter,true);assert.equal(proof.lateEffectObserved,true);});
