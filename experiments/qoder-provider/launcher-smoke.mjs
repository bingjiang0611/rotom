// Real installed npm bin, isolated synthetic business project and HOME.
// Explicit authorization + existing shared 30-request ledger required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath, lstat, writeFile, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
const [work] = process.argv.slice(2);
if (!work || !isAbsolute(work) || await realpath(work) !== work) throw new Error('Canonical isolated install work required');
const launcher = join(work,'prefix/bin/rotom');
assert.ok((await lstat(launcher)).isSymbolicLink());
const installed = await realpath(launcher);
assert.ok(installed.endsWith('/node_modules/rotom/bin/rotom'));
const pkg = JSON.parse(await readFile(join(installed,'../../package.json'),'utf8'));
assert.equal(pkg.name,'rotom');
const ledger = process.env.ROTOM_QODER_PROBE_LEDGER, authDir = process.env.ROTOM_QODER_AUTH_DIR;
assert.ok(ledger && authDir && await realpath(authDir) === authDir);
const preload = await realpath(new URL('./live-budget.mjs',import.meta.url));
const cwd = join(work,'business');
const env = {PATH:`${work}/bin:/usr/bin:/bin`,HOME:join(work,'home'),PI_OFFLINE:'1',ROTOM_QODER:'1',ROTOM_QODER_AUTH_DIR:authDir,ROTOM_QODER_PROBE_LEDGER:ledger,NODE_OPTIONS:`--import=${preload}`};
for(const model of ['lite','performance']) {
  const marker=`INSTALLED_${randomUUID()}`;
  await writeFile(join(cwd,'synthetic-marker.txt'),marker,{mode:0o600});
  const before=Number(await readFile(ledger,'utf8'));
  const result=spawnSync(launcher,['--no-session','--no-context-files','--no-approve','--system-prompt','You are a synthetic protocol test assistant. Follow instructions exactly.','--provider','qoder-experimental','--model',model,'--thinking','off','--tools','read','--mode','json','--print','Use read exactly once to read synthetic-marker.txt in the current directory. Then reply with exactly the file contents. Do not use another tool.'],{cwd,env,encoding:'utf8',timeout:150000,maxBuffer:2*1024*1024});
  const summary={model,installedBin:true,exit:result.status,dispatches:Number(await readFile(ledger,'utf8'))-before,cost:'unknown'};
  // Stable codes only; never persist stdout/stderr or model/tool contents.
  summary.qoderErrors=[...new Set([...result.stdout.matchAll(/Qoder: ([a-z0-9_]+)/g)].map(m=>m[1]))];
  try {
    assert.equal(result.status,0);
    const events=result.stdout.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
    summary.eventTypes=[...new Set(events.map(e=>e.type))];
    const messages=events.filter(e=>e.type==='message_end').map(e=>e.message);
    summary.stopReasons=messages.filter(m=>m.role==='assistant').map(m=>m.stopReason);
    const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content.filter(c=>c.type==='toolCall'));
    assert.equal(calls.length,1);assert.equal(calls[0].name,'read');
    const final=messages.filter(m=>m.role==='assistant').at(-1);
    assert.equal(final.stopReason,'stop');assert.equal(final.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim(),marker);
    assert.equal(summary.dispatches,2);summary.pass=true;
  } catch {summary.pass=false;summary.errorCode=result.error?'process_failed':'assertion_failed';process.exitCode=1;}
  console.log(JSON.stringify(summary));
  if(!summary.pass)break;
}
