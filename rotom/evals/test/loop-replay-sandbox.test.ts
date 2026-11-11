import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GUARD_MARKER, decideFileAccess, guardExtensionSource, installReplaySandbox, sandboxProfile } from "../src/loop/replay-sandbox.ts";

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "rotom-sandbox-"));
	made.push(dir);
	return dir;
}

afterEach(() => {
	while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

/** A stand-in for the host: a directory outside every sandbox root. */
function hostFile(): { dir: string; file: string } {
	const dir = scratch();
	const file = join(dir, "host-secret.txt");
	writeFileSync(file, "host content\n");
	return { dir, file };
}

describe("file tools stay inside the replay copy", () => {
	it("refuses an absolute host path for every path tool", () => {
		const base = scratch();
		const host = hostFile();
		for (const tool of ["read", "edit", "write", "grep", "find", "ls"]) {
			const reason = decideFileAccess(tool, { path: host.file }, [base]);
			expect(reason, tool).toContain(GUARD_MARKER);
			expect(reason, tool).toContain(host.file);
		}
	});

	it("allows a path inside the copy", () => {
		const base = scratch();
		mkdirSync(join(base, "src"));
		writeFileSync(join(base, "src", "inside.ts"), "export {};\n");
		expect(decideFileAccess("read", { path: join(base, "src", "inside.ts") }, [base])).toBeUndefined();
		expect(decideFileAccess("write", { path: join(base, "src", "new.ts") }, [base])).toBeUndefined();
	});

	it("refuses a symlink inside the copy that points at the host", () => {
		const base = scratch();
		const host = hostFile();
		symlinkSync(host.file, join(base, "escape.txt"));
		const reason = decideFileAccess("read", { path: join(base, "escape.txt") }, [base]);
		expect(reason).toContain(GUARD_MARKER);
		expect(reason).toContain(host.file);
	});

	it("refuses a relative traversal that resolves outside the copy", () => {
		const base = scratch();
		const host = hostFile();
		expect(decideFileAccess("read", { path: join(base, "..", "..", host.file) }, [base])).toContain(GUARD_MARKER);
	});
});

describe("the generated guard extension", () => {
	it("blocks the same host path the pure decision blocks", async () => {
		const base = scratch();
		const host = hostFile();
		const source = guardExtensionSource([base]);
		const file = join(base, "guard.mjs");
		writeFileSync(file, source);
		const loaded = (await import(pathToFileURL(file).href)) as {
			default: (pi: { on: (event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) => void }) => void;
		};
		let handler: ((event: { toolName: string; input: Record<string, unknown> }) => Promise<unknown>) | undefined;
		loaded.default({ on: (event, next) => { if (event === "tool_call") handler = next; } });
		expect(handler).toBeDefined();
		const blocked = await handler?.({ toolName: "read", input: { path: host.file } });
		expect(JSON.stringify(blocked)).toContain(GUARD_MARKER);
		const allowed = await handler?.({ toolName: "read", input: { path: join(base, "guard.mjs") } });
		expect(allowed).toBeUndefined();
		// The generated file carries the imported decision, so this also proves the import path works.
		expect(JSON.stringify(await handler?.({ toolName: "write", input: { path: host.file } }))).toContain(GUARD_MARKER);
	});

	it("refuses every path in a list argument", () => {
		const base = scratch();
		const host = hostFile();
		expect(decideFileAccess("read", { paths: [join(base, "ok.txt"), host.file] }, [base])).toContain(host.file);
	});
});

describe("shell commands run under sandbox-exec", () => {
	it("cannot write outside the run directory and can write inside it", async () => {
		const base = scratch();
		const host = hostFile();
		const home = join(base, "home");
		const agent = join(base, "agent");
		mkdirSync(home);
		mkdirSync(agent);
		const installed = await installReplaySandbox({ base, home, agent, workspace: base });
		const shell = join(home, "sandbox-shell");
		expect(readFileSync(join(home, "sandbox.sbpl"), "utf8")).toContain("(deny network*)");
		expect(installed.env.TMPDIR).toBe(join(base, "tmp"));
		const outside = join(host.dir, "written-by-agent.txt");
		const outsideRun = spawnSync(shell, ["-c", `printf x > ${outside}`], { encoding: "utf8" });
		expect(outsideRun.status).not.toBe(0);
		expect(existsSync(outside)).toBe(false);
		expect(`${outsideRun.stdout}${outsideRun.stderr}`).toMatch(/Operation not permitted/u);
		const inside = join(base, "inside.txt");
		const insideRun = spawnSync(shell, ["-c", `printf inside > ${inside}`], { encoding: "utf8" });
		expect(insideRun.status).toBe(0);
		expect(readFileSync(inside, "utf8")).toBe("inside");
	});

	it("cannot reach the network", async () => {
		const base = scratch();
		const home = join(base, "home");
		const agent = join(base, "agent");
		mkdirSync(home);
		mkdirSync(agent);
		await installReplaySandbox({ base, home, agent, workspace: base });
		const shell = join(home, "sandbox-shell");
		const run = spawnSync(shell, ["-c", `${process.execPath} -e 'fetch("http://example.com").then(r => console.log("code", r.status)).catch(e => console.log("ERR", e.cause?.code ?? e.message))'`], { encoding: "utf8", timeout: 30_000 });
		expect(`${run.stdout}${run.stderr}`).toMatch(/ERR/u);
		expect(run.stdout).not.toMatch(/code 20/u);
	});

	it("points Pi's shell at the wrapper instead of /bin/bash", async () => {
		const base = scratch();
		const home = join(base, "home");
		const agent = join(base, "agent");
		mkdirSync(home);
		mkdirSync(agent);
		await installReplaySandbox({ base, home, agent, workspace: base });
		const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) as { shellPath?: string };
		expect(settings.shellPath).toBe(join(home, "sandbox-shell"));
		expect(existsSync(join(agent, "extensions", "replay-isolation.ts"))).toBe(true);
	});

	it("keeps the profile's only writable roots inside the run", () => {
		const base = scratch();
		const profile = sandboxProfile(base);
		const real = realpathSync(base);
		expect(profile).toContain("(deny file-write*)");
		expect(profile).not.toContain(`(subpath "/Users")`);
		expect(profile).toContain(`(subpath "${real}")`);
	});
});

describe("a sandboxed shell can still do the replay's own work", () => {
	it("runs git, a read and a write inside the copy", async () => {
		const base = scratch();
		const home = join(base, "home");
		const agent = join(base, "agent");
		const workspace = join(base, "worktree");
		mkdirSync(home);
		mkdirSync(agent);
		mkdirSync(workspace);
		await installReplaySandbox({ base, home, agent, workspace });
		const shell = join(home, "sandbox-shell");
		const inside = [
			`cd ${workspace}`,
			"git init -q .",
			"printf 'export const answer = 42;\n' > answer.ts",
			"git add answer.ts",
			"git -c user.email=replay@example.invalid -c user.name=replay commit -qm 'replay work'",
			"git log --oneline | wc -l",
			"git status --porcelain | wc -l",
			`${process.execPath} -e 'console.log(require("node:fs").readFileSync("answer.ts","utf8").trim())'`,
		].join(" && ");
		const run = spawnSync(shell, ["-c", inside], { encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: join(base, "tmp") } });
		expect(run.stderr).not.toMatch(/Operation not permitted/u);
		expect(run.stdout).toContain("export const answer = 42;");
		expect(run.stdout).toContain("1");
	});
});
