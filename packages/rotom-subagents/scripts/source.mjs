// Maintenance tooling only. Runtime payload selection is explicit and link-free.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const packageRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
export const repoRoot = path.resolve(packageRoot, '../..');
export const manifest = () => JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function privateOutput(requested) {
 assert.ok(path.isAbsolute(requested), 'Output must be absolute');
 const output = fs.realpathSync(requested), stat = fs.lstatSync(output);
 assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Require an existing private owned directory');
 assert.ok(!inside(repoRoot, output) && !output.split(path.sep).includes('node_modules'), 'Output must be outside repository and installed source');
 assert.equal(path.resolve(requested), output, 'Use the canonical output path');
 return output;
}

export function payloadFiles(root = packageRoot) {
 const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
 assert.equal(pkg.name, 'pi-subagents'); assert.equal(pkg.private, true);
 assert.match(pkg.version, /^0\.52\.1-rotom\.\d+$/);
 const files = new Set(['package.json']);
 const visit = relative => {
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') || ['node_modules','test','scripts','fixtures','evals'].includes(p)) && !/[\\*?!]/.test(relative) && !/(?:\.test\.|\.eval\.|\.patch$)/.test(relative), 'Unsafe payload path');
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  assert.ok(!stat.isSymbolicLink() && fs.realpathSync(file) === file, 'Linked payload');
  if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(relative + '/' + name);
  else { assert.ok(stat.isFile(), 'Non-regular payload'); files.add(relative); }
 };
 for (const file of pkg.files) visit(file);
 for (const file of files) assert.ok(fs.lstatSync(path.join(root, file)).isFile() && !fs.lstatSync(path.join(root, file)).isSymbolicLink());
 return [...files].sort();
}

export function sourceDigest(root = packageRoot) {
 const digest = createHash('sha256');
 const files = payloadFiles(root).filter(p => p === 'index.ts' || p.startsWith('src/') && p.endsWith('.ts'));
 for (const file of files) digest.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
 return {tsFiles: files.length, sourceDigest: digest.digest('hex')};
}

export function copyPayload(target, source = packageRoot) {
 assert.ok(!fs.existsSync(target), 'Refusing to overwrite a source snapshot');
 const files = payloadFiles(source); fs.mkdirSync(target, {mode:0o700});
 for (const file of files) {
  const from = path.join(source, file), to = path.join(target, file);
  fs.mkdirSync(path.dirname(to), {recursive:true, mode:0o700});
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, fs.statSync(from).mode & 0o111 ? 0o700 : 0o600);
 }
 return target;
}

function rejectLinks(root) {
 for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  assert.ok(!entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()), 'Linked/non-regular test dependency');
  if (entry.isDirectory()) rejectLinks(path.join(root, entry.name));
 }
}

// Tests need directly loadable TS outside node_modules. Only the four locked
// runtime dependencies are copied for tests; release packing never copies them.
export function snapshot(requested) {
 const root = privateOutput(fs.realpathSync(requested));
 const target = path.join(root, 'candidate'), modules = path.join(root, 'node_modules');
 assert.equal(fs.readdirSync(root).length, 0, 'Require an unused snapshot directory');
 const dependencies = Object.entries(manifest().dependencies).map(([name, version]) => {
  let folder = path.dirname(fileURLToPath(import.meta.resolve(name)));
  while (!fs.existsSync(path.join(folder, 'package.json')) || JSON.parse(fs.readFileSync(path.join(folder, 'package.json'))).name !== name) {
   assert.notEqual(folder, path.dirname(folder), 'Dependency identity unavailable'); folder = path.dirname(folder);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'))).version, version);
  assert.equal(fs.realpathSync(folder), folder); rejectLinks(folder); return [name, folder];
 });
 copyPayload(target); fs.mkdirSync(modules, {mode:0o700});
 for (const [name, folder] of dependencies) fs.cpSync(folder, path.join(modules, name), {recursive:true, errorOnExist:true, force:false});
 return target;
}
