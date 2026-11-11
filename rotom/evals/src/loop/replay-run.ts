/**
 * Drives `replay.ts`: builds the isolated copy, runs the product, and keeps every artifact under
 * `~/.rotom/loop/replay-<stamp>/` with 0700 directories and 0600 files. Nothing is written to the
 * incident's own repository, and no case file is written to Git.
 */
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { REPLAY_TOOLS, productEntry, admissionFor, newTurnStats, originalTranscript, refusalFor, readBranch, repositoryCheck, sandboxShim, scrubbedEnvironment, timepoint, type Admission, type CheckVerdict, type NewTurnStats, type ReplayPlan } from "./replay.ts";

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
	/** Turns this replay produced, not the restored branch. */
	stats: NewTurnStats;
	check: CheckVerdict;
	checkOutput: string;
	failed: boolean;
	error?: string;
};

/** One admission per product label: the frozen product first, the current one when asked. */
export type ReplayOutcome = { outDir: string; plan: ReplayPlan; runs: ReplayRun[]; admissions: { label: string; admission: Admission }[] };

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
	check?: string;
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

	const entry = productEntry(product.directory, existsSync);
	if ("error" in entry) throw new Error(entry.error);
	const executable = entry.executable;
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
	// No exit code and no output means the product never started; the session file then holds only
	// the restored branch, so scoring it would report the original run's tool calls as this run's work.
	if (exitCode === null && output.length === 0) {
		return { label: product.label, product: product.directory, repeat, exitCode, transcript: output, refusals, stats: newTurnStats("", plan.branch.entryId), check: "unknown", checkOutput: "the product did not start", failed: true };
	}
	const stats = newTurnStats(sessionText, plan.branch.entryId, plan.branch.message);
	const session = join(base, "session.jsonl");
	const judged = await runCheck({ outDir: base, workspace, env, shim, transcript: join(base, "transcript.txt"), ...(existsSync(session) ? { session, cut: plan.branch.entryId, cutText: plan.branch.message, mode: "after" as const } : {}), check: options.check });
	return { label: product.label, product: product.directory, repeat, exitCode, transcript: output, refusals, stats, check: judged.verdict, checkOutput: judged.output, failed: exitCode !== 0 };
}

/**
 * The event's deterministic check, run in the same sandbox as the agent: same workspace, same
 * scrubbed environment, same shim, so a check cannot become the external write the agent was
 * refused. Exit 0 passes, exit 1 is the failure the event is about, anything else is `unknown`.
 */
/**
 * The zero-cost gate: apply the event's own check to what the original run produced, before
 * spending a single model call. A pass means the event was never a failure, so it is skipped and
 * counted as a harvest false positive; a check that cannot decide (it needs the original working
 * tree, which is gone) leaves the event in the queue.
 */
export async function originCheck(options: { sessionFile: string; entryId: string; check?: string }): Promise<{ verdict: CheckVerdict; output: string }> {
	if (!options.check) return { verdict: "unknown", output: "no --check was given, so the original run cannot be judged" };
	const transcript = originalTranscript(readFileSync(options.sessionFile, "utf8"), options.entryId);
	const { mkdtemp, writeFile: write, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const base = await mkdtemp(join(tmpdir(), "rotom-origin-"));
	const file = join(base, "transcript.txt");
	await write(file, transcript, { mode: 0o600 });
	const home = join(base, "home");
	await mkdir(home, { recursive: true, mode: 0o700 });
	const shim = join(base, "sandbox.sh");
	await write(shim, sandboxShim(), { mode: 0o600 });
	try {
		// The original checkout is not the replay's clone, so the check runs in an empty directory:
		// a check that inspects files reports unknown instead of reading the live repository.
		const judged = await runCheck({ outDir: base, workspace: base, env: scrubbedEnvironment(process.env, home), shim, transcript: file, session: options.sessionFile, cut: options.entryId, mode: "before", check: options.check });
		return judged;
	} finally {
		await rm(base, { recursive: true, force: true });
	}
}

async function runCheck(options: { outDir: string; workspace: string; env: NodeJS.ProcessEnv; shim: string; transcript: string; session?: string; cut?: string; cutText?: string; mode?: "before" | "after"; check?: string }): Promise<{ verdict: CheckVerdict; output: string }> {
	if (!options.check) return { verdict: "unknown", output: "no --check was given, so no run can be scored" };
	// `REPLAY_TRANSCRIPT` lets a check read the answer this run produced; `REPLAY_WORKSPACE` names
	// the clone. Neither is exported to the agent, so a check cannot leak into the run.
	const env = {
		...options.env,
		BASH_ENV: options.shim,
		REPLAY_TRANSCRIPT: options.transcript,
		REPLAY_WORKSPACE: options.workspace,
		...(options.session ? { REPLAY_SESSION: options.session } : {}),
		...(options.cut ? { REPLAY_CUT: options.cut } : {}),
		...(options.cutText ? { REPLAY_CUT_TEXT: options.cutText } : {}),
		// The original run is judged on the turn the person reacted to; a replay is judged on the
		// turns it produced after the same cut.
		...(options.mode ? { VIEW_MODE: options.mode } : {}),
	};
	const proc = spawn("/bin/bash", ["-c", options.check], { cwd: options.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const collect = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 64 * 1024) output = output.slice(-64 * 1024);
	};
	proc.stdout.on("data", collect);
	proc.stderr.on("data", collect);
	const code = await new Promise<number | null>((done) => {
		proc.on("error", () => done(null));
		proc.on("close", (value) => done(value));
	});
	await writeFile(join(options.outDir, "check.txt"), output, { mode: 0o600 });
	return { verdict: code === 0 ? "pass" : code === 1 ? "fail" : "unknown", output: output.slice(-2000) };
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
	/** Deterministic check per run; without it no run can be scored. */
	check?: string;
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
			runs.push(await runOnce({ outDir, plan, product, repeat, agentSource: options.agentSource, timeoutMs: options.timeoutMs ?? 20 * 60_000, ...(options.check ? { check: options.check } : {}) }));
		}
	}
	const admissions = options.products.map((product) => ({
		label: product.label,
		admission: admissionFor(runs.filter((run) => run.label === product.label).map((run) => run.check)),
	}));
	await writeFile(
		join(outDir, "summary.json"),
		`${JSON.stringify({ incident: options.incidentId, commit, repeats: options.repeats, model: options.model, check: options.check ?? null, admissions, runs: runs.map(({ transcript, ...rest }) => ({ ...rest, transcriptBytes: transcript.length })) }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return { outDir, plan, runs, admissions };
}

export { refusalFor };
