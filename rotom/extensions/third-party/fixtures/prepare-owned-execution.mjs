// Maintenance-only second layer. The fourth-batch candidate remains independently testable.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareExternalGroupCandidate } from "./prepare-external-group.mjs";
const preimages = {
	"src/extension/config.ts": "5153d78b1b89fbcb80f213e385839e6c40ecbeea2e6e44b31339cefb9f4d21ff",
	"src/runs/background/active-async-capacity.ts": "4fd26723d6ddd0cf1a2bcce729c840439857f0f9c53f2fc87afc5b73beeeab55",
	"src/runs/background/async-execution.ts": "5a07f6bf8e29f78ae8a8464e5a120446877d59d3484577db6ba15a91e309ea25",
	"src/runs/background/async-resume.ts": "62b090e2c04fa61b042c9ee56d9862179499623870c249fc323e25aa1c3c272b",
	"src/runs/background/async-retention.ts": "0ecd3049dad062c5e604734398a366912da05570891e0d55ec022e3ed525eb0e",
	"src/runs/background/owned-execution.ts": null,
	"src/runs/background/process-terminal.ts": "73a4251dadb6592ab495d4c3725254c62d0778394b502f3cd2f8684ea67cb549",
	"src/runs/background/subagent-runner.ts": "e27226af12092fd5dabbcc1fc74abc70ecc0d50bd454805dafc2608b690d2299",
	"src/runs/foreground/subagent-executor.ts": "47ff77360baa52dcbbf516128cdc6f46010b9706f879c878cda3f416d3f5fa7c",
	"src/runs/shared/external-cli-runner.ts": "b101760247f59fc1a6881f0f75470c6a61845bfc2774db8f575a8a991757942c",
	"src/shared/types.ts": "e6657cfbd17c112070ec06cdbdf2b0a13af7164f6bba8184d390fdca2c0156aa",
};
export function verifyOwnedExecutionPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) {
		const target = path.join(source, file);
		let stat;try { stat=fs.lstatSync(target); } catch(e) { if(e.code!=="ENOENT")throw e; }
		if (hash === null) assert.equal(stat, undefined, `New candidate path already exists: ${file}`);
		else {
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Invalid preimage file: ${file}`);
			assert.equal(createHash("sha256").update(fs.readFileSync(target)).digest("hex"), hash, `Owned scope preimage drift: ${file}`);
		}
	}
}
export function prepareOwnedExecutionCandidate(root) {
	const source = prepareExternalGroupCandidate(root);
	verifyOwnedExecutionPreimages(source);
	const patch = path.resolve(import.meta.dirname, "../subagent-owned-execution-candidate.patch");
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, timeout: 10000, encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
