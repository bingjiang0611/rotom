// Maintenance-only sixth layer; never apply to installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareOwnedStoreCandidate } from "./prepare-owned-store.mjs";
const preimages = {
  "src/extension/fanout-child.ts": "8a62f15880d77e5409fc70b00eec47c47ceb3ed5b0449deaee9fdbca5b83cfba",
  "src/extension/index.ts": "27f6a4943e2255477516e76cdca0579dcfd9c7c7a99f476e49c9e45e262327e4",
  "src/runs/background/async-execution.ts": "199b2c2e6a7f2d40bcaf9d682d5507719d07b0b0666d5aa09b5d854c9f28c558",
  "src/runs/background/owned-execution.ts": "7b671200a9b9bd27b4e66367ad09de73e97a67a3db042eb4f869d4cc698e67aa",
  "src/runs/background/owned-foreground.ts": "78a6d661c5d36a1459719a5deb6ca491c0b5d7b572fe45d4d1978de358e1f427",
  "src/runs/background/subagent-runner.ts": "4f578b5c955a4541714630fb4288a53674fdb4676a811b9afeacb1436b2f81ea",
  "src/runs/foreground/subagent-executor.ts": "b8ee8ca92971fbb7be75609037f8ffeed8aed7b9732a376f648dcc74595eeede",
  "src/runs/shared/session-lease.ts": "125d8dfd7df7ba7afb6c993f9eff1df62ad125d27d0af1cc47a4c27703ad0db1",
  "src/shared/execution-store.ts": "9f7efa89d77f7dff5775a5869596d5916698dd3be42b0cc374715ca39ac8b5b4"
};
export function verifyOwnedSessionPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Session scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedSessionCandidate(root) {
	const source = prepareOwnedStoreCandidate(root);
	verifyOwnedSessionPreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-session-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
