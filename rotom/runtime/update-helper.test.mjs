import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updateHelper } from "./update-helper.mjs";

test("public helper command routes without starting Pi and inherits the signing identity", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-helper-routing-")));
	try {
		await mkdir(join(root, "bin"));
		await mkdir(join(root, "runtime"));
		await copyFile(new URL("../bin/rotom-launcher", import.meta.url), join(root, "bin/rotom-launcher"));
		await writeFile(join(root, "runtime/update-helper.mjs"), 'console.log(JSON.stringify({args:process.argv.slice(2),identity:process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY}));');
		const result = spawnSync("/bin/sh", [join(root, "bin/rotom-launcher"), "helper", "update"], {
			encoding: "utf8", env: { ...process.env, ROTOM_NODE: process.execPath, PI_COMPUTER_USE_CODESIGN_IDENTITY: "Fixture Identity" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { args: ["update"], identity: "Fixture Identity" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("helper update verifies the installed contract and dispatches only the explicit updater", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "rotom-helper-command-")));
	const pkg = join(root, "extensions/third-party/node_modules/@injaneity/pi-computer-use");
	try {
		for (const file of ["scripts/setup-helper.mjs", "scripts/setup-helper-common.mjs", "scripts/setup-helper-signing.mjs", "scripts/setup-helper-release.mjs", "scripts/helper-update.mjs", "scripts/macos-sources.mjs", "src/constants/helper-update.mjs", "src/platform/macos/helper-path.mjs"]) {
			const full = join(pkg, file);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, "// fixture, never executed\n");
		}
		let verified = false;
		let dispatches = 0;
		const deps = {
			verify: async value => { assert.equal(value, root); verified = true; },
			run: (executable, args, options) => {
				assert.equal(verified, true);
				assert.equal(executable, process.execPath);
				assert.deepEqual(args, [join(pkg, "scripts/setup-helper.mjs"), "--update"]);
				assert.equal(options.stdio, "inherit");
				dispatches++;
				return { status: 0 };
			},
		};
		assert.equal(await updateHelper(root, ["update"], deps), 0);
		assert.equal(dispatches, 1);
		await assert.rejects(updateHelper(root, ["update", "--force"], deps), /Usage:[\s\S]*询问是否停止旧 helper.*默认否/);
		await assert.rejects(updateHelper(root, ["update"], { ...deps, verify: async () => { throw new Error("bad identity"); } }), /bad identity/);
		for (const name of ["scripts/helper-update.mjs", "scripts/setup-helper-common.mjs", "scripts/setup-helper-signing.mjs", "scripts/setup-helper-release.mjs", "src/platform/macos/helper-path.mjs"]) {
			const file = join(pkg, name);
			await rm(file);
			await symlink(join(pkg, "scripts/setup-helper.mjs"), file);
			await assert.rejects(updateHelper(root, ["update"], deps), /trusted regular file/);
			assert.equal(dispatches, 1);
			await rm(file);
			await writeFile(file, "// fixture, never executed\n");
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});
