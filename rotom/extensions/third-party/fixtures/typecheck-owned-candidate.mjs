// Maintenance-only: bind the compiler input set to the exact requested copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {probePiVersion} from '../../../runtime/verify-pi-runtime.mjs';

const [requestedSource, requestedCompilerRoot] = process.argv.slice(2);
assert.ok(requestedSource && path.isAbsolute(requestedSource));
assert.ok(requestedCompilerRoot && path.isAbsolute(requestedCompilerRoot));
const source = fs.realpathSync(requestedSource), compilerRoot = fs.realpathSync(requestedCompilerRoot);
assert.ok(!source.split(path.sep).includes('node_modules'), 'Require an explicit isolated candidate, not installed source');
const pi = await probePiVersion({executable: process.env.ROTOM_PI});
const compilerPackage = JSON.parse(fs.readFileSync(path.join(compilerRoot, 'node_modules/typescript/package.json')));
assert.equal(compilerPackage.name, 'typescript');
const compiler = path.join(compilerRoot, 'node_modules/typescript', compilerPackage.bin.tsc);
assert.ok(fs.statSync(compiler).isFile());
assert.ok(fs.statSync(path.join(compilerRoot, 'node_modules/@types/node/index.d.ts')).isFile());
function filesBelow(dir) {
 return fs.readdirSync(dir).flatMap(name => {
  const file = path.join(dir, name), stat = fs.lstatSync(file);
  assert.ok(!stat.isSymbolicLink(), 'Linked candidate source');
  return stat.isDirectory() ? filesBelow(file) : file.endsWith('.ts') ? [file] : [];
 });
}
const files = [path.join(source, 'index.ts'), ...filesBelow(path.join(source, 'src'))].sort();
const digest = createHash('sha256');
for (const file of files) digest.update(path.relative(source, file)).update('\0').update(fs.readFileSync(file)).update('\0');
function publicTypes(name, subpath = '.') {
 for (let parent = pi.packageRoot;; parent = path.dirname(parent)) {
  const root = name === '@earendil-works/pi-coding-agent' ? pi.packageRoot : path.join(parent, 'node_modules', name);
  const manifest = path.join(root, 'package.json');
  if (fs.existsSync(manifest)) {
   const pkg = JSON.parse(fs.readFileSync(manifest)); assert.equal(pkg.name, name);
   const exported = pkg.exports?.[subpath] ?? (subpath === '.' ? pkg.exports : undefined);
   const relative = exported?.types ?? (subpath === '.' ? pkg.types : undefined);
   assert.equal(typeof relative, 'string', `No public types contract: ${name}/${subpath}`);
   const file = path.resolve(root, relative); assert.ok(fs.statSync(file).isFile()); return [file];
  }
  if (path.dirname(parent) === parent) throw Error(`Public package unavailable: ${name}`);
 }
}
const paths = Object.fromEntries(['pi-coding-agent','pi-agent-core','pi-ai','pi-tui'].map(n => ['@earendil-works/'+n, publicTypes('@earendil-works/'+n)]));
paths['@earendil-works/pi-ai/compat'] = publicTypes('@earendil-works/pi-ai', './compat');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotom-owned-types-')), config = path.join(root, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',lib:['ES2023'],types:['node'],typeRoots:[path.join(compilerRoot,'node_modules/@types')],noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true,strict:true,noUncheckedIndexedAccess:true,paths},files}), {mode:0o600});
const listed = spawnSync(process.execPath, [compiler,'--project',config,'--listFilesOnly'], {encoding:'utf8',timeout:120000});
assert.ifError(listed.error); assert.equal(listed.status,0,listed.stdout+listed.stderr);
const observed = listed.stdout.trim().split('\n').filter(f => f.startsWith(source+path.sep)).map(f => fs.realpathSync(f)).sort();
assert.deepEqual(observed, files.map(f => fs.realpathSync(f)).sort(), 'Compiler input coverage differs from requested candidate');
const checked = spawnSync(process.execPath, [compiler,'--project',config], {encoding:'utf8',timeout:120000});
fs.writeFileSync(path.join(root,'typecheck.log'),checked.stdout+checked.stderr,{mode:0o600});
assert.ifError(checked.error); assert.equal(checked.status,0,checked.stdout+checked.stderr);
console.log(JSON.stringify({source,candidateTsFiles:files.length,sourceDigest:digest.digest('hex'),typescript:compilerPackage.version,strict:true,config}));
