// Completion previews: bounded text into the parent, the full text in a private file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {probePiVersion} from '../../../rotom/runtime/verify-pi-runtime.mjs';
import {snapshot} from '../scripts/source.mjs';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-notify-unit-')));
const source=snapshot(root),load=file=>import(pathToFileURL(path.join(source,file)));
const pi=await probePiVersion({executable:process.env.ROTOM_PI??process.env.ROTOM_VERIFIED_PI_EXECUTABLE});
const parentURL=pathToFileURL(path.join(pi.packageRoot,'package.json')).href;
registerHooks({resolve(specifier,ctx,next){return next(specifier,specifier.startsWith('@earendil-works/')?{...ctx,parentURL}:ctx)}});
const base=path.join(root,'store');
const {initializeExecutionStore}=await load('src/shared/execution-store.ts');
initializeExecutionStore(base);
Object.assign(process.env,{HOME:root,PI_SUBAGENTS_TEMP_ROOT:base,PI_SUBAGENTS_EXECUTION_SCOPE:'owned-process-groups-v2'});
const {EXECUTION_STORE}=await load('src/shared/types.ts');
const {boundCompletionPreview,buildCompletionDetails,formatSingleCompletion,parseSubagentNotifyContent,COMPLETION_PREVIEW_MAX_BYTES,COMPLETION_OUTPUT_RETENTION_MS}=await load('src/runs/background/notify.ts');

test('short completions pass through unchanged and write no file',()=>{
 const dir=path.join(root,'short');
 assert.equal(boundCompletionPreview('done',  'r1',{outputDir:dir}),'done');
 const exact='x'.repeat(COMPLETION_PREVIEW_MAX_BYTES);
 assert.equal(boundCompletionPreview(exact,'r1',{outputDir:dir}),exact);
 assert.equal(fs.existsSync(dir),false);
});

test('long completions keep head and tail, mark incompleteness and save the full text privately',()=>{
 const dir=path.join(root,'long');
 const full=`HEAD-${'a'.repeat(20000)}${'é'.repeat(3000)}-TAIL`;
 const preview=boundCompletionPreview(full,'run/../id',{outputDir:dir});
 assert.ok(Buffer.byteLength(preview,'utf8')<COMPLETION_PREVIEW_MAX_BYTES+600,'preview stays near the bound');
 assert.ok(preview.startsWith('HEAD-'));
 assert.ok(preview.endsWith('-TAIL'));
 assert.doesNotMatch(preview,/�/u,'multi-byte characters are not split');
 assert.match(preview,/This is not the complete result/u);
 const saved=preview.match(/saved at (\S+);/u)?.[1];
 assert.ok(saved,'preview names the saved file');
 assert.equal(path.dirname(saved),dir);
 assert.doesNotMatch(path.basename(saved),/[\/\\]/u,'run id cannot introduce a path separator');
 assert.equal(fs.readFileSync(saved,'utf8'),full);
 assert.equal(fs.statSync(saved).mode&0o777,0o600);
 assert.equal(fs.statSync(dir).mode&0o777,0o700);
});

test('an unwritable destination still bounds the text and says the full output is unavailable',()=>{
 const target=path.join(root,'elsewhere');fs.mkdirSync(target);
 const link=path.join(root,'link');fs.symlinkSync(target,link);
 const preview=boundCompletionPreview('z'.repeat(20000),'r2',{outputDir:link});
 assert.match(preview,/could not be saved/u);
 assert.deepEqual(fs.readdirSync(target),[]);
 assert.ok(Buffer.byteLength(preview,'utf8')<COMPLETION_PREVIEW_MAX_BYTES+600);
});

test('completion details default to the private execution store and stay parseable',()=>{
 const details=buildCompletionDetails({id:'abc',agent:'scout',success:true,summary:'y'.repeat(30000)});
 assert.equal(details.status,'completed');
 const saved=details.resultPreview.match(/saved at (\S+);/u)?.[1];
 assert.ok(saved?.startsWith(path.join(EXECUTION_STORE.root,'completion-output')+path.sep));
 const parsed=parseSubagentNotifyContent(formatSingleCompletion(details));
 assert.equal(parsed.agent,'scout');
 assert.match(parsed.resultPreview,/not the complete result/u);
 const paused=buildCompletionDetails({id:'p',agent:'worker',success:false,exitCode:1,summary:`Paused after interrupt. ${'q'.repeat(30000)}`});
 assert.equal(paused.status,'paused','status is derived from the raw summary');
});

test('saving a full output prunes saved files older than the retention window, and nothing else',()=>{
 const dir=path.join(root,'retention');fs.mkdirSync(dir,{mode:0o700});
 const now=Date.now(),old=path.join(dir,'old.md'),fresh=path.join(dir,'fresh.md'),other=path.join(dir,'keep.txt'),linked=path.join(dir,'link.md');
 for(const file of [old,fresh,other])fs.writeFileSync(file,'x');
 const outside=path.join(root,'outside.md');fs.writeFileSync(outside,'x');fs.symlinkSync(outside,linked);
 const past=(now-COMPLETION_OUTPUT_RETENTION_MS-60000)/1000;
 for(const file of [old,other,outside])fs.utimesSync(file,past,past);
 fs.lutimesSync(linked,past,past);
 boundCompletionPreview('w'.repeat(20000),'r3',{outputDir:dir,now:()=>now});
 assert.equal(fs.existsSync(old),false,'expired saved output is removed');
 assert.ok(fs.existsSync(fresh));assert.ok(fs.existsSync(other),'non-.md files are not touched');
 assert.ok(fs.lstatSync(linked).isSymbolicLink(),'links are never followed or removed');assert.ok(fs.existsSync(outside));
});
