/**
 * Drives `replay.ts`: builds the isolated copy, runs the product, and keeps every artifact under
 * `~/.rotom/loop/replay-<stamp>/` with 0700 directories and 0600 files. Nothing is written to the
 * incident's own repository, and no case file is written to Git.
 */
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { REPLAY_TOOLS, refusalFor, readBranch, repositoryCheck, sandboxShim, scrubbedEnvironment, timepoint, type ReplayPlan } from "./replay.ts";

/** Files copied into the replay agent dir so the runtime can authenticate without an inherited env. */
const CREDENTIAL_FILES = ["auth.json", "models.json", "models-store.json"];

function git(cwd: string) {
	return (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function privateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`replay: refusing non-directory or symlink ${path}`);
}

export type ReplayRun = {
	label: string;
	product: string;
	repeat: number;
	exitCode: number | null;
	transcript: string;
	refusals: string[];
	toolCalls: string[];
	failed: boolean;
	error?: string;
};

export type ReplayOutcome = { outDir: string; plan: ReplayPlan; runs: ReplayRun[] };

/**
 * One repeat: a fresh worktree and agent dir, then the product in print mode with the failing
 * message. The product's own tool selection is narrowed to the replay allowlist.
 */
async function runOnce(options: {
	outDir: string;
	plan: ReplayPlan;
	product: { label: string; directory: string };
	repeat: number;
	agentSource: string;
	timeoutMs: number;
}): Promise<ReplayRun> {
	const { plan, product, repeat } = options;
	const base = join(options.outDir, product.label, `run-${repeat}`);
	await privateDir(base);
	const home = join(base, "home");
	const agent = join(home, "agent");
	const workspace = join(base, "worktree");
	await privateDir(home);
	await privateDir(agent);
	for (const name of CREDENTIAL_FILES) {
		try {
			await copyFile(join(options.agentSource, name), join(agent, name));
		} catch {
			// A missing credential file is a real answer: that provider is simply not available here.
		}
	}
	// A shared clone reads the project's objects without writing to that repository at all: adding a
	// worktree would register metadata in someone else's checkout.
	execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", plan.repoRoot, workspace], { stdio: ["ignore", "pipe", "pipe"] });
	const worktreeGit = git(workspace);
	worktreeGit(["checkout", "--quiet", "--detach", plan.commit]);
	for (const remote of worktreeGit(["remote"]).split("\n").filter(Boolean)) worktreeGit(["remote", "remove", remote]);
	// The branch file becomes the session the product resumes; it carries no credentials.
	const sessions = join(agent, "sessions");
	await privateDir(sessions);
	const branchFile = join(sessions, `${basename(plan.sessionFile).replace(/\.jsonl$/u, "")}-replay.jsonl`);
	await writeFile(branchFile, `${plan.branch.lines.join("\n")}\n`, { mode: 0o600 });
	const shim = join(home, "sandbox.sh");
	await writeFile(shim, sandboxShim(), { mode: 0o600 });

	const executable = join(product.directory, "bin", "rotom");
	const env = { ...scrubbedEnvironment(process.env, home), BASH_ENV: shim, PI_CODING_AGENT_DIR: agent };
	const args = [
		"--print",
		"--session",
		branchFile,
		"--session-dir",
		sessions,
		"--tools",
		REPLAY_TOOLS.join(","),
		"--model",
		plan.model.model,
		"--provider",
		plan.model.provider,
		plan.branch.message,
	];
	// The public bin is a shell entry that resolves its own symlink and then execs node.
	const run = spawn(executable, args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const collect = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
	};
	run.stdout.on("data", collect);
	run.stderr.on("data", collect);
	const timer = setTimeout(() => run.kill("SIGKILL"), options.timeoutMs);
	const exitCode = await new Promise<number | null>((done) => {
		run.on("error", () => done(null));
		run.on("close", (code) => done(code));
	});
	clearTimeout(timer);
	await writeFile(join(base, "transcript.txt"), output, { mode: 0o600 });
	const sessionFiles = await readdir(sessions).catch(() => [] as string[]);
	let sessionText = "";
	for (const name of sessionFiles) if (name.endsWith(".jsonl")) sessionText += await readFile(join(sessions, name), "utf8").catch(() => "");
	if (sessionText) await writeFile(join(base, "session.jsonl"), sessionText, { mode: 0o600 });
	const refusals = [...output.matchAll(/replay-sandbox: refused ([^\n]+)/gu)].map((match) => match[1] ?? "");
	const toolCalls = [...sessionText.matchAll(/"toolName":"([^"]+)"/gu)].map((match) => match[1] ?? "");
	return { label: product.label, product: product.directory, repeat, exitCode, transcript: output, refusals, toolCalls, failed: exitCode !== 0 };
}

/** Resolves the incident, pins the commit, and runs every repeat; the caller decides admission. */
export async function replayIncident(options: {
	incidentId: string;
	sessionFile: string;
	cwd: string;
	incidentTimestamp: string;
	entryId: string;
	products: { label: string; directory: string }[];
	repeats: number;
	outRoot: string;
	agentSource: string;
	model: { provider: string; model: string };
	timeoutMs?: number;
	stamp?: string;
}): Promise<ReplayOutcome> {
	const repository = repositoryCheck(git(options.cwd), options.cwd);
	if ("reason" in repository) throw new Error(`replay refused: ${repository.reason}`);
	const commit = timepoint(git(repository.root), options.incidentTimestamp);
	if (!commit) throw new Error(`replay refused: no commit at or before ${options.incidentTimestamp} in ${repository.root}`);
	const branch = readBranch(options.sessionFile, options.entryId);
	const plan: ReplayPlan = {
		incidentId: options.incidentId,
		sessionFile: options.sessionFile,
		cwd: options.cwd,
		repoRoot: repository.root,
		commit,
		branch,
		products: options.products,
		repeats: options.repeats,
		model: options.model,
	};
	const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/gu, "-");
	const outDir = resolve(options.outRoot, `replay-${stamp}`);
	await privateDir(outDir);
	await writeFile(join(outDir, "plan.json"), `${JSON.stringify({ ...plan, branch: { ...plan.branch, lines: plan.branch.lines.length } }, null, 2)}\n`, { mode: 0o600 });
	const runs: ReplayRun[] = [];
	for (const product of options.products) {
		for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
			runs.push(await runOnce({ outDir, plan, product, repeat, agentSource: options.agentSource, timeoutMs: options.timeoutMs ?? 20 * 60_000 }));
		}
	}
	await writeFile(
		join(outDir, "summary.json"),
		`${JSON.stringify({ incident: options.incidentId, commit, repeats: options.repeats, model: options.model, runs: runs.map(({ transcript, ...rest }) => ({ ...rest, transcriptBytes: transcript.length })) }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return { outDir, plan, runs };
}

export { refusalFor };
