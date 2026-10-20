import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// No native executable is launched. The destination is an owned disposable
// fixture, never the user's app. This checks the real installer before its copy.
test("bundled ad-hoc helper cannot silently replace an existing helper", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rotom-helper-install-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = join(root, "test-helper.app");
	await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
	const executable = join(app, "Contents", "MacOS", "bridge");
	const original = "existing helper fixture: must not be replaced";
	await writeFile(executable, original, { mode: 0o755 });
	const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/setup-helper.mjs"), "--runtime"], {
		env: { ...process.env, PI_COMPUTER_USE_HELPER_APP_PATH: app, PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE: "0" },
		encoding: "utf8", timeout: 15_000,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Refusing to replace an existing helper with an ad-hoc bundle/);
	assert.equal(await readFile(executable, "utf8"), original);
});
