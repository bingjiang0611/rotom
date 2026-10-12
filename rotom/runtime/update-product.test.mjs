import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	compareSemver,
	ROTOM_LATEST_URL,
	ROTOM_PACKAGE_NAME,
	selectLatestVersion,
	supportsProductNodeVersion,
	updateRotom,
} from "./update-product.mjs";

async function fixture(version = "0.1.2") {
	const root = await mkdtemp(join(tmpdir(), "rotom-update-test-"));
	const npmRoot = join(root, "lib/node_modules");
	const packageRoot = join(npmRoot, ROTOM_PACKAGE_NAME);
	const npmCommand = join(root, "bin/npm");
	await mkdir(join(packageRoot, "bin"), { recursive: true });
	await mkdir(join(root, "bin"), { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: ROTOM_PACKAGE_NAME, version }));
	await writeFile(npmCommand, "#!/bin/sh\nexit 0\n");
	await chmod(npmCommand, 0o700);
	return { root, npmRoot, packageRoot, npmCommand };
}

function registryResponse(version, name = ROTOM_PACKAGE_NAME) {
	return new Response(JSON.stringify({ name, version }), { status: 200 });
}

test("semantic version ordering covers stable and prerelease releases", () => {
	assert.equal(compareSemver("0.1.2", "0.1.1"), 1);
	assert.equal(compareSemver("0.1.2", "0.1.2-alpha.17"), 1);
	assert.equal(compareSemver("0.1.2-alpha.2", "0.1.2-alpha.10"), -1);
	assert.equal(compareSemver("0.1.2+build.2", "0.1.2+build.1"), 0);
	assert.throws(() => compareSemver("latest", "0.1.2"), /invalid semantic version/u);
});

test("product updater follows the package Node 24+ contract", () => {
	assert.equal(supportsProductNodeVersion("23.11.1"), false);
	assert.equal(supportsProductNodeVersion("24.0.0"), true);
	assert.equal(supportsProductNodeVersion("25.1.0"), true);
	assert.equal(supportsProductNodeVersion("invalid"), false);
});

test("latest metadata requires the public rotom package identity", () => {
	assert.equal(selectLatestVersion({ name: ROTOM_PACKAGE_NAME, version: "0.1.3" }), "0.1.3");
	assert.equal(selectLatestVersion({ name: "other", version: "0.1.3" }), undefined);
	assert.equal(selectLatestVersion({ name: ROTOM_PACKAGE_NAME, version: "latest" }), undefined);
});

test("updates a global npm install using the exact checked version and online metadata", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const calls = [];
	const output = [];
	const result = await updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		fetchImpl: async (url, options) => {
			assert.equal(url, ROTOM_LATEST_URL);
			assert.equal(options.redirect, "error");
			assert.equal(options.headers["cache-control"], "no-cache");
			return registryResponse("0.1.3");
		},
		runCommand: (command, args, options) => {
			calls.push({ command, args, options });
			if (args[0] === "root") return { status: 0, stdout: `${value.npmRoot}\n`, stderr: "" };
			assert.deepEqual(args, [
				"install",
				"--global",
				"--ignore-scripts",
				"--prefer-online",
				"--registry=https://registry.npmjs.org",
				"@bingjiang0611/rotom@0.1.3",
			]);
			assert.equal(options.capture, false);
			writeFileSync(join(value.packageRoot, "package.json"), JSON.stringify({ name: ROTOM_PACKAGE_NAME, version: "0.1.3" }));
			return { status: 0 };
		},
		output: (message) => output.push(message),
		confirm: async () => true,
	});
	assert.deepEqual(result, { currentVersion: "0.1.2", latestVersion: "0.1.3", updated: true });
	assert.equal(calls.length, 2);
	assert.match(output.join("\n"), /Updated rotom to 0\.1\.3/u);
});

test("does not reinstall an up-to-date release", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	let installCalls = 0;
	const result = await updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		fetchImpl: async () => registryResponse("0.1.2"),
		runCommand: (_command, args) => {
			if (args[0] === "root") return { status: 0, stdout: `${value.npmRoot}\n`, stderr: "" };
			installCalls++;
			return { status: 0 };
		},
		output: () => {},
	});
	assert.equal(result.updated, false);
	assert.equal(installCalls, 0);
});

test("does not write when the user declines the live-install replacement warning", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	let installCalls = 0;
	const output = [];
	const result = await updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		fetchImpl: async () => registryResponse("0.1.3"),
		runCommand: (_command, args) => {
			if (args[0] === "root") return { status: 0, stdout: `${value.npmRoot}\n`, stderr: "" };
			installCalls++;
			return { status: 0 };
		},
		output: (message) => output.push(message),
		confirm: async () => false,
	});
	assert.deepEqual(result, { currentVersion: "0.1.2", latestVersion: "0.1.3", updated: false });
	assert.equal(installCalls, 0);
	assert.match(output.join("\n"), /Exit every other rotom session/u);
	assert.match(output.join("\n"), /Update cancelled/u);
});

test("CLI entry still runs when its parent directory is reached through a symlink", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rotom-update-entry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const linkedRoot = join(root, "product");
	await symlink(productRoot, linkedRoot, "dir");

	const result = spawnSync(process.execPath, [join(linkedRoot, "runtime/update-product.mjs")], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /^rotom update: /u);
});

test("refuses a globally linked development installation", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const linkedTarget = join(value.root, "linked-source");
	await mkdir(linkedTarget);
	await writeFile(join(linkedTarget, "package.json"), JSON.stringify({ name: ROTOM_PACKAGE_NAME, version: "0.1.2" }));
	await rm(value.packageRoot, { recursive: true });
	await symlink(linkedTarget, value.packageRoot, "dir");

	await assert.rejects(
		updateRotom({
			packageRoot: linkedTarget,
			npmCommand: value.npmCommand,
			runCommand: () => ({ status: 0, stdout: `${value.npmRoot}\n`, stderr: "" }),
			fetchImpl: async () => registryResponse("0.1.3"),
		}),
		/only a regular active global npm installation/u,
	);
});

test("refuses to update an installation outside the active npm prefix", async (t) => {
	const value = await fixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	await assert.rejects(
		updateRotom({
			packageRoot: value.packageRoot,
			npmCommand: value.npmCommand,
			runCommand: () => ({ status: 0, stdout: `${join(value.root, "other/node_modules")}\n`, stderr: "" }),
			fetchImpl: async () => registryResponse("0.1.3"),
		}),
		/rotom update supports only a regular active global npm installation/u,
	);
});

async function releaseFixture(version = "0.1.2") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-release-update-test-")));
	const releasesRoot = join(root, "home/.local/share/rotom/releases");
	const packageRoot = join(releasesRoot, version, "node_modules/rotom");
	const binDirectory = join(root, "bin");
	const commandPath = join(binDirectory, "rotom");
	const npmCommand = join(root, "npm");
	await mkdir(join(packageRoot, "bin"), { recursive: true });
	await mkdir(binDirectory);
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: ROTOM_PACKAGE_NAME, version }));
	await writeFile(join(packageRoot, "bin/rotom"), "#!/bin/sh\n");
	await symlink(join(packageRoot, "bin/rotom"), commandPath);
	await writeFile(npmCommand, "#!/bin/sh\nexit 0\n");
	await chmod(npmCommand, 0o700);
	return { root, home: join(root, "home"), releasesRoot, packageRoot, binDirectory, commandPath, npmCommand };
}

function releaseRegistry(version, tarball, integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`) {
	const tarballUrl = `https://registry.npmjs.org/@bingjiang0611/rotom/-/rotom-${version}.tgz`;
	const requests = [];
	const fetchImpl = async (url) => {
		requests.push(url);
		if (url === ROTOM_LATEST_URL) return new Response(JSON.stringify({ name: ROTOM_PACKAGE_NAME, version, dist: { tarball: tarballUrl, integrity } }), { status: 200 });
		assert.equal(url, tarballUrl);
		return new Response(tarball, { status: 200 });
	};
	return { fetchImpl, requests };
}

// Simulates `npm install` of file:rotom-<version>.tgz inside the staging dir.
function stagedInstall(version, calls) {
	return (command, args, options) => {
		calls.push({ command, args, options });
		const installed = join(options.cwd, "node_modules/rotom");
		spawnSync("mkdir", ["-p", join(installed, "bin")]);
		writeFileSync(join(installed, "package.json"), JSON.stringify({ name: ROTOM_PACKAGE_NAME, version }));
		writeFileSync(join(installed, "bin/rotom"), "#!/bin/sh\n");
		return { status: 0 };
	};
}

test("updates the per-version release layout and switches only the PATH command symlink", async (t) => {
	const value = await releaseFixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const tarball = Buffer.from("verified tarball bytes");
	const registry = releaseRegistry("0.1.3", tarball);
	const calls = [];
	const output = [];
	const result = await updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		home: value.home,
		pathEnv: `relative/bin:${value.binDirectory}:/usr/bin`,
		fetchImpl: registry.fetchImpl,
		runCommand: stagedInstall("0.1.3", calls),
		output: (message) => output.push(message),
		confirm: async () => assert.fail("release-layout switches keep the old release and need no live-replacement prompt"),
	});
	assert.deepEqual(result, { currentVersion: "0.1.2", latestVersion: "0.1.3", updated: true });
	const destination = join(value.releasesRoot, "0.1.3");
	assert.equal(await readlink(value.commandPath), join(destination, "node_modules/rotom/bin/rotom"));
	assert.equal(calls.length, 1, "no npm root --global or global install");
	assert.deepEqual(calls[0].args, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"]);
	assert.deepEqual(JSON.parse(await readFile(join(destination, "package.json"), "utf8")), { name: "rotom-release-0.1.3", private: true, dependencies: { rotom: "file:rotom-0.1.3.tgz" } });
	assert.deepEqual(await readFile(join(destination, "rotom-0.1.3.tgz")), tarball);
	assert.ok(existsSync(join(value.packageRoot, "package.json")), "previous release is kept");
	assert.deepEqual((await readdir(value.releasesRoot)).sort(), ["0.1.2", "0.1.3"], "no staging directory remains");
	assert.deepEqual((await readdir(value.binDirectory)), ["rotom"], "no temporary link remains");
	assert.match(output.join("\n"), /previous release stays at/u);
});

test("release-layout update rejects a tarball that fails registry integrity without touching the command", async (t) => {
	const value = await releaseFixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const registry = releaseRegistry("0.1.3", Buffer.from("tampered"), `sha512-${createHash("sha512").update("expected").digest("base64")}`);
	const calls = [];
	await assert.rejects(updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		home: value.home,
		pathEnv: value.binDirectory,
		fetchImpl: registry.fetchImpl,
		runCommand: stagedInstall("0.1.3", calls),
		output: () => {},
	}), /does not match the registry integrity/u);
	assert.equal(calls.length, 0);
	assert.equal(await readlink(value.commandPath), join(value.packageRoot, "bin/rotom"));
	assert.deepEqual(await readdir(value.releasesRoot), ["0.1.2"]);
});

test("release-layout update refuses when the first rotom on PATH is not this release", async (t) => {
	const value = await releaseFixture();
	t.after(() => rm(value.root, { recursive: true, force: true }));
	const shadow = join(value.root, "shadow");
	await mkdir(shadow);
	await writeFile(join(shadow, "rotom"), "#!/bin/sh\n");
	const registry = releaseRegistry("0.1.3", Buffer.from("x"));
	await assert.rejects(updateRotom({
		packageRoot: value.packageRoot,
		npmCommand: value.npmCommand,
		home: value.home,
		pathEnv: `${shadow}:${value.binDirectory}`,
		fetchImpl: registry.fetchImpl,
		runCommand: () => assert.fail("must not install"),
		output: () => {},
	}), /first rotom on PATH .* is not a symlink to this release/u);
	assert.equal(registry.requests.length, 0);
});
