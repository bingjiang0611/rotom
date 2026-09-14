import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	compareSemver,
	ROTOM_LATEST_URL,
	ROTOM_PACKAGE_NAME,
	selectLatestVersion,
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
