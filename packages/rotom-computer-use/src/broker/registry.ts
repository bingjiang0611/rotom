import type { AgentRegistration } from "./protocol.ts";

export interface AgentRecord extends AgentRegistration {
	connectedAt: number;
	lastSeenAt: number;
	connected: boolean;
}

export interface AgentRegistryOptions {
	now: () => number;
	heartbeatTimeoutMs: number;
}

/**
 * Connected agents and their ancestry.
 *
 * `parentAgentId` is what makes approval routing work: an approval request goes
 * to the nearest ancestor that has a UI, so a subagent's confirmation appears in
 * the session that started it. Registration is per connection; an agent that
 * closes its socket or stops heartbeating is disconnected and loses its leases.
 */
export class AgentRegistry {
	private readonly agents = new Map<string, AgentRecord>();
	private readonly now: () => number;
	private readonly heartbeatTimeoutMs: number;
	lastUserInputAt: number | undefined;

	constructor(options: AgentRegistryOptions) {
		this.now = options.now;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
	}

	register(registration: AgentRegistration): AgentRecord {
		const at = this.now();
		const record: AgentRecord = {
			...registration,
			pidChain: [...registration.pidChain],
			connectedAt: at,
			lastSeenAt: at,
			connected: true,
		};
		this.agents.set(record.agentId, record);
		return record;
	}

	get(agentId: string): AgentRecord | undefined {
		return this.agents.get(agentId);
	}

	touch(agentId: string, at = this.now()): boolean {
		const record = this.agents.get(agentId);
		if (!record) return false;
		record.lastSeenAt = at;
		// A heartbeat resumes an agent that was marked stale but not yet dropped.
		record.connected = true;
		return true;
	}

	disconnect(agentId: string): boolean {
		const record = this.agents.get(agentId);
		if (!record) return false;
		if (!record.connected) return false;
		record.connected = false;
		return true;
	}

	remove(agentId: string): void {
		this.agents.delete(agentId);
	}

	/** Disconnect agents whose last heartbeat is older than the timeout. */
	sweep(): string[] {
		const at = this.now();
		const stale: string[] = [];
		for (const record of this.agents.values()) {
			if (!record.connected) continue;
			if (at - record.lastSeenAt >= this.heartbeatTimeoutMs) {
				record.connected = false;
				stale.push(record.agentId);
			}
		}
		return stale;
	}

	/** Self-first ancestry, bounded against cycles and bad input. */
	ancestors(agentId: string): AgentRecord[] {
		const chain: AgentRecord[] = [];
		const seen = new Set<string>();
		let current = this.agents.get(agentId);
		while (current && !seen.has(current.agentId) && chain.length < 16) {
			seen.add(current.agentId);
			chain.push(current);
			current = current.parentAgentId ? this.agents.get(current.parentAgentId) : undefined;
		}
		return chain;
	}

	/** The requesting agent's own UI if it has one, else the nearest ancestor UI. */
	nearestWithUI(agentId: string): AgentRecord | undefined {
		return this.ancestors(agentId).find((record) => record.connected && record.hasUI);
	}

	/** Connected agents with one role, e.g. every helper connection. */
	agentsWithRole(role: "agent" | "helper"): AgentRecord[] {
		return this.connectedAgents().filter((record) => (record.role ?? "agent") === role);
	}

	connectedAgents(): AgentRecord[] {
		return [...this.agents.values()].filter((record) => record.connected);
	}

	/** Connected agents that are not ancestors of the given agent. */
	others(agentId: string): AgentRecord[] {
		const excluded = new Set(this.ancestors(agentId).map((record) => record.agentId));
		return this.connectedAgents().filter((record) => !excluded.has(record.agentId));
	}

	all(): AgentRecord[] {
		return [...this.agents.values()];
	}

	clear(): void {
		this.agents.clear();
		this.lastUserInputAt = undefined;
	}
}
