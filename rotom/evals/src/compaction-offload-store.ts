import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { BudgetSnapshot, ReplayAuthorization } from "./compaction-offload-budget.ts";
import type { ReplayMetrics } from "./compaction-offload-metrics.ts";
import { ensurePrivateEvalArtifactDirectory } from "./vitest-evals/artifacts.ts";

export type LiveReplayRow = {
	version: 1; authorizationId: string; timestamp: string; task: string; arm: "baseline" | "candidate"; repetition: number; repetitions: number;
	status: "completed" | "failed" | "not-run"; reason: BudgetSnapshot["stopReason"];
	provider: string; model: string; thinking: string; transport: "sse"; sourceCommit: string; sourceDirty: boolean;
	contextWindow: number | null; thresholdTokens: number; reserveTokens: number | null;
	metrics: ReplayMetrics | null; cumulative: BudgetSnapshot;
};
export const defaultReplayDirectory = () => join(homedir(), ".rotom/evals/compaction-offload");

function rejectGitTree(path: string) {
	const env = { ...process.env, LC_ALL: "C" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"]) delete (env as NodeJS.ProcessEnv)[key];
	const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", env });
	if (result.status === 0) throw new Error("Replay metrics must be outside Git worktrees");
	if (result.status !== 128 || !result.stderr.includes("not a git repository")) throw new Error("Cannot prove the replay directory is outside a Git worktree");
}

export async function createReplayStore(authorization: ReplayAuthorization, directory = defaultReplayDirectory(), repetitions = authorization.maxRepetitions) {
	// Check an existing ancestor before mkdir, then the canonical directory too.
	let ancestor = resolve(directory);
	for (;;) {
		try { await lstat(ancestor); break; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
	}
	rejectGitTree(ancestor);
	const root = await ensurePrivateEvalArtifactDirectory(resolve(directory));
	rejectGitTree(root);
	if (((await lstat(root)).mode & 0o777) !== 0o700) throw new Error("Replay directory must have mode 0700");
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const path = join(root, `${timestamp}.jsonl`);
	const id = createHash("sha256").update(authorization.id).digest("hex");
	// One authorized campaign, not a reusable flag. Never delete/replace this
	// receipt automatically, including when setup or a provider request fails.
	const receipt = await open(join(root, `authorization-${id}.json`), "wx", 0o600);
	try {
		await receipt.writeFile(JSON.stringify({ authorization, repetitions, metricsFile: path, startedAt: timestamp }) + "\n");
		await receipt.sync();
	} finally { await receipt.close(); }
	const file = await open(path, "wx", 0o600);
	await file.close();
	let poisoned = false;
	return {
		path,
		async append(row: LiveReplayRow) {
			if (poisoned) throw new Error("Replay metrics write is unknown; no retry");
			try {
				if (await realpath(root) !== root) throw new Error("Replay directory identity changed");
				await ensurePrivateEvalArtifactDirectory(root, root);
				rejectGitTree(root);
				const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
				try {
					const stat = await handle.stat();
					if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Replay metrics file must be a private regular file");
					await handle.writeFile(JSON.stringify(row) + "\n");
					await handle.sync();
				} finally { await handle.close(); }
			} catch (error) { poisoned = true; throw error; }
		},
	};
}
