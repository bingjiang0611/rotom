// Exercise the actual npm bin, not this source directory or an injected SDK.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {privateOutput, repoRoot, manifest} from './source.mjs';
const [prefix, requested] = process.argv.slice(2);
assert.equal(process.argv.length,4,'Usage: npm run test:product -- /absolute/install-prefix /absolute/private/evidence');
assert.ok(path.isAbsolute(prefix));
const product=path.join(prefix,'node_modules/rotom');
assert.equal(JSON.parse(fs.readFileSync(path.join(product,'extensions/third-party/node_modules/pi-subagents/package.json'))).version,manifest().version,'Wrong installed component');
const output=privateOutput(requested);
for (const args of [['wait','0','transient'],['wait','0','persistent'],['drain','0','transient'],['wait','1','transient'],['native','0','transient'],['workflow','0','transient']]) {
 const file=path.join(output,args.join('-')+'.log'), log=fs.openSync(file,'wx',0o600);
 let result;
 try {result=spawnSync(process.execPath,[path.join(repoRoot,'rotom/extensions/third-party/fixtures/owned-product-cli.mjs'),prefix,output,...args],{env:{PATH:process.env.PATH,HOME:output,ROTOM_SUBAGENT_TEST_VERSION:manifest().version},stdio:['ignore',log,log],timeout:150000});}
 finally {fs.closeSync(log)}
 assert.ifError(result.error);assert.equal(result.status,0,`Product fixture unverified; see ${file}`);
 console.log(args.join(' ')+': PASS');
}
