// Types for process-tree.mjs. The implementation ships as ESM because Node
// refuses to strip types inside node_modules, so the declarations live here.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export declare const MAX_ADAPTER_OUTPUT_BYTES_V1: number;

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
	stdin?: string;
}

export declare function executeProcessTreeV1(file: string, args: readonly string[], options: ProcessTreeOptionsV1): Promise<ProcessTreeResultV1>;

export type { ChildProcessWithoutNullStreams };
