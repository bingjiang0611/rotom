import { listProcessTree, type ProcessTreeEntry } from "../../utils/shell.ts";

/**
 * Shell commands have no default timeout, so a child blocked on something the terminal cannot show (a native
 * modal dialog, a hidden prompt) keeps the turn running silently. After this much silence the shell tool tells
 * the UI which processes are still running. It never kills anything and the model does not see it.
 */
const DEFAULT_IDLE_NOTICE_SECONDS = 60;
const IDLE_POLL_MAX_MS = 5_000;
const IDLE_PROCESS_SAMPLE_MS = 15_000;

export interface BashIdleNotice {
	/** Seconds since the last output, or since the start when there was none. */
	seconds: number;
	/** Processes still running under the shell, deepest last; absent when the backend did not report a pid. */
	processes?: ProcessTreeEntry[];
}

export interface IdleWatch {
	/** The shell pid, which leads its own process group on Unix. */
	setShellPid(pid: number): void;
	outputArrived(): void;
	/** The notice to attach to the next partial update, if the command is currently silent. */
	current(): BashIdleNotice | undefined;
	stop(): void;
}

/**
 * Calls `onIdle` whenever the notice changes; the caller re-emits its partial update with `current()`.
 * `seconds` defaults to 60; 0 disables the watch and returns undefined.
 */
export function startIdleWatch(seconds: number | undefined, onIdle: () => void): IdleWatch | undefined {
	const idleNoticeMs = (seconds ?? DEFAULT_IDLE_NOTICE_SECONDS) * 1000;
	if (!(idleNoticeMs > 0)) return undefined;
	let lastOutputAt = Date.now();
	let shellPid: number | undefined;
	let notice: BashIdleNotice | undefined;
	let sampling = false;
	let stopped = false;
	let lastSampleAt = 0;

	const check = async () => {
		if (stopped || sampling || Date.now() - lastOutputAt < idleNoticeMs) return;
		let processes = notice?.processes;
		if (
			shellPid !== undefined &&
			(!notice || Date.now() - lastSampleAt >= Math.min(IDLE_PROCESS_SAMPLE_MS, idleNoticeMs))
		) {
			sampling = true;
			try {
				processes = await listProcessTree(shellPid);
			} finally {
				sampling = false;
			}
			lastSampleAt = Date.now();
		}
		// Output may have resumed or the command finished while ps was running.
		const silentMs = Date.now() - lastOutputAt;
		if (stopped || silentMs < idleNoticeMs) return;
		notice = { seconds: Math.floor(silentMs / 1000), ...(processes ? { processes } : {}) };
		onIdle();
	};

	const timer = setInterval(
		() => void check().catch(() => {}),
		Math.max(50, Math.min(IDLE_POLL_MAX_MS, idleNoticeMs / 4)),
	);
	timer.unref?.();

	return {
		setShellPid(pid) {
			shellPid = pid;
		},
		outputArrived() {
			lastOutputAt = Date.now();
			notice = undefined;
		},
		current: () => notice,
		stop() {
			stopped = true;
			notice = undefined;
			clearInterval(timer);
		},
	};
}
