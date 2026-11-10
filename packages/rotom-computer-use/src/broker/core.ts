import { randomBytes } from "node:crypto";
import { TakeoverLifecycle } from "./takeover-lifecycle.ts";
import { permissivePolicy, takeoverGrantValid, type PolicyGate, type PolicyDecision } from "./policy.ts";
import { parseUserActivityReport } from "./activity.ts";
import { EpochRegistry } from "./epochs.ts";
import { toSignedLeaseInfo } from "./lease-token.ts";
import { LeaseManager, holderInfo, realSchedule, type Lease, type Schedule } from "./leases.ts";
import {
	BROKER_PROTOCOL_VERSION,
	DEFAULT_APPROVAL_TIMEOUT_MS,
	DEFAULT_HEARTBEAT_TIMEOUT_MS,
	DEFAULT_LEASE_TTL_MS,
	DEFAULT_WAIT_TIMEOUT_MS,
	TAKEOVER_RESOURCE,
	failure,
	type AcquireRequest,
	type AppTier,
	type ApprovalDecision,
	type BrokerTransport,
	type BrokerReply,
	type BrokerRequest,
	type BrokerStatus,
} from "./protocol.ts";
import { AgentRegistry, type AgentRecord } from "./registry.ts";
import { buildStatus } from "./status.ts";
import {
	handleInterference,
	handleResume,
	handleStop,
	handleReleaseOnYield,
	handleTakeoverApproval,
	takeoverRefusal,
	type UserControlContext,
} from "./user-control.ts";

export type { PolicyCheckInput, PolicyDecision, PolicyGate } from "./policy.ts";
export { permissivePolicy } from "./policy.ts";

export type { BrokerTransport } from "./protocol.ts";

export interface BrokerCoreOptions {
	now?: () => number;
	schedule?: Schedule;
	leaseTtlMs?: number;
	waitTimeoutMs?: number;
	heartbeatTimeoutMs?: number;
	approvalTimeoutMs?: number;
	policy?: PolicyGate;
	pid?: number;
	/** Fixed lease-signing key for tests; a fresh random one otherwise. */
	leaseSecret?: Buffer;
}

interface PendingApproval {
	requestId: string;
	deadline: number;
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
	private readonly leaseSecret: Buffer;
	private readonly sessionApprovals = new Map<string, AppTier>();
	/**
	 * Agents paused after interfering with the user (PLAN §6 / F3).
	 *
	 * The decision lives in the broker so every write path sees it, and only the
	 * helper connection can lift it: a model that could resume itself would defeat
	 * the point of pausing it.
	 */
	private readonly paused = new Map<string, { reason: "interfered_with_user"; at: number }>();
	/**
	 * When the user last clicked "let it take over" in the helper menu bar.
	 *
	 * This is consent for the *next* takeover, not a standing grant: it expires
	 * after the approval window (`user-control.ts`) so a forgotten click cannot authorize a
	 * takeover an hour later.
	 */
	private takeoverApprovedAt: number | undefined;
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	readonly takeovers: TakeoverLifecycle;
	private transport: BrokerTransport | undefined;
	private approvalCounter = 0;

	constructor(options: BrokerCoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? realSchedule;
		this.startedAt = this.now();
		this.pid = options.pid ?? process.pid;
		this.leaseSecret = options.leaseSecret ?? randomBytes(32);
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
		this.takeovers = new TakeoverLifecycle({
			now: this.now,
			holder: () => this.leases.holder(TAKEOVER_RESOURCE),
			granted: (app, agentId) => takeoverGrantValid(this.policy, app, agentId, this.registry.get(agentId)?.cwd),
			end: (agentId, reason) => { this.leases.revokeAgent(agentId, reason === "released_by_user" ? "released_by_user" : "takeover_ended"); },
			emit: (agentId, state, reason, takeoverId, leaseId) => {
				const event = { event: "takeover_state" as const, agentId, state, reason, takeoverId, leaseId, at: this.now() };
				this.transport?.send(agentId, event);
				for (const helper of this.registry.agentsWithRole("helper")) this.transport?.send(helper.agentId, event);
			},
		});
		this.leases.onRevoke = (revocation) => {
			this.takeovers.revoked(revocation.leaseIds, revocation.reason);
			this.transport?.send(revocation.agentId, { event: "revoked", ...revocation });
			// The helper enforces tokens, so it has to learn about every revocation:
			// otherwise a token the broker already took away would keep working.
			for (const helper of this.registry.agentsWithRole("helper")) {
				if (helper.agentId === revocation.agentId) continue;
				this.transport?.send(helper.agentId, { event: "revoked", ...revocation });
			}
		};
	}

	/** The user-control seam: same broker state, decisions in one module. */
	private userControl(): UserControlContext {
		return {
			now: () => this.now(),
			registry: this.registry,
			leases: this.leases,
			transport: () => this.transport,
			paused: this.paused,
			foregroundGranted: (app, agentId) => takeoverGrantValid(this.policy, app, agentId, this.registry.get(agentId)?.cwd),
		};
	}

	attachTransport(transport: BrokerTransport): void {
		this.transport = transport;
	}

	/** A transport dropped one agent: revoke its leases and forget it. */
	handleDisconnect(agentId: string): void {
		// A subagent holds an app on its parent's authority: when it exits, the app
		// goes back to the parent instead of staying locked until the TTL expires.
		const foreground = this.leases.holder(TAKEOVER_RESOURCE);
		if (foreground?.agentId === agentId) this.leases.release(agentId, foreground.leaseId);
		this.takeovers.revoked(foreground?.agentId === agentId ? [foreground.leaseId] : [], "authorization_lost");
		const parentAgentId = this.registry.get(agentId)?.parentAgentId;
		const parent = parentAgentId ? this.registry.get(parentAgentId) : undefined;
		if (parent?.connected) this.leases.transferAll(agentId, parent.agentId);
		else this.leases.revokeAgent(agentId, "owner_disconnected");
		if (this.registry.get(agentId)?.role === "helper") this.takeovers.helperDisconnected();
		this.registry.disconnect(agentId);
		this.registry.remove(agentId);
		this.paused.delete(agentId);
	}

	/** Periodic housekeeping: heartbeat timeouts, TTL expiry, waiter progress. */
	sweep(): void {
		for (const agentId of this.registry.sweep()) this.handleDisconnect(agentId);
		this.leases.sweep();
		this.takeovers.sweep();
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
				// User activity comes from the helper's event tap. An agent that could
				// report it could claim the user is idle and grant itself the foreground.
				if (request.lastUserInputAt !== undefined && this.registry.get(agentId)?.role === "helper") {
					const activity = parseUserActivityReport(request.lastUserInputAt, this.now());
					if (!activity.ok) return failure("invalid_request", "lastUserInputAt must be milliseconds since the epoch.");
					this.registry.lastUserInputAt = Math.max(this.registry.lastUserInputAt ?? 0, activity.value);
				}
				return { ok: true, type: "ping", now: this.now() };
			case "acquire":
				return await this.onAcquire(agentId, request);
			case "renew":
				if (!agentId) return failure("unknown_agent", "Register with hello before renewing a lease.");
				return this.onRenew(agentId, request.leaseId);
			case "release":
				if (!agentId) return failure("unknown_agent", "Register with hello before releasing a lease.");
				if (!this.leases.release(agentId, request.leaseId)) return failure("not_holder", `Agent ${agentId} does not hold ${request.leaseId}.`);
				this.takeovers.revoked([request.leaseId], "released_by_user");
				return { ok: true, type: "release", leaseId: request.leaseId };
			case "transfer":
				if (!agentId) return failure("unknown_agent", "Register with hello before transferring a lease.");
				return this.onTransfer(agentId, request.leaseId, request.toAgentId);
			case "epoch":
				return { ok: true, type: "epoch", resourceKey: request.resourceKey, epoch: this.epochs.current(request.resourceKey) };
			case "status":
				return { ok: true, type: "status", status: this.status() };
			case "stop":
				return handleStop(this.userControl(), agentId, request.targetAgentId);
			case "interference":
				if (!agentId) return failure("unknown_agent", "Register with hello before reporting interference.");
				return handleInterference(this.userControl(), agentId, request.evidence);
			case "resume":
				return handleResume(this.userControl(), agentId, request.targetAgentId);
			case "takeover_approval": {
				// Only the helper may report the user's click; see user-control.ts.
				const approvedAt = this.now();
				const reply = handleTakeoverApproval(this.userControl(), agentId, approvedAt);
				if (reply.ok) this.takeoverApprovedAt = approvedAt;
				return reply;
			}
			case "release_on_yield":
				return handleReleaseOnYield(this.userControl(), agentId, request);
			case "takeover_state":
				if (!agentId || this.registry.get(agentId)?.role !== "helper") return failure("not_permitted", "Only the helper may report takeover state or resume it.");
				return this.takeovers.handle(request);
			case "approval_response": {
				const pending = this.pendingApprovals.get(request.requestId);
				if (!pending) return failure("invalid_request", `No pending approval ${request.requestId}.`);
				if (pending.agentId !== agentId && !this.registry.ancestors(pending.agentId).some((record) => record.agentId === agentId)) {
					return failure("invalid_request", `Agent ${agentId} may not answer ${request.requestId}.`);
				}
				if (this.now() >= pending.deadline) {
					this.settleApproval(request.requestId, "timeout");
					return failure("invalid_request", "Approval deadline has expired.");
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
		const status = buildStatus({
			registry: this.registry,
			leases: this.leases,
			epochs: this.epochs,
			pid: this.pid,
			startedAt: this.startedAt,
			now: this.now(),
			paused: this.paused,
		});
		if (this.takeovers.status) status.takeover = this.takeovers.status;
		return status;
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
		// The helper role is self-declared (review E4). One helper at a time keeps the
		// blast radius at "the helper I started": a second process claiming the role
		// must not also learn the key or answer the user's stop control.
		if (request.agent.role === "helper") {
			const other = this.registry.agentsWithRole("helper").find((record) => record.agentId !== request.agent.agentId);
			if (other) {
				return failure(
					"not_permitted",
					`A helper is already connected (${other.agentId}). Only one helper at a time may hold the lease key; stop that helper first.`,
				);
			}
		}
		this.registry.register(request.agent);
		// The native helper enforces lease tokens, so it needs the key. Agents never
		// get it: a key an agent could read is a key an agent could forge.
		const leaseKey = request.agent.role === "helper" ? this.leaseSecret.toString("base64") : undefined;
		return {
			ok: true,
			type: "hello",
			protocolVersion: BROKER_PROTOCOL_VERSION,
			brokerPid: this.pid,
			startedAt: this.startedAt,
			...(leaseKey ? { leaseKey } : {}),
		};
	}

	private async onAcquire(agentId: string | undefined, request: AcquireRequest): Promise<BrokerReply> {
		if (!agentId) return failure("unknown_agent", "Register with hello before acquiring a lease.");
		const agent = this.registry.get(agentId);
		if (!agent) return failure("unknown_agent", `Unknown agent ${agentId}.`);
		if (!request.resourceKey) return failure("invalid_request", "acquire requires a resourceKey.");
		if (this.takeovers.pausedAgent === agentId) return failure("takeover_conditions", "The takeover is paused by user input; only the helper may automatically resume it.");
		const pause = this.paused.get(agentId);
		if (pause) {
			return failure(
				"paused_interfered",
				`Agent ${agentId} is paused: its action changed the frontmost app while the user was typing. The user resumes it from the menu bar or the approval card; reads are unaffected.`,
			);
		}

		if (request.resourceKey === TAKEOVER_RESOURCE) {
			const refusal = takeoverRefusal(this.userControl(), agentId, request, this.takeoverApprovedAt, this.registry.lastUserInputAt);
			if (refusal) return refusal;
		}

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
		return { ok: true, type: "acquire", lease: toSignedLeaseInfo(this.leaseSecret, result.lease), tier: decision.tier, approved: decision.requiresApproval || undefined };
	}

	private onRenew(agentId: string, leaseId: string): BrokerReply {
		this.takeovers.sweep();
		const lease: Lease | undefined = this.leases.renew(agentId, leaseId);
		if (!lease) return failure("not_holder", `Agent ${agentId} does not hold ${leaseId}.`);
		return { ok: true, type: "renew", lease: toSignedLeaseInfo(this.leaseSecret, lease) };
	}

	private onTransfer(agentId: string, leaseId: string, toAgentId: string): BrokerReply {
		if (this.leases.holder(TAKEOVER_RESOURCE)?.leaseId === leaseId) return failure("not_permitted", "Foreground takeover cannot transfer; release it and request a new authorization.");
		if (!this.registry.get(toAgentId)) return failure("unknown_agent", `Unknown agent ${toAgentId}.`);
		// Handing an app to a stranger would widen the parent's authorization to a
		// process the user never approved: only own descendants may receive it.
		const descendant = this.registry.ancestors(toAgentId).some((record) => record.agentId === agentId);
		if (!descendant) {
			return failure("not_permitted", `Agent ${agentId} may only hand a lease to its own subagent; ${toAgentId} is not its descendant.`);
		}
		const lease = this.leases.transfer(agentId, leaseId, toAgentId);
		if (!lease) return failure("not_holder", `Agent ${agentId} does not hold ${leaseId}.`);
		return { ok: true, type: "transfer", lease: toSignedLeaseInfo(this.leaseSecret, lease) };
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
				deadline,
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
