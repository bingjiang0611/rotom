import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {packageRoot, repoRoot, manifest, privateOutput, payloadFiles, copyPayload, sourceDigest} from './source.mjs';

export function checkLock(root = packageRoot) {
 const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'))), lock = JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));
 assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
 assert.equal(lock.packages[''].version, pkg.version);
 assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
 assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
 for (const [name, version] of Object.entries(pkg.dependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/); const dep = lock.packages['node_modules/'+name];
  assert.equal(dep.version, version); assert.match(dep.integrity, /^sha512-/); assert.match(dep.resolved, /^https:\/\/registry\.npmjs\.org\//);
 }
}
export function checkPackList(packed, expected) {
 assert.deepEqual(packed.files.map(f=>f.path).sort(), [...expected].sort(), 'Packed file set differs from reviewed payload');
}
export function pack(requested) {
 const output = privateOutput(requested); checkLock();
 const pkg = manifest(), filename = `${pkg.name}-${pkg.version}.tgz`, artifact = path.join(output, filename), receipt = artifact+'.json';
 assert.ok(!fs.existsSync(artifact) && !fs.existsSync(receipt), 'Refusing to overwrite release evidence');
 const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rotom-subagents-pack-'))), stage = copyPayload(path.join(work,'package'));
 const home = path.join(work,'home'); fs.mkdirSync(home,{mode:0o700});
 for (const n of ['user.npmrc','global.npmrc']) fs.writeFileSync(path.join(home,n),'',{mode:0o600});
 const env = {PATH:process.env.PATH,HOME:home,NPM_CONFIG_CACHE:path.join(work,'cache'),NPM_CONFIG_USERCONFIG:path.join(home,'user.npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(home,'global.npmrc')};
 const run = (cmd,args,cwd=stage) => {
  const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  assert.ifError(r.error); assert.equal(r.status,0,r.stderr||r.stdout); return r.stdout;
 };
 const expected=payloadFiles(stage);
 const [preview]=JSON.parse(run('npm',['pack','--offline','--ignore-scripts','--dry-run','--json'])); checkPackList(preview,expected);
 assert.equal(preview.filename,filename);
 const [packed]=JSON.parse(run('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',work])); checkPackList(packed,expected);
 const built=path.join(work,filename);
 const audit=JSON.parse(run('python3',['-I',path.join(repoRoot,'scripts/audit-public.py'),'--root',repoRoot,'--artifact',built]));
 assert.equal(audit.status,'PASS');
 // Only audited complete bytes reach the delivery directory. COPYFILE_EXCL
 // handles a competing publisher without overwriting an existing identity.
 fs.copyFileSync(built,artifact,fs.constants.COPYFILE_EXCL); fs.chmodSync(artifact,0o600);
 const bytes=fs.readFileSync(artifact), result={artifact,version:pkg.version,...sourceDigest(stage),sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),bytes:bytes.length,files:expected.length,published:false,audit};
 fs.writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 assert.equal(process.argv.length,3,'Usage: npm run pack:release -- /absolute/private/output');
 console.log(JSON.stringify(pack(process.argv[2]),null,2));
}
