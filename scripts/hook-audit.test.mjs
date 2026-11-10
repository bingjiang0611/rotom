import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditPlan, describeFailure } from "./hook-audit.mjs";

const ONE = "1".repeat(40);
const TWO = "2".repeat(40);
const ZERO = "0".repeat(40);
const HOOK = new URL("./hook-audit.mjs", import.meta.url).pathname;

describe("what a push adds", () => {
	it("uses the two sides for an existing ref and skips a deleted one", () => {
		const plans = auditPlan(
			[
				{ localRef: "refs/heads/main", localSha: ONE, remoteRef: "refs/heads/main", remoteSha: TWO },
				{ localRef: "(delete)", localSha: ZERO, remoteRef: "refs/heads/gone", remoteSha: ONE },
			],
			() => "",
		);
		assert.deepEqual(plans, [{ args: ["--history-range", `${TWO}..${ONE}`], range: `${TWO}..${ONE}` }]);
	});

	it("starts a new branch at the parent of its oldest unpublished commit", () => {
		const plans = auditPlan([{ localRef: "refs/heads/new", localSha: TWO, remoteRef: "refs/heads/new", remoteSha: ZERO }], (args) => {
			if (args[0] === "rev-list" && args.includes("--not")) return `unused\noldsest\noldest\n`;
			if (args[0] === "rev-list" && args.includes("--parents")) return `oldest parent\n`;
			throw new Error(`unexpected git call: ${args.join(" ")}`);
		});
		assert.deepEqual(plans, [{ args: ["--history-range", `parent..${TWO}`], range: `parent..${TWO}` }]);
	});

	it("falls back to the tracked tree when the branch has no parent to start from", () => {
		const plans = auditPlan([{ localRef: "refs/heads/first", localSha: ONE, remoteRef: "refs/heads/first", remoteSha: ZERO }], (args) => {
			if (args[0] === "rev-list" && args.includes("--not")) return "root\n";
			return "root\n"; // --parents lists the root commit alone
		});
		assert.deepEqual(plans, [{ args: [], treeOnly: "refs/heads/first" }]);
	});

	it("does not repeat a range and adds nothing when everything is already published", () => {
		const refs = [
			{ localRef: "refs/heads/a", localSha: ONE, remoteRef: "refs/heads/a", remoteSha: TWO },
			{ localRef: "refs/heads/b", localSha: ONE, remoteRef: "refs/heads/b", remoteSha: TWO },
			{ localRef: "refs/heads/c", localSha: ONE, remoteRef: "refs/heads/c", remoteSha: ZERO },
		];
		const plans = auditPlan(refs, (args) => (args[0] === "rev-list" ? "" : ""));
		assert.deepEqual(plans, [{ args: ["--history-range", `${TWO}..${ONE}`], range: `${TWO}..${ONE}` }]);
	});
});

describe("refusal text", () => {
	it("names rule, path and line without echoing the matched value", () => {
		const text = describeFailure({
			status: 1,
			stdout: JSON.stringify({
				status: "BLOCKED",
				findingCount: 2,
				findings: [
					{ rule: "personal-home-path", path: "docs/a.md", line: 4 },
					{ rule: "credential-shape", path: "b.txt", line: null },
				],
			}),
		});
		assert.match(text, /personal-home-path docs\/a\.md:4/u);
		assert.match(text, /credential-shape b\.txt/u);
	});

	it("reports an incomplete audit as such instead of as a clean run", () => {
		assert.match(describeFailure({ status: 2, stdout: JSON.stringify({ status: "BLOCKED", reason: "ValueError" }) }), /did not complete: ValueError/u);
		assert.match(describeFailure({ status: 1, stdout: "not json", stderr: "boom" }), /boom/u);
	});
});

describe("pre-push audit over a real push", () => {
	let directory;

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	function repository() {
		directory = mkdtempSync(join(tmpdir(), "rotom-push-audit-"));
		const cwd = join(directory, "work");
		mkdirSync(cwd);
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
		writeFileSync(env.GIT_CONFIG_GLOBAL, "");
		const git = (...args) => {
			const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		git("init", "-q", "--template=", "--initial-branch=main");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@users.noreply.github.com");
		const commit = (file, body, message) => {
			writeFileSync(join(cwd, file), body);
			git("add", "-A");
			git("commit", "-qm", message);
			return git("rev-parse", "HEAD");
		};
		return { cwd, env, git, commit };
	}

	function push({ cwd, env }, localSha, remoteSha = ZERO) {
		mkdirSync(join(cwd, "scripts"), { recursive: true });
		return spawnSync(process.execPath, [HOOK], {
			cwd,
			env,
			encoding: "utf8",
			input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
		});
	}

	it("passes a clean push and refuses a range that adds a private home path", () => {
		const repo = repository();
		const first = repo.commit("a.txt", "clean\n", "first");
		// A root commit leaves no range to name, so this push is judged by the tracked tree.
		const clean = push(repo, first);
		assert.equal(clean.status, 0, clean.stderr);
		assert.match(clean.stderr, /no history range exists/u);
		// Built from parts so this fixture does not itself look like a leaked home path to the audit.
		const homePath = ["", "Users", "someone", "notes.md"].join("/");
		const second = repo.commit("b.txt", homePath + "\n", "leaky path");
		const refused = push(repo, second, first);
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /personal-home-path b\.txt/u);
		assert.match(refused.stderr, new RegExp(`Range: ${first}\\.\\.${second}`, "u"));
		// A later clean commit in the same range shape passes, so the refusal is about this content.
		const third = repo.commit("b.txt", "notes.md\n", "clean it up");
		const allowed = push(repo, third, second);
		assert.equal(allowed.status, 0, allowed.stderr);
	});
});
