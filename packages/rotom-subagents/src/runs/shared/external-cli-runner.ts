import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { createOwnedProcessTreeController } from "../background/owned-process-tree.ts";
import { registerOwnedWriter, closeOwnedWriter } from "../background/owned-execution.ts";
import type { ExternalProcessStatus, ProcessTreeTerminalV1 } from "../../shared/types.ts";

const HARD_KILL_DELAY_MS = 2_000;
const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_ERROR_TAIL_BYTES = 64 * 1024;

export function buildExternalCliPrompt(systemInstructions: string, task: string): string {
	return `<System instructions>\n${systemInstructions.trim()}\n\n<Task>\n${task}`;
}

export interface ExternalCliRunResult {
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	externalProcess: ExternalProcessStatus;
}

export function runExternalCli(input: {
	ownedExecutionRequired?: boolean;
	command: string;
	args?: string[];
	cwd: string;
	prompt: string;
	asyncDir: string;
	stepIndex: number;
	registerTimeout?: (stop: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	onProcess?: (process: ExternalProcessStatus) => void;
	onStdout?: (chunk: Buffer) => void;
	onStderr?: (chunk: Buffer) => void;
}): Promise<ExternalCliRunResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const stdoutPath = path.join(input.asyncDir, `external-${input.stepIndex}.stdout.log`);
		const stderrPath = path.join(input.asyncDir, `external-${input.stepIndex}.stderr.log`);
		fs.mkdirSync(input.asyncDir, { recursive: true });
		const processInstanceId = registerOwnedWriter(input.asyncDir, "external-cli", input.stepIndex, undefined, input.ownedExecutionRequired);
		const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
		const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
		const streamsFinished = Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
		let stdoutTail = Buffer.alloc(0);
		let stderrTail = Buffer.alloc(0);
		let timedOut = false;
		let stopped = false;
		let settled = false;
		let cleanup: Promise<void> | undefined;
		let closeObserved = false;
		let resolveClose!: () => void;
		const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
		const child = spawn(input.command, input.args ?? [], {
			cwd: input.cwd,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		const initialProcess: ExternalProcessStatus = {
			processInstanceId,
			...(typeof child.pid === "number" ? { pid: child.pid } : {}),
			startedAt,
			stdoutPath,
			stderrPath,
		};
		const tree = child.pid ? createOwnedProcessTreeController(child.pid, { termGraceMs: HARD_KILL_DELAY_MS }) : undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutStream.write(chunk);
			input.onStdout?.(chunk);
			stdoutTail = Buffer.concat([stdoutTail, chunk]);
			if (stdoutTail.length > MAX_OUTPUT_TAIL_BYTES) stdoutTail = stdoutTail.subarray(stdoutTail.length - MAX_OUTPUT_TAIL_BYTES);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrStream.write(chunk);
			input.onStderr?.(chunk);
			stderrTail = Buffer.concat([stderrTail, chunk]);
			if (stderrTail.length > MAX_ERROR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MAX_ERROR_TAIL_BYTES);
		});
		const terminate = (reason: "timeout" | "stop") => {
			if (settled || timedOut || stopped) return;
			timedOut = reason === "timeout";
			stopped = reason === "stop";
			void finish();
		};
		let spawnError: Error | undefined;
		// Start cleanup on exit, not close: inherited stdio may keep close pending.
		// Cancellation and exit share one attempt; unknown never starts another.
		const finish = (): Promise<void> => cleanup ??= Promise.resolve().then(async () => {
			const processGroup: ProcessTreeTerminalV1 = tree ? await tree.terminate() : { state: "unknown", reason: "verification-failed" };
			let closeTimer: NodeJS.Timeout | undefined;
			await Promise.race([closed, new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 1000); })]);
			clearTimeout(closeTimer);
			const directCloseObserved = closeObserved;
			// Detached escapees may retain these descriptors. Bound our wait, not
			// their lifetime, and never turn forced pipe closure into exit evidence.
			if (!directCloseObserved) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
			settled = true;
			const exitCode = child.exitCode;
			const signal = child.signalCode;
			input.registerTimeout?.(undefined);
			input.registerStop?.(undefined);
			const endedAt = Date.now();
			const externalProcess: ExternalProcessStatus = {
				...initialProcess,
				...(directCloseObserved ? { endedAt, durationMs: endedAt - startedAt } : {}),
				exitCode,
				processSignal: signal,
				processGroup,
				directCloseObserved,
				descendantScope: "unverified",
			};
			input.onProcess?.(externalProcess);
			const stderr = stderrTail.toString("utf-8").trim();
			const executionUnknown = !directCloseObserved || processGroup.state !== "observed";
			const error = executionUnknown && !spawnError
				? "External execution unknown: closure unverified. Inspect the original run; do not retry or replace its writer."
				: stopped
				? input.stopMessage ?? "Subagent stopped by user."
				: timedOut
					? input.timeoutMessage ?? "Subagent timed out."
					: spawnError?.message ?? (exitCode === 0 ? undefined : stderr || `External CLI exited with code ${exitCode}.`);
			const result: ExternalCliRunResult = {
				output: stdoutTail.toString("utf-8").trim(),
				exitCode: timedOut || stopped || spawnError || executionUnknown ? 1 : exitCode,
				...(error ? { error } : {}),
				...(timedOut ? { timedOut: true } : {}),
				...(stopped ? { stopped: true } : {}),
				processSignal: signal,
				externalProcess,
			};
			stdoutStream.end();
			stderrStream.end();
			const streamResults = await streamsFinished;
			const streamFailure = streamResults.find((streamResult) => streamResult.status === "rejected");
			if (streamFailure?.status === "rejected") reject(streamFailure.reason);
			else {
				if (directCloseObserved) closeOwnedWriter(input.asyncDir, processInstanceId, processGroup, endedAt);
				resolve(result);
			}
		}).catch(reject);
		child.once("error", (error) => { spawnError = error; void finish(); });
		child.once("exit", () => { void finish(); });
		child.once("close", () => { closeObserved = true; resolveClose(); void finish(); });
		child.stdin.on("error", () => {});
		input.onProcess?.(initialProcess);
		input.registerTimeout?.(() => terminate("timeout"));
		input.registerStop?.(() => terminate("stop"));
		child.stdin.end(input.prompt);
	});
}
