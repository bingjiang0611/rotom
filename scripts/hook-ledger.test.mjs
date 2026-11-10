import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDocPath, isTestPath, productChanges, trailerState } from "./hook-ledger.mjs";

const guard = resolve("scripts/hook-ledger.mjs");
const installer = resolve("scripts/install-git-hooks.mjs");
const LEDGER = "Ledger: L-2026-11-11-short-slug";

describe("which commits need a ledger trailer", () => {
	it("requires one for every shipped product root, at any depth", () => {
		for (const path of ["rotom/extensions/qoder/index.ts", "rotom/runtime/product-config.mjs", "rotom/skills/agent-loop/SKILL.md", "rotom/bin/rotom-launcher", "packages/rotom-pi/index.ts"]) {
			assert.deepEqual(productChanges([path]), [path]);
		}
	});

	it("excuses test, documentation and evals changes, including inside a product root", () => {
		const exempt = [
			"rotom/evals/src/loop/harvest.ts",
			"docs/agent/optimization-loop.md",
			"CLAUDE.md",
			"README.md",
			"rotom/extensions/observability/model-metadata.test.ts",
			"rotom/runtime/distribution.test.mjs",
			"scripts/test_audit_public.py",
			"packages/rotom-pi/test/coding-agent.test.ts",
		];
		assert.deepEqual(productChanges(exempt), []);
		for (const path of exempt.filter((path) => !path.startsWith("rotom/evals/")))
			assert.equal(isDocPath(path) || isTestPath(path), true, path);
	});

	it("treats a shipped skill document as product, not as repository documentation", () => {
		assert.deepEqual(productChanges(["rotom/skills/agent-loop/docs/notes.md"]), ["rotom/skills/agent-loop/docs/notes.md"]);
	});

	it("keeps the requirement when one product path is mixed with documentation", () => {
		assert.deepEqual(productChanges(["docs/agent/verification.md", "rotom/runtime/launch-runtime.mjs"]), ["rotom/runtime/launch-runtime.mjs"]);
	});

	it("accepts both trailer forms and rejects near misses", () => {
		assert.equal(trailerState(`Subject\n\n${LEDGER}\n`), "ledger");
		assert.equal(trailerState("Subject\n\nLedger: none — covered by the release gate\n"), "none");
		for (const message of [
			"Subject\n\nLedger: L-2026-11-11\n",
			"Subject\n\nLedger: none\n",
			"Subject\n\nLedger: none - plain hyphen\n",
			"Subject\n\n  Ledger: L-2026-11-11-short-slug\n",
			"Subject\n",
		])
			assert.equal(trailerState(message), "missing", message);
	});

	it("ignores commented template lines", () => {
		assert.equal(trailerState(`Subject\n\n# ${LEDGER}\n`), "missing");
	});
});

describe("commit-msg hook over a real commit", () => {
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

	function stage(path) {
		mkdirSync(join(cwd, path, ".."), { recursive: true });
		writeFileSync(join(cwd, path), `${path}\n`);
		git("add", "--", path);
	}

	function commit(message) {
		stage(`work-${Date.now()}.txt`);
		return run("git", ["commit", "-m", message]);
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "dev-agent-ledger-"));
		cwd = join(directory, "work tree");
		mkdirSync(cwd);
		env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
		writeFileSync(env.GIT_CONFIG_GLOBAL, "");
		assert.equal(run("git", ["init", "--template=", "--initial-branch=main"]).status, 0);
		git("config", "user.name", "Hook Test");
		git("config", "user.email", "hook@example.invalid");
		git("config", "commit.gpgsign", "false");
		mkdirSync(join(cwd, ".githooks"));
		for (const name of readdirSync(resolve(".githooks"))) {
			writeFileSync(join(cwd, ".githooks", name), readFileSync(resolve(".githooks", name), "utf8"));
			chmodSync(join(cwd, ".githooks", name), 0o755);
		}
		mkdirSync(join(cwd, "scripts"));
		for (const name of ["hook-identity.mjs", "hook-ledger.mjs", "check-staged-file-size.mjs"])
			copyFileSync(resolve(join("scripts", name)), join(cwd, "scripts", name));
		assert.equal(run(process.execPath, [installer]).status, 0);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it("blocks a product change without a trailer and names the file", () => {
		assert.equal(run("git", ["commit", "--allow-empty", "-m", "baseline"]).status, 0);
		stage("rotom/runtime/product-config.mjs");
		const blocked = run("git", ["commit", "-m", "change the product"]);
		assert.notEqual(blocked.status, 0);
		assert.ok(blocked.stderr.includes("needs a ledger entry"));
		assert.ok(blocked.stderr.includes("rotom/runtime/product-config.mjs"));
		assert.notEqual(run("git", ["rev-parse", "--verify", "HEAD"]).stdout.trim(), "");
		assert.equal(git("log", "-1", "--format=%s"), "baseline");
	});

	it("accepts a ledger entry and the explicit none form", () => {
		assert.equal(run("git", ["commit", "--allow-empty", "-m", "baseline"]).status, 0);
		stage("rotom/extensions/observability/model-metadata.ts");
		const ok = run("git", ["commit", "-m", `Withdraw the retry hint\n\n${LEDGER}`]);
		assert.equal(ok.status, 0, ok.stderr);
		stage("rotom/bin/rotom-launcher");
		const none = run("git", ["commit", "-m", "Release plumbing\n\nLedger: none — no behaviour change, release metadata only"]);
		assert.equal(none.status, 0, none.stderr);
	});

	it("judges an amend of an untrailered product commit", () => {
		assert.equal(run("git", ["commit", "--allow-empty", "-m", "baseline"]).status, 0);
		const bare = run("git", ["commit", "--allow-empty", "-m", "empty product commit"]);
		assert.equal(bare.status, 0, bare.stderr);
		stage("rotom/runtime/launch-runtime.mjs");
		const amend = run("git", ["commit", "--amend", "--no-edit"]);
		assert.notEqual(amend.status, 0);
		assert.ok(amend.stderr.includes("rotom/runtime/launch-runtime.mjs"));
	});

	it("lets a test-only commit through", () => {
		assert.equal(run("git", ["commit", "--allow-empty", "-m", "baseline"]).status, 0);
		stage("rotom/extensions/observability/model-metadata.test.ts");
		const ok = run("git", ["commit", "-m", "Add a focused regression"]);
		assert.equal(ok.status, 0, ok.stderr);
	});
});
