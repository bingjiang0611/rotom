import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { prepareOwnedStoreCandidate, verifyOwnedStorePreimages } from "./fixtures/prepare-owned-store.mjs";
import { prepareOwnedForegroundCandidate } from "./fixtures/prepare-owned-foreground.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-store-unit-"));
const source = process.env.SUBAGENT_OWNED_STORE_SOURCE ?? prepareOwnedStoreCandidate(root);
const installed = path.join(import.meta.dirname, "node_modules/pi-subagents"), legacy = path.join(root, "legacy");
function legacyDigest(dir) {
	const names = [];
	function walk(folder) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { if (entry.name === "node_modules") continue; const p = path.join(folder, entry.name); assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) walk(p); else if (p.endsWith(".ts") || p === path.join(dir, "package.json")) names.push(path.relative(dir, p)); } }
	walk(dir); const hash = createHash("sha256"); for (const name of names.sort()) hash.update(name).update("\0").update(fs.readFileSync(path.join(dir, name))).update("\0");
	assert.equal(names.length, 210); return hash.digest("hex");
}
assert.equal(legacyDigest(installed), "8fe0ee443eeedc633566b8575358609e952d69bf6971dcd21b80e26d1be022b6");
fs.cpSync(installed, legacy, { recursive: true, filter: p => path.basename(p) !== "node_modules" });
assert.equal(legacyDigest(legacy), legacyDigest(installed));
for (const name of ["acorn", "jiti", "typebox", "yaml"]) fs.cpSync(path.join(installed, "..", name), path.join(root, "node_modules", name), { recursive: true });
const store = await import(pathToFileURL(path.join(source, "src/shared/execution-store.ts")));
const scope = store.OWNED_EXECUTION_SCOPE;
const fresh = () => fs.mkdtempSync(path.join(root, "case-"));
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
const save = (p, value) => fs.writeFileSync(p, JSON.stringify(value), { mode: 0o600 });
const selected = () => store.initializeExecutionStore(path.join(fresh(), "base"));
const marker = s => path.join(s.baseRoot, store.EXECUTION_STORE_MARKER);
function probe(code, { base = path.join(fresh(), "base"), selectedScope = scope } = {}) {
	const dir = fresh(), home = path.join(dir, "home"), script = path.join(dir, "probe.mjs"); fs.mkdirSync(home);
	if (selectedScope === scope) store.initializeExecutionStore(base); // Explicit fixture setup, never runtime fallback.
	fs.writeFileSync(script, `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
	globalThis.fetch=()=>{throw Error('Network forbidden in store fixture')};
	const source=${JSON.stringify(source)}, legacy=${JSON.stringify(legacy)}, base=${JSON.stringify(base)}, scope=${JSON.stringify(scope)};
	const load=p=>import(pathToFileURL(path.join(source,p)));const old=p=>import(pathToFileURL(path.join(legacy,p)));
	${code}`);
	const result = spawnSync(process.execPath, ["--experimental-strip-types", script], { cwd: dir, encoding: "utf8", timeout: 30000,
		env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_SUBAGENTS_TEMP_ROOT: base,
			PI_SUBAGENTS_EXECUTION_SCOPE: selectedScope ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	assert.ifError(result.error); assert.equal(result.status, 0, `${result.stderr}\nRetained probe: ${dir}`);
	return { base, output: result.stdout };
}

test("fifth layer requires exact preimages and refuses already patched source", () => {
	assert.throws(() => verifyOwnedStorePreimages(source));
	const base = prepareOwnedForegroundCandidate(fresh()); verifyOwnedStorePreimages(base);
	const file = path.join(base, 'src/shared/types.ts'), drift = fs.readFileSync(file, 'utf8') + '\n'; fs.writeFileSync(file, drift);
	assert.throws(() => verifyOwnedStorePreimages(base), /preimage drift/); assert.equal(fs.readFileSync(file, 'utf8'), drift);
	assert.equal(fs.existsSync(path.join(base, 'src/shared/execution-store.ts')), false);
});
test("candidate preparer rejects the installed target without changing its bytes", () => {
	const before = legacyDigest(installed); assert.throws(() => prepareOwnedStoreCandidate(installed), /private|outside/); assert.equal(legacyDigest(installed), before);
});
test("candidate preparer rejects node_modules reached through an ancestor alias", () => {
	for (const name of ['node_modules', 'NODE_MODULES']) {
		const dir = fresh(), modules = path.join(dir, name), alias = path.join(dir, 'alias'); fs.mkdirSync(modules, { mode: 0o700 }); fs.mkdirSync(path.join(modules, 'private'), { mode: 0o700 }); fs.symlinkSync(modules, alias);
		assert.throws(() => prepareOwnedStoreCandidate(path.join(alias, 'private')), /outside/); assert.deepEqual(fs.readdirSync(path.join(modules, 'private')), []);
	}
});
test("candidate preparer never merges an existing or linked target", () => {
	for (const name of ['candidate', 'node_modules']) {
		const dir = fresh(), absent = path.join(fresh(), 'absent'); fs.symlinkSync(absent, path.join(dir, name));
		assert.throws(() => prepareOwnedStoreCandidate(dir), /EEXIST/); assert.equal(fs.existsSync(absent), false); assert.equal(fs.lstatSync(path.join(dir, name)).isSymbolicLink(), true);
	}
});
test("legacy selection is unchanged and does not initialize directories", () => {
	const base = path.join(fresh(), "absent"), s = store.resolveExecutionStore(base, "");
	assert.equal(s.root, base); assert.equal(s.scope, undefined); assert.equal(fs.existsSync(base), false);
});
test("explicit scope creates a private immutable binding and reopens the same store", () => {
	const s = selected(); assert.equal(s.root, path.join(s.baseRoot, scope)); assert.ok(Object.isFrozen(s));
	assert.equal(fs.statSync(s.root).mode & 0o777, 0o700); assert.equal(fs.statSync(marker(s)).mode & 0o777, 0o600);
	assert.deepEqual(store.resolveExecutionStore(s.baseRoot, scope), s); store.assertExecutionStore(s);
});
test("base must be owned and not writable by others; existing read-only visibility is not chmodded", () => {
	const base = path.join(fresh(), 'base'); fs.mkdirSync(base, { mode: 0o755 }); fs.chmodSync(base, 0o777);
	assert.throws(() => store.initializeExecutionStore(base), /directory identity/); assert.deepEqual(fs.readdirSync(base), []); assert.equal(fs.statSync(base).mode & 0o777, 0o777);
	fs.chmodSync(base, 0o755); const getuid = process.getuid;
	try { process.getuid = () => getuid() + 1; assert.throws(() => store.initializeExecutionStore(base), /directory identity/); assert.deepEqual(fs.readdirSync(base), []); } finally { process.getuid = getuid; }
	const s = store.initializeExecutionStore(base); assert.equal(fs.statSync(base).mode & 0o777, 0o755);
	fs.chmodSync(base, 0o777); assert.throws(() => store.assertExecutionStore(s), /directory identity/); assert.throws(() => store.resolveExecutionStore(base, scope), /directory identity/);
});
test("runtime open never initializes an absent scoped store", () => {
	const base = path.join(fresh(), "absent"); assert.throws(() => store.resolveExecutionStore(base, scope)); assert.equal(fs.existsSync(base), false);
});
test("namespace deletion cannot be reset to an empty pool by reopening or initialization", () => {
	const s = selected(), before = fs.readFileSync(marker(s)); fs.rmSync(s.root, { recursive: true });
	assert.throws(() => store.resolveExecutionStore(s.baseRoot, scope)); assert.throws(() => store.initializeExecutionStore(s.baseRoot));
	assert.equal(fs.existsSync(s.root), false); assert.deepEqual(fs.readFileSync(marker(s)), before);
});
test("unknown scope is rejected before creating metadata", () => {
	const base = path.join(fresh(), "absent"); assert.throws(() => store.resolveExecutionStore(base, "future-scope"), /must be/); assert.equal(fs.existsSync(base), false);
});
test("unsupported platform rejects the scoped store before creating metadata", () => {
	const base = path.join(fresh(), "absent"), descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try { Object.defineProperty(process, "platform", { value: "win32" }); assert.throws(() => store.resolveExecutionStore(base, scope), /supported POSIX/); }
	finally { Object.defineProperty(process, "platform", descriptor); }
	assert.equal(fs.existsSync(base), false);
});
for (const occupied of [false, true]) test(`existing unmarked ${occupied ? "populated" : "empty"} namespace is never adopted`, () => {
	const base = path.join(fresh(), "base"), dir = path.join(base, scope); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (occupied) fs.writeFileSync(path.join(dir, "legacy-state"), "preserve");
	assert.throws(() => store.resolveExecutionStore(base, scope)); assert.throws(() => store.initializeExecutionStore(base)); assert.equal(fs.existsSync(path.join(base, store.EXECUTION_STORE_MARKER)), false);
	if (occupied) assert.equal(fs.readFileSync(path.join(dir, "legacy-state"), "utf8"), "preserve");
});
test("linked namespace is rejected without creating a marker in the target", () => {
	const base = fresh(), outside = fresh(); fs.symlinkSync(outside, path.join(base, scope));
	assert.throws(() => store.resolveExecutionStore(base, scope)); assert.throws(() => store.initializeExecutionStore(base), /EEXIST/); assert.equal(fs.existsSync(path.join(base, store.EXECUTION_STORE_MARKER)), false); assert.equal(fs.readdirSync(outside).length, 0);
});
for (const [name, mutate] of [
	["scope", v => { v.scope = "future"; }], ["version", v => { v.version += 1; }],
	["store id", v => { v.storeId = "00000000-0000-4000-8000-000000000000"; }],
	["directory inode", v => { v.inode = "0"; }], ["base inode", v => { v.baseInode = "0"; }],
	["root path", v => { v.root += "-foreign"; }],
]) test(`live ${name} drift cannot be treated as a fresh store`, () => {
	const s = selected(), value = read(marker(s)); mutate(value); save(marker(s), value);
	assert.throws(() => store.assertExecutionStore(s), /identity drift/);
});
for (const kind of ["missing", "malformed", "linked", "public"]) test(`${kind} marker fails closed`, () => {
	const s = selected(), file = marker(s);
	if (kind === "missing") fs.unlinkSync(file);
	if (kind === "malformed") fs.writeFileSync(file, "{");
	if (kind === "linked") { fs.renameSync(file, file + ".original"); fs.symlinkSync(file + ".original", file); }
	if (kind === "public") fs.chmodSync(file, 0o644);
	assert.throws(() => store.assertExecutionStore(s)); assert.throws(() => store.resolveExecutionStore(s.baseRoot, scope)); assert.throws(() => store.initializeExecutionStore(s.baseRoot));
});
test("copying a scoped directory cannot import its binding into another root", () => {
	const s = selected(), base = fresh(); fs.cpSync(s.root, path.join(base, scope), { recursive: true }); fs.chmodSync(path.join(base, scope), 0o700); fs.copyFileSync(marker(s), path.join(base, store.EXECUTION_STORE_MARKER));
	if (s.leaseRoot) { fs.cpSync(s.leaseRoot, path.join(base, 'session-leases'), { recursive: true }); fs.chmodSync(path.join(base, 'session-leases'), 0o700); fs.chmodSync(path.join(base, scope, 'sessions'), 0o700); }
	assert.throws(() => store.resolveExecutionStore(base, scope), /identity drift/); store.assertExecutionStore(s);
});
test("replacing the base is detected even when the original scoped directory inode survives", () => {
	const s = selected(), parked = s.baseRoot + "-parked"; fs.renameSync(s.baseRoot, parked); fs.mkdirSync(s.baseRoot, { mode: 0o700 });
	fs.renameSync(path.join(parked, scope), s.root); fs.renameSync(path.join(parked, store.EXECUTION_STORE_MARKER), marker(s));
	if (s.leaseRoot) fs.renameSync(path.join(parked, 'session-leases'), s.leaseRoot);
	assert.equal(String(fs.statSync(s.root, { bigint: true }).ino), s.inode);
	assert.throws(() => store.assertExecutionStore(s), /identity drift/); assert.throws(() => store.resolveExecutionStore(s.baseRoot, scope), /identity drift/);
});
test("scope/config mismatch is rejected rather than changing allocation mode", () => {
	const s = selected(); assert.throws(() => store.assertExecutionStoreScope(s, undefined), /mismatch/);
	assert.throws(() => store.assertExecutionStoreScope(s, scope, "foreign"), /mismatch/);
	assert.throws(() => store.assertExecutionStoreScope(store.resolveExecutionStore(fresh(), ""), scope), /mismatch/);
});
test("capacity owners bind the selected store; foreign and deleted identities retain or block", () => {
	probe(`const {DIRS,EXECUTION_STORE}=await load('src/shared/types.ts');const cap=await load('src/runs/background/active-async-capacity.ts');
	const h=cap.acquireActiveAsyncCapacity({sessionId:'s',limit:1,runId:'r',kind:'runner',asyncDir:path.join(DIRS.async,'r'),scope});
	assert.equal(h.owner.storeId,EXECUTION_STORE.storeId);const file=path.join(EXECUTION_STORE.root,'session-active-async-capacity',h.owner.ownerSessionKey,'slot-0/owner.json');
	const owner=JSON.parse(fs.readFileSync(file));owner.storeId='foreign';fs.writeFileSync(file,JSON.stringify(owner));
	assert.equal(cap.getActiveAsyncCapacitySnapshot('s',1).used,1);assert.throws(()=>cap.acquireActiveAsyncCapacity({sessionId:'s',limit:1,runId:'next',kind:'runner',asyncDir:path.join(DIRS.async,'next'),scope}),/exhausted/);
	fs.unlinkSync(path.join(EXECUTION_STORE.baseRoot,'.owned-process-groups-v2.json'));assert.throws(()=>cap.getActiveAsyncCapacitySnapshot('s',1));assert.throws(()=>h.rollback());`);
});
test("a legacy process cannot allocate scoped owners, even with an unlimited setting", () => {
	probe(`const cap=await load('src/runs/background/active-async-capacity.ts');for(const limit of [1,undefined])assert.throws(()=>cap.acquireActiveAsyncCapacity({sessionId:'s',limit,runId:'r',kind:'runner',asyncDir:path.join(base,'r'),scope}),/mismatch/);`, { selectedScope: "" });
});
test("writer requests must match the creation-time store before their first write", () => {
	probe(`const {EXECUTION_STORE}=await load('src/shared/types.ts');const own=await load('src/runs/background/owned-execution.ts');const dir=path.join(base,'attempt');
	for(const storeId of [undefined,'foreign'])assert.throws(()=>own.beginOwnedExecution(dir,'r','runner',{scope,storeId}));
	assert.equal(fs.existsSync(dir),false);own.beginOwnedExecution(dir,'r','runner',{scope,storeId:EXECUTION_STORE.storeId});
	const id=own.registerOwnedWriter(dir,'pi-writer',0);assert.equal(typeof id,'string');
	const file=path.join(dir,'process-terminal-candidate.json'),raw=JSON.parse(fs.readFileSync(file));raw.ownedExecution.storeId='foreign';fs.writeFileSync(file,JSON.stringify(raw));
	assert.throws(()=>own.registerOwnedWriter(dir,'pi-writer',1),/mismatch/);`);
});
test("real old retention deletes exposed scope-shaped records but cannot see the new namespace", () => {
	probe(`const {DIRS,EXECUTION_STORE}=await load('src/shared/types.ts');const {DIRS:oldDirs}=await old('src/shared/types.ts');
	const cap=await load('src/runs/background/active-async-capacity.ts'),wf=await load('src/runs/background/owned-workflow.ts');
	const id='scoped-run',dir=path.join(DIRS.async,id);fs.mkdirSync(dir,{recursive:true});
	const h=cap.acquireActiveAsyncCapacity({sessionId:'s',limit:1,runId:id,kind:'workflow',asyncDir:dir,scope});
	const owner=wf.beginOwnedWorkflow(dir,id,'s',{ownerSessionId:h.owner.ownerSessionId,reservationToken:h.owner.reservationToken,generation:h.owner.generation});h.markWorkflowStarted(owner.controllerInstanceId);
	const status={runId:id,sessionId:'s',mode:'workflow',state:'complete',startedAt:1,updatedAt:1,endedAt:1,steps:[],ownedExecutionScope:scope};
	fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(status));
	const exposed=path.join(oldDirs.async,'exposed');fs.mkdirSync(exposed,{recursive:true});fs.writeFileSync(path.join(exposed,'status.json'),JSON.stringify({...status,runId:'exposed',mode:'single'}));
	const own=await load('src/runs/background/owned-execution.ts');own.beginOwnedExecution(exposed,'exposed','runner',{scope,storeId:EXECUTION_STORE.storeId});own.registerOwnedWriter(exposed,'external-cli',0);
	const before=fs.readFileSync(path.join(dir,'process-terminal-candidate.json'));const {cleanupAsyncRetention}=await old('src/runs/background/async-retention.ts');
	const result=await cleanupAsyncRetention({asyncDirRoot:oldDirs.async,resultsDir:oldDirs.results,now:()=>Date.now()+45*86400000,retentionMs:1,tombstoneGraceMs:0});
	assert.equal(result.workerFailed,false);assert.ok(result.deletedRuns>=1,JSON.stringify(result));assert.equal(fs.existsSync(exposed),false);
	assert.deepEqual(fs.readFileSync(path.join(dir,'process-terminal-candidate.json')),before);assert.equal(cap.getActiveAsyncCapacitySnapshot('s',1).used,1);
	console.log(JSON.stringify({oldDeletedExposed:true,newNamespaceIntact:true,scopedCapacity:1}));`);
});
for (const kind of ["workflow", "foreground"]) test(`${kind} proof from another store cannot release capacity`, () => {
	probe(`const {DIRS}=await load('src/shared/types.ts'),cap=await load('src/runs/background/active-async-capacity.ts'),wf=await load('src/runs/background/owned-workflow.ts'),fg=await load('src/runs/background/owned-foreground.ts');
	const id='parent',dir=path.join(DIRS.async,id);fs.mkdirSync(dir,{recursive:true});
	const h=cap.acquireActiveAsyncCapacity({sessionId:'s',limit:1,runId:id,kind:'workflow',asyncDir:dir,scope}),w=wf.beginOwnedWorkflow(dir,id,'s',{ownerSessionId:h.owner.ownerSessionId,reservationToken:h.owner.reservationToken,generation:h.owner.generation});h.markWorkflowStarted(w.controllerInstanceId);
	fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({runId:id,sessionId:'s',mode:'workflow',state:'complete',steps:[]}));
	let target=dir,key='ownedWorkflow';
	if(${JSON.stringify(kind)}==='foreground'){const a=wf.registerWorkflowAdmission(dir,w,'pi'),p=wf.bindWorkflowAdmission(dir,w,a,'child','foreground');target=path.join(DIRS.async,'child');key='ownedForeground';const f=fg.beginOwnedForeground(target,p);fg.finishForegroundPipeline(f);fg.returnForegroundHost(f);}
	wf.closeOwnedWorkflow(dir,w);const file=path.join(target,'process-terminal-candidate.json'),raw=JSON.parse(fs.readFileSync(file));raw[key].storeId='foreign';fs.writeFileSync(file,JSON.stringify(raw));assert.equal(cap.getActiveAsyncCapacitySnapshot('s',1).used,1);`);
});
test("old and new readers share the same canonical session lease in both directions", () => {
	probe(`const n=await load('src/runs/shared/session-lease.ts'),o=await old('src/runs/shared/session-lease.ts');const file=path.join(base,'session.jsonl');fs.writeFileSync(file,'');
	const first=n.acquireSessionLease({sessionFile:file,runId:'new',sourceRunId:'new-source'});assert.equal(o.inspectSessionLease(file).state,first.owner.version===2?'unreadable':'owned');assert.throws(()=>o.acquireSessionLease({sessionFile:file,runId:'old',sourceRunId:'old-source'}));assert.equal(first.release(),true);
	const second=o.acquireSessionLease({sessionFile:file,runId:'old',sourceRunId:'old-source'});assert.equal(n.inspectSessionLease(file).state,'owned');assert.throws(()=>n.acquireSessionLease({sessionFile:file,runId:'new',sourceRunId:'new-source'}));assert.equal(second.release(),true);
	assert.equal(fs.realpathSync(n.SESSION_LEASES_DIR),fs.realpathSync(o.SESSION_LEASES_DIR));`);
});
test("two real old/new processes contend for one lease, with exactly one winner", () => {
	probe(`const {spawn}=await import('node:child_process');const file=path.join(base,'shared.jsonl'),release=path.join(base,'release');fs.writeFileSync(file,'');
	const script=path.join(base,'contend.mjs');fs.writeFileSync(script,\`import assert from 'node:assert/strict';import fs from 'node:fs';
	globalThis.fetch=()=>{throw Error('Network forbidden')};const timer=setTimeout(()=>process.exit(3),10000);
	const old=process.argv[2]==='old';const mod=await import(old?\${JSON.stringify(pathToFileURL(path.join(legacy,'src/runs/shared/session-lease.ts')).href)}:\${JSON.stringify(pathToFileURL(path.join(source,'src/runs/shared/session-lease.ts')).href)});
	let lease;try{lease=mod.acquireSessionLease({sessionFile:\${JSON.stringify(file)},runId:old?'old':'new',sourceRunId:'fixture'});}catch(e){assert.ok(e instanceof mod.SessionLeaseConflictError);const state=mod.inspectSessionLease(\${JSON.stringify(file)});assert.match(e.message,state.state==='unreadable'?/existing lease with unreadable owner metadata/:/already owned/);console.log('REFUSED');clearTimeout(timer);}
	if(lease){console.log('OWNER');await new Promise(resolve=>{const p=\${JSON.stringify(release)},w=fs.watch(\${JSON.stringify(base)},()=>{if(fs.existsSync(p)){w.close();resolve();}});if(fs.existsSync(p)){w.close();resolve();}});assert.equal(lease.release(),true);clearTimeout(timer);}\`);
	const children=['old','new'].map(mode=>{const p=spawn(process.execPath,['--experimental-strip-types',script,mode],{cwd:base,env:{...process.env,PI_SUBAGENTS_EXECUTION_SCOPE:mode==='old'?'':scope},stdio:['ignore','pipe','pipe']});let output='',error='',settled=false;const closed=new Promise(resolve=>p.once('close',resolve));
	const decision=new Promise((resolve,reject)=>{p.stderr.on('data',b=>{error=(error+b).slice(-2000);});p.stdout.on('data',b=>{output+=b;if(!settled&&/OWNER|REFUSED/.test(output)){settled=true;resolve(output.trim());}});p.once('error',reject);p.once('close',()=>{if(!settled)reject(Error(error));});});return {closed,decision};});
	const decisions=await Promise.all(children.map(c=>c.decision));assert.deepEqual(decisions.sort(),['OWNER','REFUSED']);fs.writeFileSync(release,'go');assert.deepEqual(await Promise.all(children.map(c=>c.closed)),[0,0]);
	console.log(JSON.stringify({processes:2,leaseWinners:1}));`);
});
test("base replacement blocks new lease acquisition and release instead of creating a second lock", () => {
	probe(`const {EXECUTION_STORE}=await load('src/shared/types.ts'),n=await load('src/runs/shared/session-lease.ts');const file=path.join(EXECUTION_STORE.root,'session.jsonl');fs.writeFileSync(file,'');
	const lease=n.acquireSessionLease({sessionFile:file,runId:'r',sourceRunId:'source'}),parked=base+'-parked';fs.renameSync(base,parked);fs.mkdirSync(base,{mode:0o700});fs.renameSync(path.join(parked,scope),EXECUTION_STORE.root);fs.renameSync(path.join(parked,'.owned-process-groups-v2.json'),path.join(base,'.owned-process-groups-v2.json'));
	const unavailable=e=>/identity drift/.test(e.message)||(!!EXECUTION_STORE.leaseRoot&&e.code==='ENOENT');assert.throws(()=>lease.release(),unavailable);assert.throws(()=>n.acquireSessionLease({sessionFile:file,runId:'next',sourceRunId:'source'}),unavailable);assert.equal(fs.existsSync(path.join(base,'session-leases')),false);`);
});
