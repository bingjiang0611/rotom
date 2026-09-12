import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const MAX_ADAPTER_OUTPUT_BYTES_V1 = 1024 * 1024;
const TERM_GRACE_MS = 750;
const KILL_GRACE_MS = 2_000;

export type ProcessTreeTerminalOutcomeV1 = "exited" | "timeout" | "aborted" | "output-limit" | "spawn-error" | "unavailable";

export interface ProcessTreeResultV1 {
	code: number;
	signal: NodeJS.Signals | null;
	killed: boolean;
	stdout: string;
	stderr: string;
	terminal: {
		schemaVersion: 1;
		outcome: ProcessTreeTerminalOutcomeV1;
		confirmed: boolean;
		isolation: "host-process-group";
	};
}

export interface ProcessTreeOptionsV1 {
	timeoutMs: number;
	signal?: AbortSignal;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function groupExists(child: ChildProcessWithoutNullStreams): boolean {
	if (!child.pid) return false;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, 0);
		else process.kill(child.pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		return true;
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (predicate()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

async function terminateAndConfirm(child: ChildProcessWithoutNullStreams): Promise<boolean> {
	if (!groupExists(child)) return true;
	signalGroup(child, "SIGTERM");
	if (await waitUntil(() => groupExists(child), TERM_GRACE_MS)) return true;
	signalGroup(child, "SIGKILL");
	return waitUntil(() => groupExists(child), KILL_GRACE_MS);
}

/**
 * Spawn a CLI in its own POSIX process group. The promise never settles until
 * the entire group is gone, including descendants deliberately left behind by
 * an otherwise successful parent.
 */
export async function executeProcessTreeV1(
	file: string,
	args: readonly string[],
	options: ProcessTreeOptionsV1,
): Promise<ProcessTreeResultV1> {
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("process-tree timeoutMs 必须是正整数");
	const maxOutputBytes = options.maxOutputBytes ?? MAX_ADAPTER_OUTPUT_BYTES_V1;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("process-tree maxOutputBytes 必须是正整数");
	if (options.signal?.aborted) {
		return { code: -1, signal: null, killed: true, stdout: "", stderr: "", terminal: { schemaVersion: 1, outcome: "aborted", confirmed: true, isolation: "host-process-group" } };
	}

	const child = spawn(file, [...args], {
		cwd: options.cwd,
		env: options.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let capturedBytes = 0;
	let outcome: ProcessTreeTerminalOutcomeV1 = "exited";
	let terminationStarted = false;
	let forcedKillTimer: NodeJS.Timeout | undefined;

	const requestTermination = (next: ProcessTreeTerminalOutcomeV1) => {
		if (terminationStarted) return;
		terminationStarted = true;
		outcome = next;
		try { signalGroup(child, "SIGTERM"); } catch { /* final confirmation reports failure */ }
		forcedKillTimer = setTimeout(() => {
			try { signalGroup(child, "SIGKILL"); } catch { /* final confirmation reports failure */ }
		}, TERM_GRACE_MS);
	};
	const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
		const remaining = maxOutputBytes - capturedBytes;
		const accepted = remaining > 0 ? chunk.subarray(0, remaining) : chunk.subarray(0, 0);
		capturedBytes += accepted.byteLength;
		if (stream === "stdout") stdout += accepted.toString("utf8");
		else stderr += accepted.toString("utf8");
		if (accepted.byteLength < chunk.byteLength) requestTermination("output-limit");
	};
	child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
	const onAbort = () => requestTermination("aborted");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);

	let spawnError: unknown;
	await new Promise<void>((resolve) => {
		child.once("error", (error) => { spawnError = error; outcome = "spawn-error"; resolve(); });
		child.once("exit", () => resolve());
	});
	clearTimeout(timeout);
	if (forcedKillTimer) clearTimeout(forcedKillTimer);
	options.signal?.removeEventListener("abort", onAbort);

	const confirmed = await terminateAndConfirm(child).catch(() => false);
	if (!confirmed) outcome = "unavailable";
	if (spawnError && !stderr) stderr = spawnError instanceof Error ? spawnError.message : String(spawnError);
	return {
		code: child.exitCode ?? -1,
		signal: child.signalCode,
		killed: outcome !== "exited",
		stdout,
		stderr,
		terminal: { schemaVersion: 1, outcome, confirmed, isolation: "host-process-group" },
	};
}
