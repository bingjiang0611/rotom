import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const installer = resolve("scripts/install-git-hooks.mjs");
const HOOKS = ["pre-commit", "commit-msg", "pre-push"];
let directory;
let cwd;
let env;

function run(command, args) {
	return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function git(...args) {
	const result = run("git", args);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function install() {
	return run(process.execPath, [installer]);
}

function hookSource(name) {
	return readFileSync(join(cwd, ".githooks", name), "utf8");
}

function installed(name) {
	return join(cwd, ".git", "rotom-hooks", name);
}

describe("git hook installation", () => {
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "rotom-hooks-install-"));
		cwd = join(directory, "work tree");
		mkdirSync(cwd);
		env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
		writeFileSync(env.GIT_CONFIG_GLOBAL, "");
		assert.equal(run("git", ["init", "--template=", "--initial-branch=main"]).status, 0);
		git("config", "user.name", "Hook Test");
		git("config", "user.email", "hook@example.noreply.github.com");
		git("config", "commit.gpgsign", "false");
		mkdirSync(join(cwd, ".githooks"));
		for (const name of HOOKS) {
			writeFileSync(join(cwd, ".githooks", name), readFileSync(resolve(join(".githooks", name)), "utf8"));
			chmodSync(join(cwd, ".githooks", name), 0o755);
		}
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it("installs each hook as a plain copy that names the source commit", () => {
		writeFileSync(join(cwd, "seed"), "");
		git("add", "seed");
		git("commit", "-m", "seed");
		const sha = git("rev-parse", "--short=12", "HEAD");
		const result = install();
		assert.equal(result.status, 0, result.stderr);
		for (const name of HOOKS) {
			const path = installed(name);
			assert.equal(lstatSync(path).isSymbolicLink(), false, `${name} must be a regular file`);
			const body = readFileSync(path, "utf8");
			assert.ok(body.includes("# rotom-hook-copy"), `${name} carries the copy marker`);
			assert.ok(body.includes(`at commit ${sha}`), `${name} names the source commit`);
			// The copy keeps the repository hook's own body and prepends a shebang-preserving header.
			assert.ok(body.endsWith(hookSource(name).split("\n").slice(1).join("\n")), `${name} body comes from the worktree`);
			assert.equal(lstatSync(path).mode & 0o111, 0o111, `${name} stays executable`);
		}
		assert.equal(realpathSync(git("config", "--local", "--get", "core.hooksPath")), realpathSync(join(cwd, ".git", "rotom-hooks")));
	});

	it("reinstalls from the edited repository hook instead of following an old copy", () => {
		assert.equal(install().status, 0);
		const extra = "# round 7 marker\n";
		writeFileSync(join(cwd, ".githooks", "pre-push"), `${hookSource("pre-push")}${extra}`);
		assert.equal(install().status, 0);
		assert.ok(readFileSync(installed("pre-push"), "utf8").includes(extra));
	});

	it("replaces the previous symlink scheme with a copy", () => {
		// Previous installs linked into a worktree's .githooks; the link is ours to replace.
		const hooksDir = join(cwd, ".git", "rotom-hooks");
		mkdirSync(hooksDir, { recursive: true });
		for (const name of HOOKS) symlinkSync(join(cwd, ".githooks", name), join(hooksDir, name));
		git("config", "--local", "core.hooksPath", hooksDir);
		const result = install();
		assert.equal(result.status, 0, result.stderr);
		for (const name of HOOKS) assert.equal(lstatSync(installed(name)).isSymbolicLink(), false, `${name} is now a copy`);
	});

	it("feeds the same commit range to the identity check and the range audit", () => {
		// The range arrives on stdin once; a guard that reads it first consumes it. Stubs record
		// what each one received, so the wiring is checked without running the real scans.
		const log = join(directory, "received.log");
		mkdirSync(join(cwd, "scripts"), { recursive: true });
		for (const name of ["hook-identity", "hook-audit"]) {
			writeFileSync(join(cwd, "scripts", `${name}.mjs`), `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name} `)} + JSON.stringify(readFileSync(0, "utf8")) + "\\n");\n`);
		}
		assert.equal(install().status, 0);
		const refs = "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n";
		const pushed = spawnSync("sh", [installed("pre-push"), "origin", "git@example.invalid:x.git"], { cwd, env, input: refs, encoding: "utf8" });
		assert.equal(pushed.status, 0, pushed.stderr);
		const received = readFileSync(log, "utf8").trim().split("\n");
		assert.equal(received.length, 2, received.join("\n"));
		assert.ok(received[0].startsWith("hook-identity "), received[0]);
		assert.ok(received[1].startsWith("hook-audit "), received[1]);
		for (const line of received) assert.ok(line.includes("1111111111111111111111111111111111111111"), line);
	});

	it("refuses a repository hook that is a symlink", () => {
		const elsewhere = join(directory, "other-worktree");
		mkdirSync(join(elsewhere, ".githooks"), { recursive: true });
		writeFileSync(join(elsewhere, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n");
		rmSync(join(cwd, ".githooks", "pre-push"));
		symlinkSync(join(elsewhere, ".githooks", "pre-push"), join(cwd, ".githooks", "pre-push"));
		const result = install();
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("is a symlink, not a regular file"));
		assert.equal(existsSync(join(cwd, ".git", "rotom-hooks", "pre-push")), false);
	});

	it("refuses a foreign hook at the destination and leaves it untouched", () => {
		const hooksDir = join(cwd, ".git", "rotom-hooks");
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\nexit 1\n");
		git("config", "--local", "core.hooksPath", hooksDir);
		const result = install();
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes("refusing to replace it"));
		assert.equal(readFileSync(join(hooksDir, "pre-push"), "utf8"), "#!/bin/sh\nexit 1\n");
		// A partial install must not leave some hooks copied and others not.
		assert.deepEqual(readdirSync(hooksDir), ["pre-push"]);
	});
});
