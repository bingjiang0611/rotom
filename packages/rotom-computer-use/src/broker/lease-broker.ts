import { BrokerClient, BrokerRequestError, BrokerUnavailableError } from "./client.ts";
import type { ApprovalDecision, ApprovalRequestEvent, BrokerEvent, TargetAppInfo } from "./protocol.ts";
import { StaleResourceStateError, LeaseUnavailableError, type LeaseAcquireRequest, type LeaseBroker, type LeaseGrant } from "../runtime.ts";

/**
 * Adapts the broker socket protocol to the scheduler's write seam.
 *
 * Two failure classes are kept distinct on purpose:
 * - a broker refusal the caller must report (`resource_busy`, `denied`, ...),
 * - a stale observation, which the bridge already knows how to recover from.
 */
export class ClientLeaseBroker implements LeaseBroker {
	private readonly client: BrokerClient;
	private readonly holders = new Map<string, { agentId: string; remainingMs: number }>();

	constructor(client: BrokerClient) {
		this.client = client;
	}

	get agentId(): string {
		return this.client.agentId;
	}

	async acquire(request: LeaseAcquireRequest): Promise<LeaseGrant> {
		try {
			const reply = await this.client.acquire({
				resourceKey: request.resourceKey,
				baseEpoch: request.baseEpoch,
				app: request.app,
				action: request.action,
			});
			this.holders.delete(request.resourceKey);
			return { leaseId: reply.lease.leaseId, epoch: reply.lease.epoch };
		} catch (error) {
			throw this.translate(request, error);
		}
	}

	async release(leaseId: string): Promise<void> {
		await this.client.release(leaseId).catch(() => undefined);
	}

	async refreshEpoch(resourceKey: string): Promise<number> {
		return await this.client.epoch(resourceKey);
	}

	holderOf(resourceKey: string): { agentId: string; remainingMs: number } | undefined {
		return this.holders.get(resourceKey);
	}

	/**
	 * Tell the broker that one of this agent's actions changed the frontmost app
	 * while the user was typing. The broker pauses the agent and revokes its leases.
	 */
	async reportInterference(evidence?: string): Promise<boolean> {
		return await this.client.reportInterference(evidence);
	}

	/** Release every lease this agent still owns, e.g. on session shutdown. */
	async releaseAll(): Promise<void> {
		const status = await this.client.status().catch(() => undefined);
		const leases = status?.agents.find((agent) => agent.agentId === this.client.agentId)?.leases ?? [];
		await Promise.all(leases.map((lease) => this.release(lease.leaseId)));
	}

	private translate(request: LeaseAcquireRequest, error: unknown): Error {
		if (error instanceof BrokerRequestError) {
			const reply = error.reply;
			switch (error.code) {
				case "stale": {
					const expected = reply.expectedEpoch ?? request.baseEpoch ?? 0;
					const current = reply.currentEpoch ?? 0;
					return new StaleResourceStateError(request.resourceKey, expected, current);
				}
				case "resource_busy": {
					const holder = reply.holder;
					if (holder) this.holders.set(request.resourceKey, { agentId: holder.agentId, remainingMs: holder.remainingMs });
					return new LeaseUnavailableError(
						"resource_busy",
						`${request.resourceKey} is currently held by agent ${holder?.agentId ?? "unknown"} (${holder?.remainingMs ?? 0}ms remaining).`,
						{ holder },
					);
				}
				case "denied":
					return new LeaseUnavailableError("denied", reply.message);
				case "approval_unavailable":
					return new LeaseUnavailableError("approval_unavailable", `${reply.message} No UI-capable session can confirm this action; ask the user in a session with a UI.`);
				case "approval_denied":
					return new LeaseUnavailableError("approval_denied", reply.message);
				case "stopped_by_user":
					return new LeaseUnavailableError("stopped_by_user", reply.message);
				case "paused_interfered":
					return new LeaseUnavailableError("paused_interfered", reply.message);
				default:
					return new LeaseUnavailableError("broker_unavailable", `${error.code}: ${reply.message}`);
			}
		}
		if (error instanceof BrokerUnavailableError) {
			return new LeaseUnavailableError("broker_unavailable", `${error.message} Set ROTOM_CU_BROKER=0 to run without cross-process arbitration.`);
		}
		return error instanceof Error ? error : new Error(String(error));
	}
}

/** A broker that cannot start must fail writes closed, not silently run local-only. */
export class UnavailableLeaseBroker implements LeaseBroker {
	private readonly reason: string;

	constructor(reason: string) {
		this.reason = reason;
	}

	async acquire(): Promise<LeaseGrant> {
		throw new LeaseUnavailableError("broker_unavailable", `${this.reason} Set ROTOM_CU_BROKER=0 to run without cross-process arbitration.`);
	}

	async release(): Promise<void> {}

	async refreshEpoch(): Promise<number> {
		return 0;
	}

	holderOf(): undefined {
		return undefined;
	}
}

export interface ConnectLeaseBrokerOptions {
	socketPath?: string;
	sessionId?: string;
	agentId: string;
	parentAgentId?: string;
	hasUI: boolean;
	pid?: number;
	pidChain?: number[];
	heartbeatMs?: number;
	onEvent?: (event: BrokerEvent) => void;
	onApproval?: (event: ApprovalRequestEvent) => Promise<ApprovalDecision>;
}

export interface ConnectedLeaseBroker {
	broker: ClientLeaseBroker;
	client: BrokerClient;
}

export async function connectLeaseBroker(options: ConnectLeaseBrokerOptions): Promise<ConnectedLeaseBroker> {
	const client = await BrokerClient.connect({
		socketPath: options.socketPath,
		agent: {
			agentId: options.agentId,
			parentAgentId: options.parentAgentId,
			hasUI: options.hasUI,
			pid: options.pid ?? process.pid,
			pidChain: options.pidChain ?? [],
		},
		spawnIfMissing: true,
		heartbeatMs: options.heartbeatMs,
		onEvent: options.onEvent,
		onApproval: options.onApproval,
	});
	return { broker: new ClientLeaseBroker(client), client };
}

/**
 * Broker mode is the macOS default and is off elsewhere until those platforms
 * have an equivalent helper surface. `ROTOM_CU_BROKER=0` restores the previous
 * per-process behavior on every platform.
 */
export function shouldUseBroker(input: { platform: NodeJS.Platform; configured: boolean }): boolean {
	if (!input.configured) return false;
	return input.platform === "darwin";
}

export type { TargetAppInfo };
