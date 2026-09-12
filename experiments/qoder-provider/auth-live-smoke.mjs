// Explicit isolated live login/refresh. No global/CLI credential writes, no model calls.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,lstatSync,realpathSync,existsSync,openSync,closeSync,fsyncSync,constants} from 'node:fs';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createQoderProvider,PROVIDER_ID} from '../../rotom/extensions/qoder/provider.mjs';
import {createRefreshGuard} from '../../rotom/extensions/qoder/refresh-guard.mjs';
assert.deepEqual(process.argv.slice(2),['--live']);
assert(process.env.ROTOM_QODER_PROBE_OAUTH==='1'&&process.execArgv.some(a=>a.endsWith('live-budget.mjs')));
const ledger=process.env.ROTOM_QODER_PROBE_LEDGER,dir=process.env.ROTOM_QODER_PROBE_ISOLATED_AUTH_DIR,entry=process.env.ROTOM_PI;
assert(dirname(dir)===dirname(ledger)&&/^isolated-auth(?:-[1-9][0-9]?)?$/.test(basename(dir))&&realpathSync(dir)===dir&&(lstatSync(dir).mode&0o077)===0);
assert(isAbsolute(entry)&&realpathSync(entry)===entry&&lstatSync(entry).isFile());
const existing=process.env.ROTOM_QODER_PROBE_AUTH_FILE;
assert(existing&&realpathSync(existing)===existing&&lstatSync(existing).isFile()&&(lstatSync(existing).mode&0o077)===0);
const authPath=join(dir,'auth.json');assert(existing!==authPath&&!existsSync(authPath));
const hash=()=>createHash('sha256').update(readFileSync(existing)).digest('hex'),beforeHash=hash(),before=Number(readFileSync(ledger,'utf8'));
const original=JSON.parse(readFileSync(existing,'utf8'))[PROVIDER_ID];assert(original?.type==='oauth');
const once=openSync(join(dir,'login-started'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);fsyncSync(once);closeSync(once);
const piAI=await import(import.meta.resolve('@earendil-works/pi-ai',pathToFileURL(entry).href));
const openAI=await import(import.meta.resolve('@earendil-works/pi-ai/api/openai-completions',pathToFileURL(entry).href));
const pi=await import(import.meta.resolve('@earendil-works/pi-coding-agent',pathToFileURL(entry).href));
const counts={polls:0,profiles:0,refreshes:0};const report={pass:false,phase:'starting'};
function save(){writeFileSync(join(dir,'result.json'),JSON.stringify({...report,...counts,requests:Number(readFileSync(ledger,'utf8'))-before,existingCredentialFileUnchanged:hash()===beforeHash}),{mode:0o600});}
async function runtime(){
  const provider=await createQoderProvider({piAI,openAI,authMode:'browser',getCredential:()=>assert.fail('CLI access forbidden'),fetchImpl:()=>assert.fail('model/catalog calls forbidden'),oauthOptions:{claimRefresh:createRefreshGuard(dir),fetchImpl:(url,init)=>{
    const u=new URL(url);assert.equal(u.origin,'https://openapi.qoder.sh');
    if(u.pathname==='/api/v1/deviceToken/poll')counts.polls++;
    else if(u.pathname==='/api/v1/userinfo')counts.profiles++;
    else if(u.pathname==='/api/v1/deviceToken/refresh'){counts.refreshes++;assert.equal(counts.refreshes,1);}
    else assert.fail('auth scope');
    return fetch(url,init);
  }}});
  const r=await pi.ModelRuntime.create({authPath,modelsPath:null,modelsStorePath:null,refreshOnCreate:false});r.registerNativeProvider(provider);return r;
}
try{
  const first=await runtime();
  await first.login(PROVIDER_ID,'oauth',{notify:e=>{
    if(e.type==='auth_url'){writeFileSync(join(dir,'login-url'),e.url,{flag:'wx',mode:0o600});report.phase='awaiting_browser';save();}
  },prompt:()=>assert.fail('interactive secrets belong in browser')});
  assert((lstatSync(authPath).mode&0o077)===0);const logged=JSON.parse(readFileSync(authPath,'utf8'))[PROVIDER_ID];
  assert.equal(logged.uid,original.uid);assert.equal(logged.org,original.org);assert.notEqual(logged.machineId,original.machineId);
  report.login=true;report.sameAccount=true;report.isolatedMachine=true;report.phase='login_persisted';save();
  // Force expiry only in this newly authorized isolated store. This exercises a
  // real upstream refresh, not natural expiry or an existing user's credential.
  const data=JSON.parse(readFileSync(authPath,'utf8'));data[PROVIDER_ID].expires=0;
  const fd=openSync(authPath,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);try{writeFileSync(fd,JSON.stringify(data));fsyncSync(fd);}finally{closeSync(fd);}
  const second=await runtime();await Promise.all([second.getAuth(PROVIDER_ID),second.getAuth(PROVIDER_ID)]);
  const refreshed=JSON.parse(readFileSync(authPath,'utf8'))[PROVIDER_ID];
  assert.equal(counts.refreshes,1);assert.notEqual(refreshed.refresh,logged.refresh);assert.equal(refreshed.fingerprint,logged.fingerprint);assert(refreshed.expires>Date.now());
  const third=await runtime();assert(await third.getAuth(PROVIDER_ID));assert.equal(counts.refreshes,1);
  report.serializedRefresh=true;report.diskResume=true;report.forcedIsolatedExpiry=true;report.phase='complete';report.pass=hash()===beforeHash;
}catch(e){report.errorCode=typeof e.code==='string'&&/^[a-z_]+$/.test(e.code)?e.code:'auth_unproven';report.phase='stopped';process.exitCode=1;}
save();console.log(JSON.stringify({pass:report.pass,phase:report.phase,...counts}));
