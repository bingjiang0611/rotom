// Maintenance-only fifth layer; never apply to installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareOwnedForegroundCandidate } from "./prepare-owned-foreground.mjs";
const preimages = {
  "src/extension/config.ts": "4a5742e1d4cfdca23636ee3b80b3d0bfd25db13a9645d29a52064aa5c504fbfc",
  "src/runs/background/active-async-capacity.ts": "acd58dbe4134dd8a1f7b0019e41882b241d4101f0742246b8a8776a6762cb8aa",
  "src/runs/background/async-execution.ts": "4c8fdb33ec37d4c016978bf787dd282a83ae8a3b3d906fa4f1e65cf9131a181d",
  "src/runs/background/async-resume.ts": "755446137f7b30a69e251ef3f06ba9e456ab2b41fd1fc600cdbb508c3b00dcf8",
  "src/runs/background/owned-execution.ts": "0dc88794a9099a86d624b9023b3727fc7620b861b5c9d2c74d06de89aa2cacb7",
  "src/runs/background/owned-foreground.ts": "6d6a0c539d04ae9819e19c4ff6349a521c2fccd269e95ad92f92679fbe03acbb",
  "src/runs/background/owned-workflow.ts": "672bcb64259b179118f1634fc04d206b98aad762f417cda2d574558da43ace52",
  "src/runs/foreground/subagent-executor.ts": "37fdae2ab6ed43339cc7a967413a1d75084c7fe56c3a52e28728a1a8cf6cb148",
  "src/runs/shared/session-lease.ts": "e39dfeb2da0c1d8bb25c717f251deb4dd51bafea5a366b00e98ecb6a1439a205",
  "src/shared/execution-store.ts": null,
  "src/shared/types.ts": "ea19bb0fcf40f6f597925bfc045a8aee92cbafab9aab2f12b0b35fd6fb312c69"
};
export function verifyOwnedStorePreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Store scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedStoreCandidate(root) {
	const source = prepareOwnedForegroundCandidate(root);
	verifyOwnedStorePreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-store-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
