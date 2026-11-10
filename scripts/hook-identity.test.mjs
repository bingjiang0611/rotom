import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ANTHROPIC_NOREPLY,
	GITHUB_SERVICE,
	domainOf,
	identityAllowed,
	identityProblems,
	parsePushRefs,
	pendingCommitShas,
} from "./hook-identity.mjs";

const guard = resolve("scripts/hook-identity.mjs");
const installer = resolve("scripts/install-git-hooks.mjs");
const NOREPLY = "bingjiang0611@users.noreply.github.com";

describe("identity rule", () => {
	it("allows the noreply domain for both fields", () => {
		assert.equal(identityAllowed("author", NOREPLY), true);
		assert.equal(identityAllowed("committer", NOREPLY), true);
		assert.equal(identityAllowed("author", "12345+someone@users.noreply.github.com"), true);
	});

	it("allows the GitHub service address only as the committer of a web merge", () => {
		assert.equal(identityAllowed("committer", GITHUB_SERVICE), true);
		assert.equal(identityAllowed("author", GITHUB_SERVICE), false);
	});

	it("exempts exactly the Anthropic address, in either field, and refuses lookalikes", () => {
		assert.equal(identityAllowed("author", ANTHROPIC_NOREPLY), true);
		assert.equal(identityAllowed("committer", ANTHROPIC_NOREPLY), true);
		assert.equal(identityAllowed("author", "someone@anthropic.com"), false);
		assert.equal(identityAllowed("committer", "Noreply@anthropic.com"), false);
	});

	it("refuses a private domain, a lookalike of the noreply domain and an empty email", () => {
		assert.equal(identityAllowed("author", "someone@alibaba-inc.com"), false);
		assert.equal(identityAllowed("committer", "someone@alibaba-inc.com"), false);
		assert.equal(identityAllowed("author", "someone@users.noreply.github.com.example"), false);
		assert.equal(identityAllowed("author", ""), false);
		assert.equal(identityAllowed("author", "not-an-email"), false);
	});

	it("names every offending field and reports only the domain", () => {
		const problems = identityProblems([
			{ sha: "a".repeat(40), author: NOREPLY, committer: NOREPLY },
			{ sha: "b".repeat(40), author: "someone@alibaba-inc.com", committer: "someone@alibaba-inc.com" },
		]);
		assert.deepEqual(problems, [
			{ sha: "b".repeat(40), kind: "author", domain: "@alibaba-inc.com" },
			{ sha: "b".repeat(40), kind: "committer", domain: "@alibaba-inc.com" },
		]);
		assert.equal(domainOf("no-at-sign"), "(no domain)");
		assert.ok(!JSON.stringify(problems).includes("someone@"));
	});
});

describe("push ranges", () => {
	it("reads the pre-push stdin format and ignores blank or short lines", () => {
		const refs = parsePushRefs(`refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\n\nbroken\n`);
		assert.deepEqual(refs, [
			{ localRef: "refs/heads/main", localSha: "1".repeat(40), remoteRef: "refs/heads/main", remoteSha: "2".repeat(40) },
		]);
	});

	it("checks the range for an existing ref, unpublished history for a new one, nothing for a delete", () => {
		const calls = [];
		const git = (args) => {
			calls.push(args);
			return "c".repeat(40);
		};
		const one = "1".repeat(40);
		const two = "2".repeat(40);
		const zero = "0".repeat(40);
		const shas = pendingCommitShas(
			[
				{ localRef: "refs/heads/main", localSha: one, remoteRef: "refs/heads/main", remoteSha: two },
				{ localRef: "refs/heads/new", localSha: two, remoteRef: "refs/heads/new", remoteSha: zero },
				{ localRef: "(delete)", localSha: zero, remoteRef: "refs/heads/gone", remoteSha: one },
			],
			git,
		);
		assert.deepEqual(calls, [
			["rev-list", `${two}..${one}`],
			["rev-list", two, "--not", "--remotes"],
		]);
		// The same commit listed by two refs is judged once.
		assert.deepEqual(shas, ["c".repeat(40)]);
	});

	it("falls back to unpublished history when the remote side is not present locally", () => {
		const calls = [];
		const git = (args) => {
			calls.push(args);
			if (calls.length === 1) throw new Error("unknown revision");
			return "c".repeat(40);
		};
		const shas = pendingCommitShas([{ localRef: "refs/heads/main", localSha: "1".repeat(40), remoteRef: "refs/heads/main", remoteSha: "2".repeat(40) }], git);
		assert.deepEqual(calls.at(-1), ["rev-list", "1".repeat(40), "--not", "--remotes"]);
		assert.deepEqual(shas, ["c".repeat(40)]);
	});
});

describe("pre-push hook over a real push", () => {
	let directory;
	let cwd;
	let remote;
	let env;

	function run(command, args) {
		return spawnSync(command, args, { cwd, env, encoding: "utf8" });
	}

	function git(...args) {
		const result = run("git", args);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}

	function commit(message, author) {
		writeFileSync(join(cwd, `file-${message}.txt`), `${message}\n`);
		git("add", "-A");
		const args = ["commit", "-m", message];
		if (author) args.push("--author", `Hook Test <${author}>`);
		git(...args);
		return git("rev-parse", "HEAD");
	}

	function remoteMain() {
		return run("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).status;
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "dev-agent-identity-"));
		cwd = join(directory, "work tree");
		mkdirSync(cwd);
		remote = join(directory, "remote.git");
		env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
		writeFileSync(env.GIT_CONFIG_GLOBAL, "");
		assert.equal(run("git", ["init", "--bare", "--template=", remote]).status, 0);
		assert.equal(run("git", ["init", "--template=", "--initial-branch=main"]).status, 0);
		git("config", "user.name", "Hook Test");
		git("config", "user.email", NOREPLY);
		git("config", "commit.gpgsign", "false");
		git("remote", "add", "origin", remote);
		mkdirSync(join(cwd, ".githooks"));
		for (const name of ["pre-commit", "pre-push"]) {
			writeFileSync(join(cwd, ".githooks", name), readFileSync(resolve(join(".githooks", name)), "utf8"));
			chmodSync(join(cwd, ".githooks", name), 0o755);
		}
		mkdirSync(join(cwd, "scripts"));
		copyFileSync(guard, join(cwd, "scripts/hook-identity.mjs"));
		copyFileSync(resolve("scripts/check-staged-file-size.mjs"), join(cwd, "scripts/check-staged-file-size.mjs"));
		assert.equal(run(process.execPath, [installer]).status, 0);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it("blocks a push that would publish a private domain and names the fix", () => {
		const sha = commit("leaky", "someone@alibaba-inc.com");
		const pushed = run("git", ["push", "origin", "HEAD:refs/heads/main"]);
		assert.notEqual(pushed.status, 0);
		assert.ok(pushed.stderr.includes("Commit blocked"));
		assert.ok(pushed.stderr.includes("@alibaba-inc.com"));
		assert.ok(!pushed.stderr.includes("someone@alibaba-inc.com"));
		assert.ok(pushed.stderr.includes(sha.slice(0, 12)));
		assert.ok(pushed.stderr.includes("--reset-author"));
		assert.notEqual(remoteMain(), 0);
	});

	it("pushes after the identity is rewritten, without changing the tree", () => {
		const before = commit("leaky", "someone@alibaba-inc.com");
		const tree = git("rev-parse", "HEAD^{tree}");
		git("-c", `user.email=${NOREPLY}`, "commit", "--amend", "--no-edit", "--reset-author");
		assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
		assert.notEqual(git("rev-parse", "HEAD"), before);
		assert.equal(run("git", ["push", "origin", "HEAD:refs/heads/main"]).status, 0);
		assert.equal(remoteMain(), 0);
	});

	it("accepts noreply, a GitHub web merge committer and the Anthropic exemption", () => {
		commit("own identity");
		assert.equal(run("git", ["push", "origin", "HEAD:refs/heads/main"]).status, 0);
		// A web merge: GitHub keeps the author and writes its own service committer.
		commit("web merge");
		git("-c", `user.email=${GITHUB_SERVICE}`, "commit", "--amend", "--no-edit", "--author", `Hook Test <${NOREPLY}>`);
		assert.equal(git("log", "-1", "--format=%ce"), GITHUB_SERVICE);
		assert.equal(git("log", "-1", "--format=%ae"), NOREPLY);
		assert.equal(run("git", ["push", "origin", "HEAD:refs/heads/main"]).status, 0);
		commit("exempt author", ANTHROPIC_NOREPLY);
		assert.equal(run("git", ["push", "origin", "HEAD:refs/heads/main"]).status, 0);
	});

	it("refuses the GitHub service address as an author", () => {
		commit("service author", GITHUB_SERVICE);
		const pushed = run("git", ["push", "origin", "HEAD:refs/heads/main"]);
		assert.notEqual(pushed.status, 0);
		assert.ok(pushed.stderr.includes("author"));
	});

	it("checks every commit in the range, not only the tip", () => {
		commit("clean first");
		assert.equal(run("git", ["push", "origin", "HEAD:refs/heads/main"]).status, 0);
		commit("leaky second", "someone@alibaba-inc.com");
		commit("clean third");
		const pushed = run("git", ["push", "origin", "HEAD:refs/heads/main"]);
		assert.notEqual(pushed.status, 0);
		assert.ok(pushed.stderr.includes("leaky second"));
		assert.ok(!pushed.stderr.includes("clean third"));
	});
});
