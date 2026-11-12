import type { EpochRegistry } from "./epochs.ts";
import type { LeaseManager } from "./leases.ts";
import { holderInfo } from "./leases.ts";
import { BROKER_PROTOCOL_VERSION, type AgentStatus, type BrokerStatus } from "./protocol.ts";
import type { AgentRegistry } from "./registry.ts";

export interface StatusSources {
	registry: AgentRegistry;
	leases: LeaseManager;
	epochs: EpochRegistry;
	pid: number;
	startedAt: number;
	now: number;
	paused: Map<string, { reason: "interfered_with_user"; at: number }>;
}

/**
 * The broker's own report of who holds what.
 *
 * Kept out of `BrokerCore` so the request handling and this read-only projection
 * stay separately readable; it only reads state, never decides anything.
 */
export function buildStatus(sources: StatusSources): BrokerStatus {
	const { registry, leases, epochs, now } = sources;
	const agents: AgentStatus[] = registry.all().map((record) => ({
		agentId: record.agentId,
		parentAgentId: record.parentAgentId,
		hasUI: record.hasUI,
		pid: record.pid,
		lastSeenAt: record.lastSeenAt,
		leases: leases.leasesOf(record.agentId).map((lease) => ({
			resourceKey: lease.resourceKey,
			leaseId: lease.leaseId,
			expiresAt: lease.expiresAt,
		})),
		...(sources.paused.has(record.agentId) ? { paused: sources.paused.get(record.agentId)! } : {}),
	}));
	const resources = epochs.entries().map(({ resourceKey, epoch }) => {
		const lease = leases.holder(resourceKey);
		return { resourceKey, epoch, holder: lease ? holderInfo(lease, now) : undefined };
	});
	return {
		protocolVersion: BROKER_PROTOCOL_VERSION,
		pid: sources.pid,
		startedAt: sources.startedAt,
		agents,
		resources,
		waiters: leases.waitersOf(),
		lastUserInputAt: registry.lastUserInputAt,
	};
}
