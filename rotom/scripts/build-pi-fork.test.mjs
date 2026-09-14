import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { forkNpmEnvironment, sourceDigest, sourceFiles, verifyForkSource } from "./build-pi-fork.mjs";

test("fork npm environment keeps explicit proxy settings without inheriting unrelated state", () => {
	assert.deepEqual(
		forkNpmEnvironment("/work", "/sandbox", {
			PATH: "/bin",
			HTTPS_PROXY: "https://proxy.example",
			NO_PROXY: "localhost",
			https_proxy: "https://ignored.example",
			TOKEN: "secret",
		}),
		{
			PATH: "/bin",
			HOME: "/sandbox",
			NPM_CONFIG_CACHE: "/work/cache",
			NPM_CONFIG_USERCONFIG: "/sandbox/npmrc",
			NPM_CONFIG_GLOBALCONFIG: "/sandbox/global-npmrc",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			HTTPS_PROXY: "https://proxy.example",
			NO_PROXY: "localhost",
		},
	);
});

test("fork source attestation is stable, excludes installs, and rejects source/builder drift", async (t) => {
	const root = await realpath(await mkdtemp(resolve(tmpdir(), "rotom-fork-test-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = resolve(root, "source"), runtime = resolve(root, "runtime");
	await mkdir(source); await mkdir(runtime);
	await writeFile(resolve(source, "input.ts"), "original");
	const sourceSha256 = await sourceDigest(source);
	await mkdir(resolve(source, "node_modules"));
	await writeFile(resolve(source, "node_modules/private.txt"), "must not copy");
	assert.deepEqual(await sourceFiles(source), ["input.ts"]);
	assert.equal(await sourceDigest(source), sourceSha256);
	const builderSha256 = createHash("sha256").update(await readFile(new URL("./build-pi-fork.mjs", import.meta.url))).digest("hex");
	await writeFile(resolve(runtime, "fork-build.json"), JSON.stringify({ sourceSha256, builderSha256 }));
	await verifyForkSource(source, runtime);
	await writeFile(resolve(source, "input.ts"), "changed");
	await assert.rejects(verifyForkSource(source, runtime), /changed/);
	await writeFile(resolve(source, "input.ts"), "original");
	await writeFile(resolve(runtime, "fork-build.json"), JSON.stringify({ sourceSha256, builderSha256: "wrong" }));
	await assert.rejects(verifyForkSource(source, runtime), /changed/);
	await symlink(resolve(source, "input.ts"), resolve(source, "alias.ts"));
	await assert.rejects(sourceDigest(source), /Untrusted/);
});
