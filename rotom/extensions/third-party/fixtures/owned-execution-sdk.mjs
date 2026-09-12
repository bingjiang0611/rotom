// Real public loader + installed-Pi children, but only local faux inference and fixture files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const config = JSON.parse(fs.readFileSync(process.env.ROTOM_OWNED_FIXTURE, "utf8"));
const { root, source } = config;
const watchdog = setTimeout(() => process.exit(3), 100000);
globalThis.fetch = () => { throw Error("Network forbidden in scoped fixture"); };
const pi = await import(pathToFileURL(config.piEntry));
const ambientMarker = path.join(root,'ambient-extension-loaded');
if (config.usePublicEntry) {
	const extDir = path.join(process.env.PI_CODING_AGENT_DIR,'extensions'); fs.mkdirSync(extDir,{recursive:true});
	fs.writeFileSync(path.join(extDir,'ambient.ts'),`import fs from 'node:fs'; export default api=>{fs.appendFileSync(${JSON.stringify(ambientMarker)},'1');api.registerTool({name:'subagent',label:'Ambient nested fixture',description:'Must not enter scoped children',parameters:{type:'object',properties:{}},execute:async()=>({content:[],details:{}})});};`);
	const ambient = new pi.DefaultResourceLoader({cwd:root,agentDir:process.env.PI_CODING_AGENT_DIR,settingsManager:pi.SettingsManager.inMemory(),noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
	await ambient.reload(); assert.deepEqual(ambient.getExtensions().errors,[]); assert.equal(fs.readFileSync(ambientMarker,'utf8'),'1'); fs.unlinkSync(ambientMarker);
}
const eventBus = pi.createEventBus(); let modules;
eventBus.on("fixture:owned", (value) => { modules = value; });
const entry = path.join(root, "loader.ts");
fs.writeFileSync(entry, `import {createSubagentExecutor} from ${JSON.stringify(path.join(source,"src/runs/foreground/subagent-executor.ts"))};
import {DIRS} from ${JSON.stringify(path.join(source,"src/shared/types.ts"))};
${config.usePublicEntry ? `import {discoverAgents as discoverDeclaredAgents} from ${JSON.stringify(path.join(source,'src/agents/agents.ts'))};` : ''}
${config.expectFlatAdmission ? `import {buildSubagentToolDescription,buildSubagentToolPromptMetadata} from ${JSON.stringify(path.join(source,'src/extension/tool-description.ts'))};` : ''}
${config.expectStoreIsolation || config.expectStoreMismatch ? `import {loadConfig,getConfigPath} from ${JSON.stringify(path.join(source,"src/extension/config.ts"))};` : ''}
import {getActiveAsyncCapacitySnapshot} from ${JSON.stringify(path.join(source,"src/runs/background/active-async-capacity.ts"))};
export default api=>api.events.emit('fixture:owned',{createSubagentExecutor,DIRS,getActiveAsyncCapacitySnapshot${config.usePublicEntry ? ',discoverDeclaredAgents' : ''}${config.expectStoreIsolation || config.expectStoreMismatch ? ',loadConfig,getConfigPath' : ''}${config.expectFlatAdmission ? ',buildSubagentToolDescription,buildSubagentToolPromptMetadata' : ''}});`);
const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: pi.SettingsManager.inMemory(), eventBus,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []); assert.ok(modules);
const { createSubagentExecutor, DIRS, getActiveAsyncCapacitySnapshot: capacity } = modules;
const storeBinding = config.expectStoreIsolation ? JSON.parse(fs.readFileSync(path.join(root, 'runtime/.owned-process-groups-v2.json'))) : undefined;
if (storeBinding) {
	assert.equal(fs.realpathSync(path.dirname(DIRS.async)), storeBinding.root);
	assert.equal(fs.existsSync(path.join(root, 'runtime/async-subagent-runs')), false);
	assert.equal(modules.loadConfig().asyncExecutionScope, 'owned-process-groups-v2');
	const cfg = modules.getConfigPath(); fs.mkdirSync(path.dirname(cfg), { recursive: true });
	for (const body of ['{', JSON.stringify({ asyncExecutionScope: 'future' })]) { fs.writeFileSync(cfg, body, { mode: 0o600 }); assert.throws(() => modules.loadConfig()); }
	fs.unlinkSync(cfg);
}
const program = path.join(root, "external.mjs");
fs.writeFileSync(program, `import fs from 'node:fs';import {spawn} from 'node:child_process';
const [mode,dir,role]=process.argv.slice(2);fs.mkdirSync(dir,{recursive:true});
const deadline=setTimeout(()=>process.exit(3),35000);
if(mode==='normal'){fs.appendFileSync(dir+'/starts','1');process.stdout.write('fixture complete');clearTimeout(deadline);}
else if(mode==='escape'&&role!=='writer'){
 fs.appendFileSync(dir+'/starts','1');spawn(process.execPath,[${JSON.stringify(program)},mode,dir,'writer'],{detached:true,stdio:'ignore'});
 const w=fs.watch(dir,()=>{if(fs.existsSync(dir+'/ready'))process.exit(0);});if(fs.existsSync(dir+'/ready'))process.exit(0);
}else{
 if(role!=='writer')fs.appendFileSync(dir+'/starts','1');
 const w=fs.watch(dir,()=>{if(fs.existsSync(dir+'/release')){fs.writeFileSync(dir+'/marker','written');clearTimeout(deadline);w.close();}});
 fs.writeFileSync(dir+'/ready',String(process.pid));
}`);
const provider = path.join(root, "faux-provider.mjs");
fs.writeFileSync(provider, `import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export default async function(api){globalThis.fetch=()=>{throw Error('network forbidden')};
const {fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall}=await import(pathToFileURL(${JSON.stringify(config.fauxEntry)}));
const f=fauxProvider({provider:'owned-fixture',models:[{id:'child',contextWindow:100000}]});
let wait=false,foregroundMode='',foregroundEscape=false,escapeMode='foreground';api.on('input',e=>{wait=e.text.includes('WAIT_OWNED');escapeMode=e.text.includes('ESCAPE_REVIVAL')?'revival':e.text.includes('ESCAPE_ASYNC')?'async':'foreground';foregroundEscape=e.text.includes('ESCAPE_FOREGROUND')||e.text.includes('ESCAPE_ASYNC')||e.text.includes('ESCAPE_REVIVAL');foregroundMode=e.text.includes('WAIT_FOREGROUND')?(e.text.includes('TIMEOUT')?'timeout':'stop'):'';});
${config.expectForegroundClosure ? `const {Type}=await import(pathToFileURL(${JSON.stringify(config.typeboxEntry)}));api.registerTool({name:'fixture_hold',label:'Fixture hold',description:'Local bounded fixture',parameters:Type.Object({}),async execute(_id,_params,signal){fs.writeFileSync(${JSON.stringify(root)}+'/foreground-ready-'+foregroundMode,String(process.pid));return new Promise(resolve=>{const timer=setInterval(()=>{},250);const done=()=>{clearInterval(timer);resolve({content:[{type:'text',text:'fixture aborted'}],details:{}});};if(signal?.aborted)done();else signal?.addEventListener('abort',done,{once:true});});}});
api.registerTool({name:'fixture_escape',label:'Fixture escape',description:'Local pipe-holding negative control',parameters:Type.Object({}),async execute(){const {spawn}=await import('node:child_process');const dir=${JSON.stringify(root)}+'/'+escapeMode+'-pipe-escape';fs.mkdirSync(dir,{recursive:true});const p=spawn(process.execPath,[${JSON.stringify(program)},'hold',dir,'writer'],{detached:true,stdio:['ignore',1,2]});p.unref();await new Promise(resolve=>{const watch=fs.watch(dir,()=>{if(fs.existsSync(dir+'/ready')){watch.close();resolve();}});if(fs.existsSync(dir+'/ready')){watch.close();resolve();}});return {content:[{type:'text',text:'escaped fixture ready'}],details:{}};}});` : ''}
api.on('session_start',()=>fs.writeFileSync(${JSON.stringify(path.join(root,'pi-process'))},String(process.pid)));
f.setResponses([()=>{fs.appendFileSync(${JSON.stringify(path.join(root,"faux-calls"))},'1');return foregroundEscape
 ? fauxAssistantMessage([fauxToolCall('fixture_escape',{}, {id:'foreground-escape'})],{stopReason:'toolUse'})
 : foregroundMode ? fauxAssistantMessage([fauxToolCall('fixture_hold',{}, {id:'foreground-hold'})],{stopReason:'toolUse'})
 : wait ? fauxAssistantMessage([fauxToolCall('bash',{command:${JSON.stringify(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(program)} hold ${JSON.stringify(path.join(root, 'owner-loss'))}`)},timeout:35},{id:'owned-wait'})],{stopReason:'toolUse'})
 : fauxAssistantMessage([fauxText('PI_FIXTURE_DONE')],{stopReason:'stop'});},()=>fauxAssistantMessage([fauxText('DONE')],{stopReason:'stop'})]);
api.registerProvider(f.provider.id,{name:f.provider.name,api:f.api,apiKey:'fixture-not-a-credential',streamSimple:f.provider.streamSimple,models:[...f.models]});}`);
const { fauxProvider } = await import(pathToFileURL(config.fauxEntry));
const faux = fauxProvider({ provider: "owned-fixture", models: [{ id: "child", contextWindow: 100000 }] });
const models = faux.models.map((m) => ({ ...m, provider: faux.provider.id, api: faux.api, baseUrl: "http://127.0.0.1:1" }));
const agents = [];
function external(name, mode) {
	const dir = path.join(root, name); fs.mkdirSync(dir);
	agents.push({ name, description: "fixture", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false,
		runner: { type: "external-cli", command: process.execPath, args: [program, mode, dir] } });
	return dir;
}
agents.push({ name: "pi", description: "local faux", model: "owned-fixture/child", systemPrompt: "Return the fixture response", systemPromptMode: "replace",
	inheritProjectContext: false, inheritSkills: false, extensions: [], subagentOnlyExtensions: [provider], tools: ["read"] });
if (config.usePublicEntry) {
	const agentDir=path.join(root,'.pi/agents'); fs.mkdirSync(agentDir,{recursive:true});
	fs.writeFileSync(path.join(agentDir,'pi.md'),['---','name: pi','description: local declared fixture','model: owned-fixture/child','tools: read','extensions:',`subagentOnlyExtensions: ${provider}`,'systemPromptMode: replace','inheritProjectContext: false','inheritSkills: false','---','Return the fixture response'].join('\n'));
	const parsed=modules.discoverDeclaredAgents(root,'project').agents.find(a=>a.name==='pi'); assert.ok(parsed); assert.deepEqual(parsed.tools,['read']); assert.deepEqual(parsed.extensions,[]); assert.deepEqual(parsed.subagentOnlyExtensions,[provider]); agents[0]=parsed;
}
const state = { baseCwd: root, currentSessionId: "owned-fixture", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
let onDiscovery = () => {};
const executor = createSubagentExecutor({ pi: { events: { on() { return () => {}; }, emit() {} }, getSessionName: () => undefined }, state,
	config: { maxActiveAsyncRunsPerSession: 1, asyncExecutionScope: "owned-process-groups-v2" }, asyncByDefault: true, tempArtifactsDir: root,
	getSubagentSessionRoot: () => path.join(root, "sessions"), expandTilde: (v) => v, discoverAgents: () => { onDiscovery(); return { agents }; }, allowMutatingManagementActions: true });
let sessionId="owned-fixture";
const ctx = { cwd: root, hasUI: false, ui: {}, model: models[0], sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null }, modelRegistry: { getAvailable: () => models } };
const json = (file) => { try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch (e) { if (e.code === "ENOENT") return; throw e; } };
async function until(read, label) {
	const end = Date.now() + 25000;
	for (;;) { const value = read(); if (value) return value; if (Date.now() >= end) throw Error(`Fixture deadline: ${label}`); await new Promise(r=>setTimeout(r,20)); }
}
const used = () => capacity(sessionId, 1, { liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []) }).used;
const execute = (key, params) => executor[config.usePublicEntry ? 'executePublic' : 'execute'](key, { mission: false, timeoutMs: 25000, ...params }, new AbortController().signal, undefined, ctx);
async function settled(id) {
	const dir=path.join(DIRS.async,id);
	const proof=await until(()=>json(path.join(dir,"process-terminal.json")),"runner proof");
	assert.equal(proof.ownedClosure?.state,"observed",JSON.stringify(proof));
	if (storeBinding) assert.equal(proof.ownedClosure.storeId, storeBinding.storeId);
	if (storeBinding?.sessionRoot) for (const writer of proof.ownedClosure.writers.filter(w => w.kind === 'pi-writer')) {
		assert.equal(writer.sessionLease.state, 'held'); assert.equal(writer.sessionLease.released, true);
		assert.ok(!path.relative(storeBinding.sessionRoot, writer.sessionLease.sessionFile).startsWith('..'));
		assert.equal(fs.existsSync(path.join(storeBinding.leaseRoot, writer.sessionLease.canonicalSessionId)), false);
	}
	return proof;
}
if (config.expectStoreMismatch) {
	assert.equal(modules.loadConfig().asyncExecutionScope, undefined);
	const cfg = modules.getConfigPath(); fs.mkdirSync(path.dirname(cfg), { recursive: true });
	fs.writeFileSync(cfg, JSON.stringify({ asyncExecutionScope: 'owned-process-groups-v2' }), { mode: 0o600 }); assert.throws(() => modules.loadConfig(), /mismatch/); fs.unlinkSync(cfg);
	const dir = external('scope-blocked', 'normal'), receipt = await execute('scope-blocked', { agent: 'scope-blocked', task: 'Must not start', async: true });
	assert.equal(receipt.isError, true); assert.match(JSON.stringify(receipt), /scope\/store mismatch/);
	assert.equal(fs.existsSync(path.join(dir, 'starts')), false); assert.equal(fs.existsSync(DIRS.async), false);
	fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ scopeMismatchRejected: true, writerStarts: 0, remoteModelCalls: 0 }), { mode: 0o600 });
	clearTimeout(watchdog); process.exit(0);
}
if (config.expectFlatAdmission) {
	for (const mode of [undefined,'full','compact','custom']) {
		const setting = mode ? {toolDescriptionMode:mode} : {};
		assert.match(modules.buildSubagentToolDescription(setting), /Scoped first release/);
		assert.match(modules.buildSubagentToolDescription(setting), /never authorizes replay/);
		assert.ok(modules.buildSubagentToolPromptMetadata(setting).promptGuidelines.some(g=>g.includes('unavailable and must be rejected')));
	}
	const guide = await execute('flat-guide',{action:'guide'});assert.notEqual(guide.isError,true,JSON.stringify(guide));assert.match(JSON.stringify(guide.content),/Legacy reference only/);
	const empty = await execute('flat-empty-children',{action:'children.list'});assert.notEqual(empty.isError,true);assert.match(JSON.stringify(empty.content),/Absence is not closure/);assert.doesNotMatch(JSON.stringify(empty.content),/fallback challenge/);
	const dir = external('flat-external', 'normal');
	agents.push({...agents[0], name:'flat-nested', tools:['subagent']});
	agents.push({...agents[0], name:'flat-verify', defaultAcceptance:{level:'verified',verify:[{id:'gate',command:'must-not-run'}]}});
	agents.push({...agents[0], name:'flat-job', runner:{type:'external-job',command:process.execPath}});
	agents.push({...agents[0], name:'flat-sync', defaultAsync:false});
	for (const [name, overrides] of [['implicit-tools',{tools:undefined}],['ambient',{extensions:undefined}],['wildcard',{tools:['subagent*']}],['extension-tool',{tools:[path.join(root,'not-authorized.ts')]}]]) agents.push({...agents[0],name:'flat-'+name,...overrides});
	const cases = [
		{worktree:true}, {isolation:'worktree'}, {gate:'must-not-run'}, {worktree:1},
		{clarify:true}, {foregroundOnly:true}, {async:0}, {async:null},
		{workflowChildAsyncId:'not-owned'}, {workflowKey:'not-owned'}, {workflowParentRunId:'not-owned'},
		{acceptance:{level:'verified',verify:[{id:'v',command:'must-not-run'}]}}, {acceptance:{review:{required:true}}},
		{chain:[{agent:'pi',task:'must-not-run'}]}, {tasks:[{agent:'pi',task:'must-not-run'}]}, {context:'fork'},
		{resume:'missing'}, {agent:'flat-nested'}, {agent:'flat-job'}, {agent:'flat-verify'},
		...['implicit-tools','ambient','wildcard','extension-tool'].map(name=>({agent:'flat-'+name})),
	];
	let directRejected = 0, workflowRejected = 0;
	for (const input of [...cases, {async:false}, {agent:'flat-sync',async:undefined}, {workflowScript:'return 1;',async:false}]) {
		const result = await execute('flat-rejected', {agent:'pi',task:'must-not-run',async:true,...input});
		assert.equal(result.isError,true,JSON.stringify(result)); assert.match(JSON.stringify(result), (input.workflowParentRunId || input.workflowKey) ? /Scoped workflow child requires an in-process admission owner/ : /Scoped first release|foreground.*resume/i); directRejected++;
	}
	const priorDepth = process.env.PI_SUBAGENT_DEPTH;
	try { for (const depth of ['1','invalid']) { process.env.PI_SUBAGENT_DEPTH=depth; const result=await execute('flat-nested',{agent:'pi',task:'must-not-run',async:true});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/nested execution/);directRejected++; } }
	finally { if(priorDepth===undefined)delete process.env.PI_SUBAGENT_DEPTH;else process.env.PI_SUBAGENT_DEPTH=priorDepth; }
	assert.equal(fs.existsSync(DIRS.async),false); assert.equal(used(),0);
	for (const input of cases.filter(p => p.resume === undefined)) {
		const params = {agent:'pi',task:'must-not-run',async:true,...input};
		const receipt = await execute('flat-workflow-rejected',{workflowScript:`return await runs.run("denied",${JSON.stringify(params)});`,async:true});
		assert.notEqual(receipt.isError,true,JSON.stringify(receipt)); const id=receipt.details.asyncId;
		await until(()=>json(path.join(DIRS.results,`${id}.json`))?.state==='failed','unsupported workflow child rejected');
		await until(()=>used()===0,'rejected workflow controller releases empty ownership');
		const owner=json(path.join(DIRS.async,id,'process-terminal-candidate.json')).ownedWorkflow;
		assert.equal(owner.sealed,true);assert.deepEqual(owner.admissions,[]);workflowRejected++;
	}
	const publicDenied = await executor.executePublic('flat-public-denied',{agent:'flat-job',task:'must-not-run',async:true,mission:false},new AbortController().signal,undefined,ctx);
	assert.equal(publicDenied.isError,true);assert.equal(publicDenied.details.asyncId,undefined);directRejected++;
	const changing = {...agents[0], name:'flat-changing'}; agents.push(changing); let discoveryReads=0;
	onDiscovery=()=>{if(++discoveryReads===3)changing.tools=['subagent'];};
	const changed = await execute('flat-config-race',{workflowScript:'return await runs.run("changed",{agent:"flat-changing",task:"must-not-run",async:true});',async:true});
	assert.notEqual(changed.isError,true,JSON.stringify(changed));const changedId=changed.details.asyncId;
	await until(()=>json(path.join(DIRS.results,`${changedId}.json`))?.state==='failed','changed config rejected');
	await until(()=>used()===0,'configuration rejection leaves no unbound admission');onDiscovery=()=>{};
	assert.ok(discoveryReads>=3);assert.deepEqual(json(path.join(DIRS.async,changedId,'process-terminal-candidate.json')).ownedWorkflow.admissions,[]);workflowRejected++;
	assert.equal(fs.existsSync(path.join(root,'pi-process')),false);assert.equal(fs.existsSync(path.join(root,'faux-calls')),false);assert.equal(fs.existsSync(path.join(dir,'starts')),false);
	assert.equal(used(),0);
	const valid=await execute('flat-positive',{agent:'flat-external',task:'local fixture',async:true});assert.notEqual(valid.isError,true,JSON.stringify(valid));await settled(valid.details.asyncId);await until(()=>used()===0,'positive control closure');assert.equal(fs.readFileSync(path.join(dir,'starts'),'utf8'),'1');
	const publicValid = await executor.executePublic('flat-public-positive',{agent:'flat-external',task:'local fixture',async:true,mission:false},new AbortController().signal,undefined,ctx);assert.notEqual(publicValid.isError,true,JSON.stringify(publicValid));const publicId=publicValid.details.asyncId;
	await settled(publicId);await until(()=>used()===0,'public single closure');assert.equal(fs.readFileSync(path.join(dir,'starts'),'utf8'),'11');
	assert.equal(json(path.join(DIRS.async,publicId,'status.json')).mode,'single');assert.equal(json(path.join(DIRS.async,publicId,'process-terminal-candidate.json')).ownedWorkflow,undefined);
	fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({directRejected,workflowRejected,writerStartsBeforePositiveControl:0,capacityAfterRejections:0,positiveControlClosed:true,publicSingleClosed:true,remoteModelCalls:0}),{mode:0o600});clearTimeout(watchdog);process.exit(0);
}
if (config.controllerCrash) {
	const receipt = await execute('controller-crash', { workflowScript: 'emit("OWNER_READY");while(true){}', async: true });
	assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
	await until(() => json(path.join(DIRS.async, receipt.details.asyncId, 'status.json'))?.workflow?.emits?.includes('OWNER_READY'), 'live workflow worker before owner crash');
	const candidate = json(path.join(DIRS.async, receipt.details.asyncId, 'process-terminal-candidate.json'));
	assert.equal(candidate.ownedWorkflow.sealed, false);
	fs.writeFileSync(path.join(root, 'crash.json'), JSON.stringify({ runId: receipt.details.asyncId }), { mode: 0o600 });
	// This is the newly spawned fixture process itself, never a PID from history.
	process.kill(process.pid, 'SIGKILL');
	throw Error('self SIGKILL unexpectedly returned');
}
const evidence = [];
for (const [i, mode] of ["normal", "normal", "normal", "hold", "escape", "timeout"].entries()) {
	const name=`external-${i}`, dir=external(name,mode);
	const receipt=await execute(name,{agent:name,task:"Local fixture",async:true,...(mode==='timeout'?{timeoutMs:4000}:{})});
	if(mode==='timeout')await until(()=>fs.existsSync(path.join(dir,'ready')),'timeout writer ready');
	assert.notEqual(receipt.isError,true,JSON.stringify(receipt)); const id=receipt.details.asyncId; assert.ok(id);
	if(mode==='hold') {
		await until(()=>fs.existsSync(path.join(dir,'ready')),'ready'); assert.equal(used(),1);
		const refused=await execute('over-capacity',{agent:name,task:'must not start',async:true}); assert.equal(refused.isError,true);
		const stopped=await execute('stop',{action:'stop',id}); assert.notEqual(stopped.isError,true);
	}
	const proof=await settled(id); assert.equal(proof.state,'unknown'); assert.equal(proof.reason,'external-descendants-unverified');
	await until(()=>used()===0,'capacity release');
	assert.equal(fs.readFileSync(path.join(dir,'starts'),'utf8'),'1');
	const recovery=await execute('resume',{action:'resume',id,message:'must not run'}); assert.equal(recovery.isError,true);
	assert.equal(fs.readFileSync(path.join(dir,'starts'),'utf8'),'1');
	if(mode==='escape') {
		assert.equal(fs.existsSync(path.join(dir,'marker')),false);fs.writeFileSync(path.join(dir,'release'),'go');
		await until(()=>fs.existsSync(path.join(dir,'marker')),'escapee negative control');
		const pid=Number(fs.readFileSync(path.join(dir,'ready')));
		await until(()=>{const r=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1000});assert.ifError(r.error);return (r.status===1&&!r.stdout.trim()&&!r.stderr.trim())||(r.status===0&&r.stdout.trim().startsWith('Z'));},'escapee exit');
	}
	evidence.push({mode,ownedClosure:proof.ownedClosure.state,graph:proof.state,capacityAfter:used(),recoveryRejected:true});
}
const piOnly=await execute('pi-only',{agent:'pi',task:'local fixture',acceptance:false,async:true});
assert.notEqual(piOnly.isError,true,JSON.stringify(piOnly));
const piProof=await settled(piOnly.details.asyncId);
const piStatus=json(path.join(DIRS.async,piOnly.details.asyncId,'status.json'));
assert.equal(piStatus.state,'complete',JSON.stringify(piStatus.steps.map(s=>({agent:s.agent,error:s.error}))));
assert.ok(piProof.ownedClosure.writers.some(w=>w.kind==='pi-writer'));await until(()=>used()===0,'Pi capacity release');
if (storeBinding) {
	const originalSession = piStatus.sessionFile ?? piStatus.steps[0]?.sessionFile;
	assert.equal(typeof originalSession, 'string'); const originalBytes = fs.readFileSync(originalSession, 'utf8');
	const resumed = await execute('pi-native-resume', { action:'resume', id:piOnly.details.asyncId, message:'New local fixture continuation' });
	assert.notEqual(resumed.isError, true, JSON.stringify(resumed)); assert.ok(resumed.details.asyncId, JSON.stringify(resumed));
	const proof = await settled(resumed.details.asyncId);
	assert.equal(proof.ownedClosure.scope, 'owned-process-groups-v2'); assert.equal(proof.ownedClosure.storeId, storeBinding.storeId);
	const status = json(path.join(DIRS.async, resumed.details.asyncId, 'status.json'));
	assert.equal(status.state, 'complete'); assert.equal(fs.realpathSync(status.sessionFile ?? status.steps[0]?.sessionFile), fs.realpathSync(originalSession));
	const candidate = json(path.join(DIRS.async, resumed.details.asyncId, 'process-terminal-candidate.json'));
	assert.equal(typeof candidate.revivalLeaseToken, 'string'); assert.equal(candidate.revivalLeaseReleaseAcknowledged, true);
	const sessionBytes = fs.readFileSync(originalSession, 'utf8'); assert.ok(sessionBytes.startsWith(originalBytes) && sessionBytes.length > originalBytes.length, 'native continuation must preserve and extend the original session');
	await until(() => used() === 0, 'Pi native resume capacity release');
	evidence.push({mode:'pi-native-resume',capacityAfter:0,storeBound:true,canonicalSessionPreserved:true,leaseReleaseAcknowledged:true});
}
const mixedDir=external('mixed-external','hold');
const parent=await execute('mixed-workflow',{workflowScript:'return await runs.all([{key:"pi",agent:"pi",task:"local fixture",acceptance:false,async:true},{key:"ext",agent:"mixed-external",task:"local fixture",async:true}]);',async:true});
assert.notEqual(parent.isError,true,JSON.stringify(parent));const parentId=parent.details.asyncId;
const result=await until(()=>{const r=json(path.join(DIRS.results,`${parentId}.json`));return r?.state==='complete'&&r;},'parent result');
await until(()=>fs.existsSync(path.join(mixedDir,'ready')),'mixed writer ready');
assert.equal(used(),1,'parent result is not a child closure barrier');
if (config.expectWorkflowClosure) {
	const forged = await execute('forged-workflow-parent', { agent:'mixed-external', task:'must not start', async:true, workflowParentRunId:parentId, workflowKey:'unregistered' });
	assert.equal(forged.isError, true); assert.match(JSON.stringify(forged.content), /in-process admission owner/);
	assert.equal(fs.readFileSync(path.join(mixedDir,'starts'),'utf8'), '1');
}
fs.writeFileSync(path.join(mixedDir,'release'),'go');
const children=result.results.map(r=>r.runId);assert.equal(children.length,2);
const proofs=await Promise.all(children.map(settled));
for(const id of children){const status=json(path.join(DIRS.async,id,'status.json'));assert.equal(status.state,'complete',JSON.stringify({state:status.state,error:status.error,steps:status.steps.map(s=>({agent:s.agent,error:s.error}))}));}
assert.ok(proofs.some(p=>p.ownedClosure.writers.some(w=>w.kind==='pi-writer')),'actual shared Pi writer path covered');
assert.ok(proofs.some(p=>p.ownedClosure.writers.some(w=>w.kind==='external-cli')));
if (config.expectWorkflowClosure) {
	const owned = await until(() => { const value=json(path.join(DIRS.async,parentId,'process-terminal-candidate.json'))?.ownedWorkflow; return value?.sealed && value; }, 'actual controller exit and host drain');
	assert.equal(owned.admissions.length, 2);
	for (const proof of proofs) {
		const parent = proof.ownedClosure.workflowParent;
		assert.equal(parent.workflowRunId, parentId); assert.equal(parent.controllerInstanceId, owned.controllerInstanceId);
		assert.ok(owned.admissions.some(a => a.admissionId === parent.admissionId && a.childRunId === proof.runId));
	}
	await until(() => used() === 0, 'bound workflow closure release');
	const callsBefore = fs.readFileSync(path.join(root,'faux-calls'),'utf8');
	for (const id of children) {
		const blocked = await execute('child-alias-resume', { action:'resume', id, message:'must not bypass parent fence' });
		assert.equal(blocked.isError, true);
		const externalChild = proofs.find(p => p.runId === id).ownedClosure.writers.some(w => w.kind === 'external-cli');
		assert.match(JSON.stringify(blocked.content), config.expectForegroundClosure ? /Owned workflow child recovery/ : externalChild ? /External runners do not persist Pi sessions and cannot be resumed/ : /Owned workflow child recovery/);
	}
	assert.equal(fs.readFileSync(path.join(root,'faux-calls'),'utf8'), callsBefore);
	assert.equal(fs.readFileSync(path.join(mixedDir,'starts'),'utf8'), '1');
} else assert.equal(used(),1,'child proofs alone do not establish a sealed workflow/controller roster');
assert.equal((await execute('mixed-resume',{action:'resume',id:parentId,message:'must not replay'})).isError,true);
assert.ok(fs.readFileSync(path.join(root,'faux-calls'),'utf8').length>0);
evidence.push({mode:'mixed-workflow',children:2,capacityHeldWhileChildRunning:true,capacityAfter:used(),fauxCalls:fs.readFileSync(path.join(root,'faux-calls'),'utf8').length});
if (config.usePublicEntry) {
	const listing = await execute('flat-retained-children',{action:'children.list'}); assert.notEqual(listing.isError,true);
	assert.match(JSON.stringify(listing.content),/Scoped workflow child recovery is unavailable/);
	assert.doesNotMatch(JSON.stringify(listing.content),/resumability: resumable|fallback challenge/);
}
if (config.expectWorkflowClosure) {
	for (let sequence = 0; sequence < (config.expectForegroundClosure ? 2 : 1); sequence++) {
	const foreground = await execute(`foreground-workflow-${sequence}`, { workflowScript: 'return await runs.run("pi",{agent:"pi",task:"local fixture",acceptance:false});', async: true });
	assert.notEqual(foreground.isError, true, JSON.stringify(foreground));
	const foregroundId = foreground.details.asyncId;
	await until(() => json(path.join(DIRS.results, `${foregroundId}.json`))?.state === 'complete', 'real foreground child complete');
	const unsupported = await until(() => { const p = json(path.join(DIRS.async,foregroundId,'process-terminal-candidate.json'))?.ownedWorkflow;return p?.sealed && p; }, 'foreground controller exit');
	assert.equal(unsupported.admissions.length, 1);
	if (config.expectForegroundClosure) {
		const child = unsupported.admissions[0]; assert.equal(child.kind, 'foreground'); assert.ok(child.childRunId);
		await until(() => used() === 0, 'foreground controller, actual writers and session leases close');
		const proof = json(path.join(DIRS.async, child.childRunId, 'process-terminal-candidate.json')).ownedForeground;
		assert.ok(proof.pipelineClosedAt && proof.hostReturnedAt); assert.equal(proof.writers.length, 1);
		assert.equal(proof.writers[0].leaseReleased, true); assert.equal(proof.writers[0].close.processTree.state, 'observed');
		assert.equal(proof.descendantCoverage, 'unverified'); assert.equal(proof.effectVerification, 'unverified');
		const before = fs.readFileSync(path.join(root, 'faux-calls'), 'utf8');
		for (const target of [{id:child.childRunId},{id:child.childRunId.slice(0,8)},{dir:path.join(DIRS.async,child.childRunId)}]) {
			for (const action of ['resume','steer']) {
				const blocked = await execute('foreground-alias', {action,...target,message:'must not replay'});
				assert.equal(blocked.isError, true); assert.match(JSON.stringify(blocked.content), /Owned foreground workflow child recovery/);
			}
		}
		assert.equal(fs.readFileSync(path.join(root, 'faux-calls'), 'utf8'), before);
		// Fault injection only after this fixture's owned processes/leases closed.
		fs.unlinkSync(path.join(DIRS.async,child.childRunId,'process-terminal-candidate.json'));
		fs.unlinkSync(path.join(DIRS.async,foregroundId,'process-terminal-candidate.json'));
		fs.unlinkSync(path.join(DIRS.async,foregroundId,'status.json'));
		const resultOnly = await execute('foreground-result-only',{action:'resume',id:child.childRunId,message:'must not recreate a writer'});
		assert.equal(resultOnly.isError,true);assert.match(JSON.stringify(resultOnly.content),/Owned workflow child recovery/);
		assert.equal(fs.readFileSync(path.join(root, 'faux-calls'), 'utf8'), before);
	} else {
		assert.equal(unsupported.admissions[0].childRunId, undefined);
		assert.equal(used(), 1, 'foreground result has no scoped async writer closure proof');
	}
	}
	evidence.push({mode:'foreground-workflow',capacityAfter:used(),controllerSealed:true,childBindingUnavailable:!config.expectForegroundClosure,independentRuns:config.expectForegroundClosure ? 2 : 1});
}
if (config.expectForegroundClosure) {
	agents.push({...agents.find(a=>a.name==='pi'),name:'pi-foreground-hold',tools:['fixture_hold']});
	for (const mode of ['stop','timeout']) {
		const receipt = await execute(`foreground-${mode}`, {workflowScript:`return await runs.run("pi",{agent:"pi-foreground-hold",task:"WAIT_FOREGROUND_${mode.toUpperCase()}",acceptance:false});`,async:true,timeoutMs:mode==='timeout'?7000:25000});
		assert.notEqual(receipt.isError,true,JSON.stringify(receipt)); const id=receipt.details.asyncId;
		const ready = path.join(root,`foreground-ready-${mode}`);
		await until(()=>fs.existsSync(ready),`foreground ${mode} tool ready`); assert.equal(used(),1);
		if(mode==='stop') assert.notEqual((await execute('stop-foreground',{action:'stop',id})).isError,true);
		await until(()=>used()===0,`foreground ${mode} owned closure`);
		const parent=json(path.join(DIRS.async,id,'process-terminal-candidate.json')).ownedWorkflow;
		assert.equal(parent.sealed,true); const child=parent.admissions[0]; assert.equal(child.kind,'foreground');
		const proof=json(path.join(DIRS.async,child.childRunId,'process-terminal-candidate.json')).ownedForeground;
		assert.ok(proof.pipelineClosedAt && proof.hostReturnedAt); assert.equal(proof.writers.length,1);
		assert.equal(proof.writers[0].leaseReleased,true);assert.equal(proof.writers[0].close.processTree.state,'observed');
		assert.equal(proof.writers[0].close.processTree.processGroupId,Number(fs.readFileSync(ready)));
		evidence.push({mode:`foreground-${mode}`,capacityAfter:used(),controllerSealed:true,taskResult:json(path.join(DIRS.async,id,'status.json')).state});
	}
	agents.push({...agents.find(a=>a.name==='pi'),name:'pi-foreground-escape',tools:['fixture_escape']});
	const escaped = await execute('foreground-pipe-escape',{workflowScript:'return await runs.run("pi",{agent:"pi-foreground-escape",task:"ESCAPE_FOREGROUND",acceptance:false});',async:true});
	assert.notEqual(escaped.isError,true,JSON.stringify(escaped)); const escapedId=escaped.details.asyncId;
	await until(()=>json(path.join(DIRS.results,`${escapedId}.json`))?.state==='complete','foreground pipe escape task result');
	const owned=await until(()=>{const p=json(path.join(DIRS.async,escapedId,'process-terminal-candidate.json'))?.ownedWorkflow;return p?.sealed && p;},'pipe escape controller sealed');
	const proof=json(path.join(DIRS.async,owned.admissions[0].childRunId,'process-terminal-candidate.json')).ownedForeground;
	assert.ok(proof.pipelineClosedAt && proof.hostReturnedAt);assert.equal(proof.writers.length,1);assert.equal(proof.writers[0].close,undefined);
	assert.equal(used(),1,'forced stdio cannot create a direct close proof');
	const dir=path.join(root,'foreground-pipe-escape');assert.equal(fs.existsSync(path.join(dir,'marker')),false);
	fs.writeFileSync(path.join(dir,'release'),'go');await until(()=>fs.existsSync(path.join(dir,'marker')),'escaped writer late effect');
	const pid=Number(fs.readFileSync(path.join(dir,'ready')));
	await until(()=>{const r=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1000});assert.ifError(r.error);return(r.status===1&&!r.stdout.trim()&&!r.stderr.trim())||(r.status===0&&r.stdout.trim().startsWith('Z'));},'pipe escapee exit');
	assert.equal(used(),1,'later exit does not backfill a previously lost close observation');
	evidence.push({mode:'foreground-pipe-escape',capacityAfter:used(),forcedStdioNotClosure:true,lateEscapeEffectObserved:true});
}
if (config.expectSessionIsolation) {
	assert.equal(typeof storeBinding?.sessionRoot, 'string');
	// Independent fixture session; no fenced run is retried or rebound.
	for (const mode of ['async', 'revival']) {
	sessionId = `owned-${mode}-escape-fixture`; state.currentSessionId = sessionId; assert.equal(used(), 0);
	let receipt = await execute(`${mode}-pipe-escape`, {agent:'pi-foreground-escape', task:mode === 'async' ? 'ESCAPE_ASYNC' : 'local fixture', acceptance:false, async:true});
	assert.notEqual(receipt.isError, true, JSON.stringify(receipt));
	if (mode === 'revival') { await settled(receipt.details.asyncId); await until(() => used() === 0, 'revival baseline closed'); receipt = await execute('revival-pipe-escape', {action:'resume',id:receipt.details.asyncId,message:'ESCAPE_REVIVAL'}); assert.notEqual(receipt.isError,true,JSON.stringify(receipt)); }
	const id = receipt.details.asyncId;
	const terminal = await until(() => json(path.join(DIRS.async, id, 'process-terminal.json')), 'async pipe escape terminal');
	assert.equal(terminal.ownedClosure.state, 'unknown'); assert.equal(used(), 1);
	const writer = json(path.join(DIRS.async, id, 'process-terminal-candidate.json')).ownedExecution.writers[0];
	assert.equal(writer.close, undefined); assert.notEqual(writer.sessionLease.released, true);
	const leaseFile = path.join(storeBinding.leaseRoot, writer.sessionLease.canonicalSessionId, 'owner.json'); assert.equal(json(leaseFile).version, 2);
	const dir = path.join(root, `${mode}-pipe-escape`); assert.equal(fs.existsSync(path.join(dir, 'marker')), false);
	fs.writeFileSync(path.join(dir, 'release'), 'go'); await until(() => fs.existsSync(path.join(dir, 'marker')), 'async pipe escape late effect');
	const pid = Number(fs.readFileSync(path.join(dir, 'ready')));
	await until(() => { const r = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding:'utf8',timeout:1000}); assert.ifError(r.error); return (r.status === 1 && !r.stdout.trim() && !r.stderr.trim()) || (r.status === 0 && r.stdout.trim().startsWith('Z')); }, 'async pipe escape exit');
	assert.equal(used(), 1); assert.equal(json(leaseFile).version, 2);
	evidence.push({mode:`${mode}-pipe-escape`,capacityAfter:1,opaqueLeaseRetained:true,forcedStdioNotClosure:true,lateEscapeEffectObserved:true});
	}
}
// A killed runner leaves an unsealed roster. The fresh fd-3 lifeline must abort
// the real Pi/Bash child; missing runner finalization must still retain capacity.
// Independent fixture session, not a retry of the fenced workflow. Any retained
// reservation stays untouched; all observed children above have closed.
sessionId='owned-loss-fixture';state.currentSessionId=sessionId;assert.equal(used(),0);
const lossDir=path.join(root,'owner-loss');fs.mkdirSync(lossDir);
agents.push({...agents.find(a=>a.name==='pi'),name:'pi-wait',tools:['bash']});
const lost=await execute('owner-loss',{agent:'pi-wait',task:'WAIT_OWNED',acceptance:false,async:true});
assert.notEqual(lost.isError,true,JSON.stringify(lost));const lostId=lost.details.asyncId;
await until(()=>fs.existsSync(path.join(lossDir,'ready')),'Pi bash writer ready');
const lostStatus=json(path.join(DIRS.async,lostId,'status.json'));
let lostLeaseFile;
if (storeBinding?.sessionRoot) {
	const writer = json(path.join(DIRS.async, lostId, 'process-terminal-candidate.json')).ownedExecution.writers.find(w => w.kind === 'pi-writer');
	assert.equal(writer.sessionLease.state, 'held'); assert.ok(!path.relative(storeBinding.sessionRoot, writer.sessionLease.sessionFile).startsWith('..'));
	lostLeaseFile = path.join(storeBinding.leaseRoot, writer.sessionLease.canonicalSessionId, 'owner.json');
	const owner = json(lostLeaseFile); assert.equal(owner.version, 2); assert.equal(owner.storeId, storeBinding.storeId); assert.equal(owner.writerState, 'running');
	assert.equal(fs.existsSync(path.join(root, 'sessions')), false, 'scoped writers must not use the injected legacy session root');
}
const command=spawnSync('ps',['-p',String(lostStatus.pid),'-o','command='],{encoding:'utf8',timeout:1000});
assert.ifError(command.error);assert.equal(command.status,0);assert.ok([source,fs.realpathSync(source)].some(p=>command.stdout.includes(path.join(p,'src/runs/background/subagent-runner.ts')))&&command.stdout.includes(lostId),'exact fixture runner identity required');
process.kill(lostStatus.pid,'SIGKILL');
const lostProof=await until(()=>json(path.join(DIRS.async,lostId,'process-terminal.json')),'owner-loss unknown proof');
assert.equal(lostProof.ownedClosure.state,'unknown');assert.equal(used(),1);
for(const pid of [Number(fs.readFileSync(path.join(lossDir,'ready'))),Number(fs.readFileSync(path.join(root,'pi-process')))]){
 await until(()=>{const r=spawnSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1000});assert.ifError(r.error);return(r.status===1&&!r.stdout.trim()&&!r.stderr.trim())||(r.status===0&&r.stdout.trim().startsWith('Z'));},'lifeline child exit');
}
fs.writeFileSync(path.join(lossDir,'release'),'go');assert.equal(fs.existsSync(path.join(lossDir,'marker')),false);
if (lostLeaseFile) assert.equal(json(lostLeaseFile).version, 2, 'owner loss must retain the opaque lease even after controlled children exit');
evidence.push({mode:'owner-loss',ownedClosure:'unknown',capacityAfter:used(),controlledChildrenExited:true});
if (config.usePublicEntry) assert.equal(fs.existsSync(ambientMarker),false,'explicit scoped child extensions must not discover ambient nested tools');
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({evidence,remoteModelCalls:0,...(config.usePublicEntry?{ambientExtensionsExcluded:true}: {})}),{mode:0o600});
clearTimeout(watchdog);
