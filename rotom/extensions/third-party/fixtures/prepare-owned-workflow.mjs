// Maintenance-only third layer; never apply to installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareOwnedExecutionCandidate } from "./prepare-owned-execution.mjs";
const preimages = {
	"src/runs/background/active-async-capacity.ts": "75a92a09594fae0330be6adc12e4bc1027ccbf57de77127d24ee460c0b43c481",
	"src/runs/background/async-execution.ts": "eaddb3ebffb67e4dcdca0ba90381764294d8fe1fb0df89fd8a00d06045b03d7d",
	"src/runs/background/async-resume.ts": "985d17b5d6af58773874a58c658f61772152c1ab4ef8b57f9b0bd53ea2c84a05",
	"src/runs/background/owned-execution.ts": "4d7232934a8e7c23aede2ad25c692ec8af65f4891989bd1240594cc4ce80811f",
	"src/runs/background/owned-workflow.ts": null,
	"src/runs/foreground/subagent-executor.ts": "ca6eca35ef02182a824ee90611ef02fca412da94a1529024e38b8bfe5c0a0014",
	"src/workflows/scripted-workflow.ts": "fba1677e0e563c7cd085eec61a2cb4f6741547f3c16f77fd8f874255f8138cd1",
};
export function verifyOwnedWorkflowPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Workflow scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedWorkflowCandidate(root) {
	const source = prepareOwnedExecutionCandidate(root);
	verifyOwnedWorkflowPreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-workflow-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
