import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveMacosHelperAppPath } from "../extensions/third-party/node_modules/@injaneity/pi-computer-use/src/platform/macos/helper-path.mjs";

// Real launcher + installed fork + codesign/ditto, with no provider request or native input.
test("npm-style upgrades synchronize the helper on normal startup, not version/help queries", { skip: process.platform !== "darwin" }, async (t) => {
	const home = await realpath(await mkdtemp(join(tmpdir(), "rotom-auto-helper-")));
	const product = resolve(import.meta.dirname, "..");
	const source = join(product, "extensions/third-party/node_modules/@injaneity/pi-computer-use/prebuilt/macos/universal/pi-computer-use.app");
	const target = join(home, "Applications/pi-computer-use.app");
	if (resolveMacosHelperAppPath({ homeDir: home, env: {} }) !== target) {
		await rm(home, { recursive: true });
		t.skip("A system-wide helper prevents isolated-HOME startup acceptance.");
		return;
	}
	const resource = "Contents/Resources/source.sha256";
	const expected = createHash("sha256").update(await readFile(join(source, "Contents/MacOS/bridge"))).digest("hex");
	const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), ROTOM_QODER: "0",
		PI_COMPUTER_USE_HELPER_APP_PATH: "", PI_CU_SOCKET_PATH: join(home, "fixture.sock"),
		PI_COMPUTER_USE_CODESIGN_IDENTITY: "", PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE: "0", PI_COMPUTER_USE_NO_SIGN: "0" };
	const run = (args, input) => spawnSync(join(product, "bin/rotom"), args, { cwd: home, env, input, encoding: "utf8", timeout: 60_000 });
	try {
		await mkdir(join(home, "Applications"));
		await cp(source, target, { recursive: true });
		await mkdir(join(target, "Contents/Resources"), { recursive: true });
		await writeFile(join(target, resource), "older-native-source\n");
		const signed = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--sign", "-", target], { encoding: "utf8" });
		assert.equal(signed.status, 0, signed.stderr);
		for (const args of [["--version"], ["--help"]]) {
			const result = run(args);
			assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
			assert.equal(await readFile(join(target, resource), "utf8"), "older-native-source\n");
		}
		const result = run(["--mode", "rpc", "--no-session"], '{"id":"state","type":"get_state"}\n');
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /"command":"get_state"/);
		for (const line of result.stdout.trim().split("\n")) JSON.parse(line);
		assert.equal((await readFile(join(target, resource), "utf8")).trim(), expected);
		assert.match(result.stderr, /Updated helper automatically/);
		assert.equal(spawnSync("/usr/bin/codesign", ["--verify", "--strict", target]).status, 0);
		const installed = await readFile(join(target, "Contents/MacOS/bridge"));
		const again = run(["--mode", "rpc", "--no-session"], '{"id":"state","type":"get_state"}\n');
		assert.equal(again.status, 0, again.stderr);
		assert.doesNotMatch(again.stderr, /Updated helper automatically/);
		assert.deepEqual(await readFile(join(target, "Contents/MacOS/bridge")), installed);
	} finally {
		const occupancy = spawnSync("/usr/sbin/lsof", ["-t", "--", join(target, "Contents/MacOS/bridge")], { encoding: "utf8" });
		assert.equal(occupancy.status, 1, `Fixture may still be in use; retained at ${home}`);
		assert.equal(occupancy.stderr, "");
		await rm(home, { recursive: true, force: true });
	}
});
