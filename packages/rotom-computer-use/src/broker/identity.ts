import { execFileSync } from "node:child_process";
import type { AgentRegistration } from "./protocol.ts";

/**
 * Parent session id that the subagent host already exports when it spawns a
 * child Pi process. Using it avoids adding a second, computer-use-specific
 * parent identity variable.
 */
export const PARENT_AGENT_SESSION_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";

/** The stable agent identity for one Pi process: its own session. */
export function agentIdForSession(sessionId: string | undefined): string {
	const trimmed = sessionId?.trim();
	if (trimmed) return `session:${trimmed}`;
	return `process:${process.pid}`;
}

/**
 * Ancestor pids, nearest first.
 *
 * `ps` is the only dependency-free way to walk the chain. A failure (restricted
 * environment, missing `ps`) yields whatever was collected; host exclusion then
 * simply excludes fewer apps rather than failing the session.
 */
export function processAncestry(limit = 8, pid = process.pid): number[] {
	const chain: number[] = [];
	let current = pid;
	for (let depth = 0; depth < limit; depth += 1) {
		const parent = readParentPid(current);
		if (!parent || parent <= 1 || chain.includes(parent)) break;
		chain.push(parent);
		current = parent;
	}
	return chain;
}

function readParentPid(pid: number): number | undefined {
	try {
		const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
		const parsed = Number.parseInt(output.trim(), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export interface AgentIdentityInput {
	sessionId?: string;
	hasUI: boolean;
	pid?: number;
	/** Defaults to the live process ancestry. Tests pass a fixed chain. */
	pidChain?: number[];
	environment?: NodeJS.ProcessEnv;
}

export function agentRegistrationFor(input: AgentIdentityInput): AgentRegistration {
	const environment = input.environment ?? process.env;
	const parentSession = environment[PARENT_AGENT_SESSION_ENV]?.trim();
	const pid = input.pid ?? process.pid;
	const parentAgentId = parentSession ? agentIdForSession(parentSession) : undefined;
	return {
		agentId: agentIdForSession(input.sessionId),
		...(parentAgentId ? { parentAgentId } : {}),
		hasUI: input.hasUI,
		pid,
		pidChain: input.pidChain ?? (input.pid === undefined ? processAncestry() : []),
	};
}
