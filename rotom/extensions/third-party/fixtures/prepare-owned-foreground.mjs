// Maintenance-only fourth layer; never apply to installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareOwnedWorkflowCandidate } from "./prepare-owned-workflow.mjs";
const preimages = {
  "src/runs/background/active-async-capacity.ts": "a31da79c49a5a39d8f9e6d21872925f5d8a1e9be51611b586a1c4a181e6ad1ea",
  "src/runs/background/async-resume.ts": "e128153451b85911ac3d930282a2058ca4c93aaf8cf34a6c89af5e90467c30cb",
  "src/runs/background/owned-execution.ts": "f4606943c49ae74cf4ba9cd41973d2578bfa8d8551f65a47d12f9d32a9e390d4",
  "src/runs/background/owned-foreground.ts": null,
  "src/runs/background/owned-workflow.ts": "418112e64053ffb51bc107b11529c5e9206fd1b88744d366f5517912bc71435d",
  "src/runs/foreground/execution.ts": "4553d1272a7cbcca274e866f652a783034a43a8935dae132c2adf983c9277a52",
  "src/runs/foreground/subagent-executor.ts": "fbb96f31d10effa6143aa83eb6b573ab860c186784a5c3c9b55da2e2ca8d488e",
  "src/shared/types.ts": "fb3a79e9502fcc19655afb8c86dae7245861434d7fe15df4e305a1e8b95d14fd"
};
export function verifyOwnedForegroundPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Foreground scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedForegroundCandidate(root) {
	const source = prepareOwnedWorkflowCandidate(root);
	verifyOwnedForegroundPreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-foreground-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
