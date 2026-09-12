import { spawnSync } from "node:child_process";
import type { ProcessTreeTerminalV1 } from "../../shared/types.ts";

const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_VERIFY_MS = 1000;
const VERIFY_INTERVAL_MS = 25;
type SignalResult = "sent" | "absent" | { diagnostic: string };
type Members = number[] | { diagnostic: string };
function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function signalProcess(id: number, signal: NodeJS.Signals): SignalResult {
	try { process.kill(id, signal); return "sent"; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : { diagnostic: diagnostic(error) }; }
}

/** A malformed/empty/truncated ps snapshot is unavailable, never an empty group. */
export function parseOwnedProcessGroupSnapshot(stdout: string, processGroupId: number): Members {
	if (!stdout.trim()) return { diagnostic: "Empty process snapshot." };
	const members: number[] = [];
	for (const line of stdout.trim().split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) return { diagnostic: "Malformed process snapshot." };
		if (Number(match[2]) === processGroupId && !match[3]!.startsWith("Z")) members.push(Number(match[1]));
	}
	return members;
}
export function inspectOwnedProcessGroup(processGroupId: number, options: {
	probe?: () => void;
	snapshot?: () => { stdout: string; stderr: string; status: number | null; error?: unknown };
} = {}): Members {
	// ESRCH is sufficient. EPERM is not absence: a complete read-only snapshot
	// may independently prove no live members (including a zombie-only group).
	try { (options.probe ?? (() => process.kill(-processGroupId, 0)))(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return []; }
	const result = (options.snapshot ?? (() => spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf-8", timeout: 500, maxBuffer: 1024 * 1024 })))();
	if (result.error || result.status !== 0 || result.stderr.trim()) return { diagnostic: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "Process snapshot timed out." : "Process snapshot unavailable." };
	return parseOwnedProcessGroupSnapshot(result.stdout, processGroupId);
}

export interface OwnedProcessTreeController {
	terminate(): Promise<ProcessTreeTerminalV1>;
	finishAfterWriterClose(): Promise<ProcessTreeTerminalV1>;
}

/** Only for a freshly spawned detached child, never a PID recovered from disk.
 * One irreversible cleanup attempt. Group evidence does not cover setsid escape,
 * other sessions or remote effects; this is process management, not a sandbox.
 */
export function createOwnedProcessTreeController(pid: number, options: {
	termGraceMs?: number; killVerifyMs?: number;
	platform?: NodeJS.Platform;
	inspect?: () => Members;
	signal?: (id: number, signal: NodeJS.Signals) => SignalResult;
} = {}): OwnedProcessTreeController {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid owned process group id.");
	const posix = (options.platform ?? process.platform) !== "win32";
	const inspect = options.inspect ?? (() => inspectOwnedProcessGroup(pid));
	const signal = options.signal ?? signalProcess;
	const observed = (): ProcessTreeTerminalV1 => ({ state: "observed", mechanism: "posix-process-group", processGroupId: pid, verifiedAt: Date.now() });
	const unknown = (reason: "unsupported-platform" | "signal-failed" | "verification-failed", detail?: string): ProcessTreeTerminalV1 => ({ state: "unknown", reason, ...(detail ? { diagnostic: detail } : {}) });
	// false = positively observed no live members; undefined = still active.
	const wait = async (ms: number): Promise<false | undefined | { diagnostic: string }> => {
		const deadline = Date.now() + ms;
		for (;;) {
			const members = inspect();
			if (Array.isArray(members) && !members.length) return false;
			if (Date.now() >= deadline) return Array.isArray(members) ? undefined : members;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, deadline - Date.now())));
		}
	};
	let termination: Promise<ProcessTreeTerminalV1> | undefined;
	const terminate = (): Promise<ProcessTreeTerminalV1> => termination ??= Promise.resolve().then(async () => {
		if (!posix) { signal(pid, "SIGTERM"); return unknown("unsupported-platform"); }
		const before = inspect();
		if (Array.isArray(before) && !before.length) return observed();
		// Creation-time ownership authorizes this one bounded TERM/KILL sequence.
		// A failed read-only probe must not silently disable cancellation. Wait
		// through the grace, but never promote unavailable evidence to observed.
		for (const [sig, ms] of [["SIGTERM", options.termGraceMs ?? DEFAULT_TERM_GRACE_MS], ["SIGKILL", options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS]] as const) {
			const sent = signal(-pid, sig);
			if (sent === "absent") return observed(); // ESRCH is latched; no later PID/PGID replay.
			if (sent !== "sent") return unknown("signal-failed", sent.diagnostic);
			const remaining = await wait(ms);
			if (remaining === false) return observed();
			if (remaining && sig === "SIGKILL") return unknown("verification-failed", remaining.diagnostic);
		}
		return unknown("verification-failed", "Owned process group still has live members after escalation.");
	}).catch((error) => unknown("verification-failed", diagnostic(error)));
	return { terminate, finishAfterWriterClose: terminate };
}
