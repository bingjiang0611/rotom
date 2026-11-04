import { EpochRegistry } from "./epochs.ts";
import { LeaseManager, toLeaseInfo, holderInfo, realSchedule, type Lease, type Schedule } from "./leases.ts";
import {
	BROKER_PROTOCOL_VERSION,
	DEFAULT_APPROVAL_TIMEOUT_MS,
	DEFAULT_HEARTBEAT_TIMEOUT_MS,
	DEFAULT_LEASE_TTL_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	failure,
	type AcquireRequest,
	type ActionIntent,
	type AgentStatus,
	type AppTier,
	type ApprovalDecision,
	type BrokerEvent,
	type BrokerReply,
	type BrokerRequest,
	type BrokerStatus,
	type TargetAppInfo,
} from "./protocol.ts";
import { AgentRegistry, type AgentRecord } from "./registry.ts";

export interface PolicyCheckInput {
	agentId: string;
	resourceKey: string;
	app?: TargetAppInfo;
	action?: ActionIntent;
	/** Session working directory, so the broker can apply the tighter project policy. */
	cwd?: string;
}

export interface PolicyDecision {
	tier: AppTier;
	/** Shown on the approval card; present for high-risk app categories. */
	warning?: string;
	/** False when the tier already allows the action without asking the user. */
	requiresApproval: boolean;
	/** Set when the app is denied outright (policy `deny` or an unreadable policy file). */
	denied?: string;
	/** Stable identity used for the per-session approval cache. */
	cacheKey: string;
}

export interface PolicyGate {
	check(input: PolicyCheckInput): PolicyDecision;
	/** Persist a permanent grant ("始终允许"). */
	allowApp(app: TargetAppInfo | undefined, tier: AppTier): void;
	/** Effective tier without an action check, used when persisting a grant. */
	tierForApp(app: TargetAppInfo | undefined, fallbackKey: string): AppTier;
	describe(): Record<string, unknown>;
}

export const permissivePolicy: PolicyGate = {
	check(input) {
		return { tier: "full", requiresApproval: false, cacheKey: input.app?.bundleId ?? input.app?.appName ?? input.resourceKey };
	},
	allowApp() {},
	tierForApp() {
		return "full";
	},
	describe() {
		return { apps: {}, sensitive: false };
	},
};

export interface BrokerTransport {
	/** Deliver an unsolicited event to one agent; false when it is not connected. */
	send(agentId: string, event: BrokerEvent): boolean;
	connectedAgents(): number;
}

export interface BrokerCoreOptions {
	now?: () => number;
	schedule?: Schedule;
	leaseTtlMs?: number;
	waitTimeoutMs?: number;
	heartbeatTimeoutMs?: number;
	approvalTimeoutMs?: number;
	policy?: PolicyGate;
	pid?: number;
}

interface PendingApproval {
	requestId: string;
	agentId: string;
	cacheKey: string;
	resolve(decision: ApprovalDecision | "timeout" | "unavailable"): void;
	cancelTimer: () => void;
}

/**
 * Broker semantics, independent of transport.
 *
 * Holds the registry, leases and epochs, and executes one request at a time
 * semantics per resource. The socket layer only frames JSON lines and calls
 * `handle`, which keeps every arbitration rule testable without sockets.
 */
export class BrokerCore {
	readonly epochs = new EpochRegistry();
	readonly registry: AgentRegistry;
	readonly leases: LeaseManager;
	readonly startedAt: number;
	private readonly now: () => number;
	private readonly schedule: Schedule;
	private readonly policy: PolicyGate;
	private readonly approvalTimeoutMs: number;
	private readonly pid: number;
	private readonly sessionApprovals = new Map<string, AppTier>();
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private transport: BrokerTransport | undefined;
	private approvalCounter = 0;

	constructor(options: BrokerCoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? realSchedule;
		this.startedAt = this.now();
		this.pid = options.pid ?? process.pid;
		this.policy = options.policy ?? permissivePolicy;
		this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		this.registry = new AgentRegistry({
			now: this.now,
			heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
		});
		this.leases = new LeaseManager(this.epochs, {
			now: this.now,
			schedule: options.schedule,
			ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
			waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
		});
		this.leases.onRevoke = (revocation) => {
			this.transport?.send(revocation.agentId, { event: "revoked", ...revocation });
		};
	}

	attachTransport(transport: BrokerTransport): void {
		this.transport = transport;
	}

	/** A transport dropped one agent: revoke its leases and forget it. */
	handleDisconnect(agentId: string): void {
		this.leases.revokeAgent(agentId, "owner_disconnected");
		this.registry.disconnect(agentId);
		this.registry.remove(agentId);
	}

	/** Periodic housekeeping: heartbeat timeouts, TTL expiry, waiter progress. */
	sweep(): void {
		for (const agentId of this.registry.sweep()) this.handleDisconnect(agentId);
		this.leases.sweep();
		for (const pending of [...this.pendingApprovals.values()]) {
			if (!this.registry.get(pending.agentId)?.connected) this.settleApproval(pending.requestId, "unavailable");
		}
	}

	holderOf(resourceKey: string) {
		const lease = this.leases.holder(resourceKey);
		return lease ? holderInfo(lease, this.now()) : undefined;
	}

	async handle(agentId: string | undefined, request: BrokerRequest): Promise<BrokerReply> {
		if (agentId && request.type !== "hello") this.registry.touch(agentId);
		switch (request.type) {
			case "hello":
				return this.onHello(request);
			case "ping":
				if (!agentId) return failure("unknown_agent", "Register with hello before pinging.");
				if (!this.registry.touch(agentId)) return failure("unknown_agent", `Unknown agent ${agentId}.`);
				if (typeof request.lastUserInputAt === "number") this.registry.lastUserInputAt = request.lastUserInputAt;
				return { ok: true, type: "ping", now: this.now() };
			case "acquire":
				return await this.onAcquire(agentId, request);
			case "renew":
				if (!agentId) return failure("unknown_agent", "Register with hello before renewing a lease.");
				return this.onRenew(agentId, request.leaseId);
			case "release":
				if (!agentId) return failure("unknown_agent", "Register with hello before releasing a lease.");
				if (!this.leases.release(agentId, request.leaseId)) return failure("not_holder", `Agent ${agentId} does not hold ${request.leaseId}.`);
				return { ok: true, type: "release", leaseId: request.leaseId };
			case "transfer":
				if (!agentId) return failure("unknown_agent", "Register with hello before transferring a lease.");
				return this.onTransfer(agentId, request.leaseId, request.toAgentId);
			case "epoch":
				return { ok: true, type: "epoch", resourceKey: request.resourceKey, epoch: this.epochs.current(request.resourceKey) };
			case "status":
				return { ok: true, type: "status", status: this.status() };
			case "stop":
				return this.onStop(agentId, request.targetAgentId);
			case "approval_response": {
				const pending = this.pendingApprovals.get(request.requestId);
				if (!pending) return failure("invalid_request", `No pending approval ${request.requestId}.`);
				if (pending.agentId !== agentId && !this.registry.ancestors(pending.agentId).some((record) => record.agentId === agentId)) {
					return failure("invalid_request", `Agent ${agentId} may not answer ${request.requestId}.`);
				}
				this.settleApproval(request.requestId, request.decision);
				return { ok: true, type: "approval_response", requestId: request.requestId };
			}
			case "policy": {
				if (request.op === "allow_app") {
					if (!agentId) return failure("unknown_agent", "Register with hello before changing policy.");
					const tier = this.policy.tierForApp(request.app, request.app?.bundleId ?? request.app?.appName ?? "app");
					if (request.tier && request.tier !== tier) return failure("denied", `Tier ${request.tier} does not match the effective tier ${tier}.`);
					this.policy.allowApp(request.app, tier);
				}
				return { ok: true, type: "policy", policy: this.policy.describe() as never };
			}
			default:
				return failure("invalid_request", `Unsupported request type.`);
		}
	}

	status(): BrokerStatus {
		this.sweep();
		const agents: AgentStatus[] = this.registry.all().map((record) => ({
			agentId: record.agentId,
			parentAgentId: record.parentAgentId,
			hasUI: record.hasUI,
			pid: record.pid,
			lastSeenAt: record.lastSeenAt,
			leases: this.leases.leasesOf(record.agentId).map((lease) => ({
				resourceKey: lease.resourceKey,
				leaseId: lease.leaseId,
				expiresAt: lease.expiresAt,
			})),
		}));
		const resources = this.epochs.entries().map(({ resourceKey, epoch }) => ({
			resourceKey,
			epoch,
			holder: this.holderOf(resourceKey),
		}));
		return {
			protocolVersion: BROKER_PROTOCOL_VERSION,
			pid: this.pid,
			startedAt: this.startedAt,
			agents,
			resources,
			waiters: this.leases.waitersOf(),
			lastUserInputAt: this.registry.lastUserInputAt,
		};
	}

	close(): void {
		for (const pending of [...this.pendingApprovals.values()]) this.settleApproval(pending.requestId, "unavailable");
		this.leases.clear();
		this.registry.clear();
	}

	private onHello(request: Extract<BrokerRequest, { type: "hello" }>): BrokerReply {
		if (request.protocolVersion !== BROKER_PROTOCOL_VERSION) {
			return failure(
				"protocol_mismatch",
				`Broker protocol ${BROKER_PROTOCOL_VERSION} does not match client protocol ${request.protocolVersion}.`,
			);
		}
		if (!request.agent?.agentId) return failure("invalid_request", "hello requires an agent.agentId.");
		this.registry.register(request.agent);
		return { ok: true, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, brokerPid: this.pid, startedAt: this.startedAt };
	}

	private async onAcquire(agentId: string | undefined, request: AcquireRequest): Promise<BrokerReply> {
		if (!agentId) return failure("unknown_agent", "Register with hello before acquiring a lease.");
		const agent = this.registry.get(agentId);
		if (!agent) return failure("unknown_agent", `Unknown agent ${agentId}.`);
		if (!request.resourceKey) return failure("invalid_request", "acquire requires a resourceKey.");

		const decision = this.policy.check({ agentId, resourceKey: request.resourceKey, app: request.app, action: request.action, cwd: agent.cwd });
		if (decision.denied) return failure("denied", decision.denied, { tier: decision.tier });
		if (decision.requiresApproval) {
			const cached = this.sessionApprovals.get(`${agentId}:${decision.cacheKey}`);
			const reusable = cached === decision.tier;
			if (!reusable) {
				const outcome = await this.requestApproval(agent, request, decision);
				if (outcome !== "allow_session" && outcome !== "always") {
					if (outcome === "unavailable") return failure("approval_unavailable", "No UI-capable ancestor session can approve this action.", { tier: decision.tier });
					if (outcome === "timeout") return failure("approval_denied", "The approval request timed out.", { tier: decision.tier });
					return failure("approval_denied", "The user denied this action.", { tier: decision.tier });
				}
				if (outcome === "always") this.policy.allowApp(request.app, decision.tier);
				this.sessionApprovals.set(`${agentId}:${decision.cacheKey}`, decision.tier);
			}
		}

		const result = await this.leases.acquire(agentId, request.resourceKey, {
			baseEpoch: request.baseEpoch,
			wait: request.wait,
			ttlMs: request.ttlMs,
		});
		if (!result.ok) {
			if (result.code === "stale") {
				return failure("stale", `State is stale for ${request.resourceKey}: expected epoch ${result.expectedEpoch}, current epoch ${result.currentEpoch}.`, {
					currentEpoch: result.currentEpoch,
					expectedEpoch: result.expectedEpoch,
				});
			}
			return failure("resource_busy", `Resource ${request.resourceKey} is held by ${result.holder.agentId}.`, { holder: result.holder });
		}
		return { ok: true, type: "acquire", lease: toLeaseInfo(result.lease), tier: decision.tier, approved: decision.requiresApproval || undefined };
	}

	private onRenew(agentId: string, leaseId: string): BrokerReply {
		const lease: Lease | undefined = this.leases.renew(agentId, leaseId);
		if (!lease) return failure("not_holder", `Agent ${agentId} does not hold ${leaseId}.`);
		return { ok: true, type: "renew", lease: toLeaseInfo(lease) };
	}

	private onTransfer(agentId: string, leaseId: string, toAgentId: string): BrokerReply {
		if (!this.registry.get(toAgentId)) return failure("unknown_agent", `Unknown agent ${toAgentId}.`);
		const lease = this.leases.transfer(agentId, leaseId, toAgentId);
		if (!lease) return failure("not_holder", `Agent ${agentId} does not hold ${leaseId}.`);
		return { ok: true, type: "transfer", lease: toLeaseInfo(lease) };
	}

	private onStop(agentId: string | undefined, targetAgentId: string | undefined): BrokerReply {
		// Stopping another agent is a user action. Only the native helper may ask for
		// it; an agent that could stop its peers would break multi-agent parallelism
		// and could silence a reviewer.
		const requester = agentId ? this.registry.get(agentId) : undefined;
		if (!requester || requester.role !== "helper") {
			return failure("not_permitted", "Only the helper may stop agents; the user stops them from the menu bar or with Ctrl+Option+Cmd+.");
		}
		const targets = targetAgentId
			? [targetAgentId].filter((candidate) => this.registry.get(candidate))
			: this.registry.others(agentId ?? "").map((record) => record.agentId);
		for (const target of targets) {
			this.leases.revokeAgent(target, "stopped_by_user");
			this.transport?.send(target, { event: "stopped", agentId: target });
		}
		return { ok: true, type: "stop", stopped: targets };
	}

	private async requestApproval(
		agent: AgentRecord,
		request: AcquireRequest,
		decision: PolicyDecision,
	): Promise<ApprovalDecision | "timeout" | "unavailable"> {
		const target = this.registry.nearestWithUI(agent.agentId);
		if (!target || !this.transport) return "unavailable";
		this.approvalCounter += 1;
		const requestId = `approval-${this.approvalCounter}`;
		const deadline = this.now() + this.approvalTimeoutMs;
		const outcome = new Promise<ApprovalDecision | "timeout" | "unavailable">((resolve) => {
			this.pendingApprovals.set(requestId, {
				requestId,
				agentId: agent.agentId,
				cacheKey: decision.cacheKey,
				resolve,
				cancelTimer: () => undefined,
			});
		});
		const pending = this.pendingApprovals.get(requestId)!;
		pending.cancelTimer = this.schedule(() => this.settleApproval(requestId, "timeout"), this.approvalTimeoutMs);
		const delivered = this.transport.send(target.agentId, {
			event: "approval",
			requestId,
			agentId: agent.agentId,
			resourceKey: request.resourceKey,
			app: request.app,
			tier: decision.tier,
			action: request.action,
			warning: decision.warning,
			deadline,
		});
		if (!delivered) {
			this.settleApproval(requestId, "unavailable");
		}
		return await outcome;
	}

	private settleApproval(requestId: string, decision: ApprovalDecision | "timeout" | "unavailable"): void {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) return;
		this.pendingApprovals.delete(requestId);
		pending.cancelTimer();
		pending.resolve(decision);
	}
}
