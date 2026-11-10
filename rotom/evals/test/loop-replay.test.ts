import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cutBranch, forbiddenCopies, refusalFor, repositoryCheck, sandboxShim, scrubbedEnvironment, timepoint } from "../src/loop/replay.ts";

const header = JSON.stringify({ type: "session", version: 1, id: "session-1", timestamp: "2026-11-01T00:00:00Z", cwd: "/repo" });
const user = (id: string, text: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-01T00:01:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, text: string) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-01T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("replay branch cutting", () => {
	it("keeps everything before the failing user message and returns that message", () => {
		const branch = cutBranch([header, user("u1", "add a test"), assistant("a1", "done"), user("u2", "you never ran it")], "u2");
		expect(branch.message).toBe("you never ran it");
		expect(branch.userTurns).toBe(1);
		expect(branch.lines).toHaveLength(3);
		expect(branch.lines[0]).toBe(header);
		// The assistant turn that answered the earlier request stays in the history.
		expect(branch.lines.at(-1)).toContain("done");
	});

	it("refuses an entry that is not a user message", () => {
		expect(() => cutBranch([header, user("u1", "x"), assistant("a1", "y")], "a1")).toThrow(/not a user message/u);
	});

	it("refuses a missing entry and a file without a session header", () => {
		expect(() => cutBranch([header, user("u1", "x")], "nope")).toThrow(/no entry/u);
		expect(() => cutBranch([user("u1", "x")], "u1")).toThrow(/no session header/u);
		expect(() => cutBranch([], "u1")).toThrow(/empty session file/u);
	});

	it("refuses an entry whose text is empty", () => {
		const empty = JSON.stringify({ type: "message", id: "u0", message: { role: "user", content: [] } });
		expect(() => cutBranch([header, empty], "u0")).toThrow(/no text/u);
	});
});

describe("replay sandbox", () => {
	it("refuses every command that would leave the worktree", () => {
		for (const command of ["git push origin main", "npm publish", "gh pr create", "ssh host", "scp a b", "rsync -a a b", "curl -X POST https://x", "curl -d @f https://x", "wget --post-data=x https://x"]) {
			expect(refusalFor(command), command).toBeDefined();
		}
	});

	it("allows the read-only variants", () => {
		for (const command of ["git status", "npm test", "curl https://x", "git log --oneline -1", "node --test"]) expect(refusalFor(command), command).toBeUndefined();
	});

	it("keeps the shell shim and the plan in agreement on the refusal exit code", () => {
		const shim = sandboxShim();
		expect(shim).toContain("return 97");
		for (const name of ["git", "npm", "gh", "ssh", "scp", "rsync", "curl", "wget"]) expect(shim).toContain(`${name}() {`);
	});

	it("makes the shim refuse a push in a real shell", () => {
		const directory = mkdtempSync(join(tmpdir(), "replay-shim-"));
		try {
			const shim = join(directory, "sandbox.sh");
			writeFileSync(shim, sandboxShim());
			const run = (command: string) => {
				try {
					return { code: 0, out: execFileSync("bash", ["-c", command], { env: { ...process.env, BASH_ENV: shim }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
				} catch (error) {
					const failure = error as { status?: number; stderr?: string };
					return { code: failure.status ?? -1, out: failure.stderr ?? "" };
				}
			};
			expect(run("git push").code).toBe(97);
			expect(run("git push").out).toContain("replay-sandbox: refused git push");
			expect(run("gh pr list").code).toBe(97);
			expect(run("true").code).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("replay environment", () => {
	it("drops provider and tool credentials and gives the child its own HOME", () => {
		const env = scrubbedEnvironment({
			PATH: "/usr/bin",
			HOME: "/tmp/somebody",
			OPENAI_API_KEY: "sk-x",
			GITHUB_TOKEN: "ghp-x",
			AWS_SECRET_ACCESS_KEY: "x",
			NPM_TOKEN: "npm_x",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			SOME_PASSWORD: "x",
			LANG: "en_US.UTF-8",
			PI_CODING_AGENT_DIR: "/tmp/somebody/.pi/agent",
		}, "/tmp/replay/home");
		expect(env.HOME).toBe("/tmp/replay/home");
		expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/replay/agent");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.LANG).toBe("en_US.UTF-8");
		for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "SSH_AUTH_SOCK", "SOME_PASSWORD"]) expect(env[name]).toBeUndefined();
	});

	it("names the tracked files a replay must not carry over", () => {
		expect(forbiddenCopies("/w", ["src/a.ts", ".npmrc", ".env.local", "docs/.env"])).toEqual([".npmrc", ".env.local", "docs/.env"]);
	});
});

describe("replay timepoint", () => {
	const directory = mkdtempSync(join(tmpdir(), "replay-timepoint-"));
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	function repo(): string {
		const root = join(directory, `repo-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const git = (args: string[] | string) => execFileSync("git", ["-C", root, ...(Array.isArray(args) ? args : [args])], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "", GIT_COMMITTER_DATE: "" } });
		git(["init", "-q"]);
		git(["config", "user.email", "replay@example.invalid"]);
		git(["config", "user.name", "Replay"]);
		for (const [name, day] of [["a.txt", "2026-11-01T00:00:00Z"], ["b.txt", "2026-11-05T00:00:00Z"]]) {
			writeFileSync(join(root, name), name);
			git(["add", name]);
			execFileSync("git", ["-C", root, "commit", "-q", "-m", name], { env: { ...process.env, GIT_AUTHOR_DATE: day, GIT_COMMITTER_DATE: day } });
		}
		return root;
	}

	it("picks the last commit at or before the session time", () => {
		const root = repo();
		const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
		expect(repositoryCheck(git, root)).toEqual({ root: expect.stringContaining("repo-") });
		const before = timepoint(git, "2026-11-03T00:00:00Z");
		expect(before).toBe(git(["rev-list", "-1", "HEAD~1"]).trim());
		expect(timepoint(git, "2026-11-06T00:00:00Z")).toBe(git(["rev-parse", "HEAD"]).trim());
	});

	it("returns nothing when no commit precedes the session time", () => {
		const root = repo();
		const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
		expect(timepoint(git, "2026-10-01T00:00:00Z")).toBeUndefined();
	});

	it("refuses a directory that is not a git repository", () => {
		const plain = join(directory, "plain");
		mkdirSync(plain, { recursive: true });
		const git = () => {
			throw new Error("not a git repository");
		};
		expect(repositoryCheck(git, plain)).toEqual({ reason: `${plain} is not a git repository` });
		expect(repositoryCheck(git, join(directory, "gone"))).toEqual({ reason: expect.stringContaining("no longer exists") });
	});
});
