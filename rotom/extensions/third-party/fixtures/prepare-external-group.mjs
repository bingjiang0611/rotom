// Maintenance-only: fixed historical archive + candidate patch, never installed source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const preimages = {
	"src/runs/background/owned-process-tree.ts": "2eb4242149bafe04cf3409d0707466737300e109bd5af8dca4cbeb733a1e8ae9",
	"src/runs/shared/external-cli-runner.ts": "5cd3d774b72984011d19c364410c6283c7bf19bb88ed378a067144a4e7b3f4ab",
	"src/shared/types.ts": "de149423e18e47920cca0c6b0f13ca7ed460d904da7908c24c0f8bf442e9fc4b",
	"src/runs/background/process-terminal.ts": "c52f79ac35d018bf61b52522e5577573cff5438bf5b0ad6bc8c41f83ce9ac955",
	"src/runs/background/subagent-runner.ts": "33fd5bb13d1b2e4b1e43dd6940242f9c61600a90404828a497fba7c19940dd48",
	"src/runs/background/async-resume.ts": "171f5c6565d9d0c47dddef81bb168c36325170e8e7c82c26fabf53adae139a54",
	"src/runs/background/async-retention.ts": "fe09ebdd3ea09b43a96ed584f13244d12079a3a0b655e2a6e1aed7437d51a001",
};
export function verifyExternalGroupPreimages(source) {
	for (const [file, hash] of Object.entries(preimages)) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(source, file))).digest("hex"), hash, `Candidate preimage drift: ${file}`);
}
export function extractExternalGroupBaseline(source) {
	const stat = fs.lstatSync(source), canonical = fs.realpathSync(source);
	const repository = fs.realpathSync(path.resolve(import.meta.dirname, "../../../..")).toLowerCase();
	const comparison = canonical.toLowerCase();
	assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid());
	assert.ok(!comparison.split(path.sep).includes("node_modules") && comparison !== repository && !comparison.startsWith(`${repository}${path.sep}`));
	assert.deepEqual(fs.readdirSync(source), []);
	// This exact, previously inspected archive is historical input, never a registry fallback.
	const archive = path.resolve(import.meta.dirname, "../vendor/pi-subagents-0.52.1-dev-agent-followthrough.2.tgz");
	assert.ok(fs.lstatSync(archive).isFile() && !fs.lstatSync(archive).isSymbolicLink());
	assert.equal(createHash("sha512").update(fs.readFileSync(archive)).digest("base64"), "HaLHkYtSIbiwnq6CkCAzPwVRDLswRw/WvbkrlR9/UM9TPYJFTQqsAtHgWsFi+syOI73fQ0ZZXV+WdphDmHqBIg==");
	const extracted = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source], { encoding: "utf8", timeout: 10000 });
	assert.ifError(extracted.error); assert.equal(extracted.status, 0, extracted.stderr);
	assert.equal(JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version, "0.52.1-dev-agent-followthrough.2");
	verifyExternalGroupPreimages(source);
}
export function prepareExternalGroupCandidate(root) {
	const stat = fs.lstatSync(root), canonical = fs.realpathSync(root);
	assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), "Candidate root must be an existing private, owned, unlinked directory.");
	const repository = fs.realpathSync(path.resolve(import.meta.dirname, "../../../.."));
	// Also close case aliases on case-insensitive filesystems; this is a conservative maintenance boundary.
	const comparison = canonical.toLowerCase(), repositoryComparison = repository.toLowerCase();
	assert.ok(!comparison.split(path.sep).includes("node_modules") && comparison !== repositoryComparison && !comparison.startsWith(`${repositoryComparison}${path.sep}`), "Candidate root must be outside repository and node_modules.");
	assert.equal(fs.existsSync(path.join(canonical, "node_modules")), false, "Candidate dependencies must not overwrite an existing path.");
	const source = path.join(canonical, "candidate");
	// Exclusive reservation also rejects a dangling candidate symlink before copying.
	fs.mkdirSync(source, { mode: 0o700 });
	fs.mkdirSync(path.join(canonical, "node_modules"), { mode: 0o700 });
	const installed = path.resolve(import.meta.dirname, "../node_modules/pi-subagents");
	// Historical patch inputs stay pinned to the original archive, not whichever
	// product happens to be installed after the default source version changes.
	extractExternalGroupBaseline(source);
	// The zero-context maintenance patch may only be applied to these exact
	// copied preimages, not a merely version-compatible or concurrently changed tree.
	verifyExternalGroupPreimages(source);
	const dependencies = JSON.parse(fs.readFileSync(path.join(source, "package.json"))).dependencies;
	for (const name of ["acorn", "jiti", "typebox", "yaml"]) {
		const dependency = path.join(installed, "..", name);
		assert.equal(JSON.parse(fs.readFileSync(path.join(dependency, "package.json"))).version, dependencies[name], `Historical dependency drift: ${name}`);
		fs.cpSync(dependency, path.join(root, "node_modules", name), { recursive: true });
	}
	const patch = path.resolve(import.meta.dirname, "../subagent-external-group-candidate.patch");
	const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	for (const flags of [["--check"], []]) {
		const result = spawnSync("git", ["apply", "--unidiff-zero", ...flags, patch], { cwd: source, env, encoding: "utf8", timeout: 10000 });
		assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
	}
	return source;
}
