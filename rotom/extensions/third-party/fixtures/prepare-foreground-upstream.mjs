// Maintenance-only upstream regressions. No source/dependency installation and no model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { probePiVersion } from "../../../runtime/verify-pi-runtime.mjs";
export const upstreamCommit = "afa22c811f81883acdb248c84f116ac7534e2fb4";
export const upstreamUnits = ["owned-process-tree", "process-terminal", "active-async-capacity", "async-retention", "async-resume", "external-cli-runner", "scripted-workflow", "session-lease", "workflow-detach-reconcile", "foreground-control", "close-grace-timer"];
function filesBelow(root, relative) {
	const file = path.join(root, relative), stat = fs.lstatSync(file);
	assert.ok(!stat.isSymbolicLink(), `Linked upstream fixture: ${relative}`);
	if (stat.isFile()) return [relative];
	assert.ok(stat.isDirectory());
	return fs.readdirSync(file).flatMap(name => filesBelow(root, `${relative}/${name}`));
}
export async function prepareForegroundUpstreamTests({ source, upstream, executable }) {
	assert.ok(executable, "Explicit verified public Pi executable required");
	const pi = await probePiVersion({ executable });
	const installed = fs.realpathSync(path.resolve(import.meta.dirname, "../node_modules/pi-subagents"));
	const target = fs.realpathSync(source), rel = path.relative(installed, target);
	assert.ok((rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) && !target.split(path.sep).includes("node_modules") && !path.resolve(source).split(path.sep).includes("node_modules"), "Never prepare tests inside installed source");
	assert.equal(JSON.parse(fs.readFileSync(path.join(target, "package.json"))).name, "pi-subagents");
	const files = [...filesBelow(upstream, "test/support"), ...filesBelow(upstream, "test/fixtures"), ...upstreamUnits.map(n => `test/unit/${n}.test.ts`), "test/integration/single-execution.test.ts"].sort();
	const hash = createHash("sha256");
	for (const file of files) { assert.ok(fs.lstatSync(path.join(upstream, file)).isFile()); hash.update(file).update("\0").update(fs.readFileSync(path.join(upstream, file))); }
	assert.equal(files.length, 199);
	assert.equal(hash.digest("hex"), "7fc6fc0770c3ccfb9829e4162ba502e8ab8cbc395e189dd6fa494440b5b7bc8d", "Pinned upstream test/support preimage drift");
	for (const file of files) {
		let parent = target;
		for (const part of path.dirname(file).split("/")) {
			parent = path.join(parent, part);
			if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
			const stat = fs.lstatSync(parent); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Linked test destination");
		}
		const destination = path.join(target, file);
		try { const stat = fs.lstatSync(destination); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Invalid test destination"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		fs.copyFileSync(path.join(upstream, file), destination);
	}
	const patch = path.resolve(import.meta.dirname, "../subagent-foreground-readiness-test.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: target, timeout: 10000, encoding: "utf8", env: { PATH: process.env.PATH, HOME: path.dirname(target), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	const parentURL = pathToFileURL(path.join(pi.packageRoot, "package.json")).href;
	const loader = path.join(target, "public-runtime-loader.mjs");
	try { const stat = fs.lstatSync(loader); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Invalid test loader destination"); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	fs.writeFileSync(loader, `import {registerHooks} from 'node:module';\nglobalThis.fetch=()=>{throw Error('Network forbidden in local upstream regression')};\nregisterHooks({resolve(specifier,context,nextResolve){return nextResolve(specifier,specifier.startsWith('@earendil-works/')?{...context,parentURL:${JSON.stringify(parentURL)}}:context)}});\n`, { mode: 0o600 });
	return { source: target, loader, upstreamCommit, adaptation: "one event-driven intercom fixture; original assertions preserved" };
}
