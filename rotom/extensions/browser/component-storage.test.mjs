import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = import.meta.dirname;

test("stable component directory upgrades in place across releases and rejects corruption/symlinks/oversize", { skip: process.platform !== "darwin" }, async (t) => {
	const workspace = await mkdtemp(join(tmpdir(), "browser-components-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const home = join(workspace, "home");
	await mkdir(join(home, "Library", "Application Support"), { recursive: true });
	const relayDir = join(home, "Library", "Application Support", "rotom", "browser-relay");
	const releaseA = join(workspace, "release-a"), releaseB = join(workspace, "release-b");
	await mkdir(releaseA);
	await cp(join(root, "chrome-extension"), join(releaseA, "chrome-extension"), { recursive: true });
	for (const name of ["native-host.mjs", "install-chrome-relay.mjs"]) await cp(join(root, name), join(releaseA, name));
	await cp(releaseA, releaseB, { recursive: true });
	const run = (release, operation, targetHome = home) => spawnSync(process.execPath, [join(release, "install-chrome-relay.mjs"), operation], { env: { HOME: targetHome }, encoding: "utf8", timeout: 10_000 });

	// First install creates the one stable directory Chrome will load; the launcher
	// references that stable path, never the (deletable) product release directory.
	const installed = run(releaseA, "install"); assert.equal(installed.status, 0, installed.stderr);
	const first = JSON.parse(installed.stdout);
	assert.equal(first.firstInstall, true); assert.equal(first.reloadNeeded, false);
	assert.match(first.extensionDir, /\/browser-relay\/current\/chrome-extension$/);
	const swBytes = await readFile(join(first.extensionDir, "service-worker.js"));
	const launcher = await readFile(first.launcherPath, "utf8");
	assert.ok(!launcher.includes(releaseA)); assert.ok(!launcher.includes(root));
	assert.ok(launcher.includes(join(relayDir, "current", "native-host.mjs")), "launcher execs the stable native host path");

	// A deleted release plus unrelated product-file churn must not change the component.
	await rm(releaseA, { recursive: true });
	await writeFile(join(releaseB, "index.ts"), "// unrelated product command update\n");
	let status = JSON.parse(run(releaseB, "status").stdout);
	assert.equal(status.installed, true); assert.equal(status.upToDate, true);
	assert.equal(status.componentState, "ready"); assert.equal(status.extensionDir, first.extensionDir);
	const reinstall = JSON.parse(run(releaseB, "install").stdout);
	assert.equal(reinstall.reloadNeeded, false); assert.equal(reinstall.firstInstall, false);

	// Corrupted permissions are detected and atomically repaired by re-running install.
	await chmod(join(first.extensionDir, "service-worker.js"), 0o644);
	assert.equal(JSON.parse(run(releaseB, "status").stdout).componentState, "invalid");
	assert.equal(run(releaseB, "install").status, 0, "install 应能原子重建被破坏的固定目录");
	status = JSON.parse(run(releaseB, "status").stdout);
	assert.equal(status.componentState, "ready"); assert.equal(status.installed, true);
	assert.deepEqual(await readFile(join(first.extensionDir, "service-worker.js")), swBytes);

	// A real component content change updates the stable directory in place: one Chrome
	// reload (↻) suffices, the path is unchanged, and no re-registration is required.
	const host = join(releaseB, "native-host.mjs");
	await writeFile(host, `${await readFile(host, "utf8")}\n// new browser component\n`);
	status = JSON.parse(run(releaseB, "status").stdout);
	assert.equal(status.installed, false); assert.equal(status.upToDate, false);
	assert.notEqual(status.componentDigest, first.componentDigest);
	assert.equal(status.installedDigest, first.componentDigest);
	const upgraded = JSON.parse(run(releaseB, "install").stdout);
	assert.equal(upgraded.reloadNeeded, true); assert.equal(upgraded.firstInstall, false);
	assert.equal(upgraded.extensionDir, first.extensionDir, "升级后 Chrome 加载路径不变");
	assert.match(await readFile(join(relayDir, "current", "native-host.mjs"), "utf8"), /new browser component/);
	assert.equal(JSON.parse(run(releaseB, "status").stdout).installed, true);

	// The exclusive install lock is never stolen from an unknown concurrent installer.
	await writeFile(host, `${await readFile(host, "utf8")}\n// lock contention\n`);
	const lock = join(relayDir, ".install.lock"); await mkdir(lock, { mode: 0o700 });
	assert.notEqual(run(releaseB, "install").status, 0);
	assert.equal((await lstat(lock)).isDirectory(), true);
	await rm(lock, { recursive: true });

	// A symlinked Application Support must never let the installer escape HOME.
	const outside = join(workspace, "outside"); await mkdir(outside); await writeFile(join(outside, "sentinel"), "keep");
	const redirectedHome = join(workspace, "redirected-home");
	await mkdir(join(redirectedHome, "Library"), { recursive: true });
	await symlink(outside, join(redirectedHome, "Library", "Application Support"));
	assert.notEqual(run(releaseB, "install", redirectedHome).status, 0);
	await assert.rejects(lstat(join(outside, "rotom")), { code: "ENOENT" }, "不能通过 symlink 父目录创建文件");
	assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "keep");

	// Component inputs are bounded and never followed through a symlink before reading.
	const oversized = join(releaseB, "chrome-extension", "oversized.js");
	await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
	assert.notEqual(run(releaseB, "status").status, 0, "component input must be bounded before reading");
	await rm(oversized);
	await rm(join(releaseB, "native-host.mjs")); await symlink(join(root, "native-host.mjs"), join(releaseB, "native-host.mjs"));
	assert.notEqual(run(releaseB, "status").status, 0, "source symlinks must be rejected");
});
