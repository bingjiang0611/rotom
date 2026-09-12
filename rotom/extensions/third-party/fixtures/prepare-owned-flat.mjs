// Maintenance-only seventh layer; never apply to installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareOwnedSessionCandidate } from "./prepare-owned-session.mjs";
const preimages = {
  "docs/owned-execution.md": null,
  "owned-store.mjs": null,
  "src/extension/tool-description.ts": "a223cd445a5c69584b0165bdd13c456469f36b587b1052eb7a95ea9112c95b08",
  "src/runs/background/retained-children.ts": "6bb88dc807602e6d6ee6dc8cce37cce97a9e5c58e2826d8e464671619d5fc1cf",
  "src/runs/foreground/subagent-executor.ts": "a5a15f6ae083b46dca210058d3eb417bf3d7b7fe02d79ba18af3aca89fb22b97"
};
export function verifyOwnedFlatPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Flat scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedFlatCandidate(root) {
	const source = prepareOwnedSessionCandidate(root);
	verifyOwnedFlatPreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-flat-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
