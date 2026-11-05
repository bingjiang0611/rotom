import type { LeaseHolderInfo, LeaseInfo } from "./protocol.ts";

export interface Schedule {
	/** Returns a cancel function. Injected so tests can drive time deterministically. */
	schedule(callback: () => void, ms: number): () => void;
}

export const realSchedule: Schedule = {
	schedule(callback, ms) {
		const timer = setTimeout(callback, Math.max(0, ms));
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

export interface LeaseManagerOptions {
	now: () => number;
	schedule?: Schedule;
	ttlMs: number;
	waitTimeoutMs: number;
}

export interface Lease {
	leaseId: string;
	resourceKey: string;
	agentId: string;
	epoch: number;
	expiresAt: number;
	ttlMs: number;
}

export interface AcquireOptions {
	/** Observation epoch of the caller's state. Omitted means "no state to invalidate". */
	baseEpoch?: number;
	wait?: boolean;
	ttlMs?: number;
}

export type AcquireResult =
	| { ok: true; lease: Lease }
	| { ok: false; code: "resource_busy"; holder: LeaseHolderInfo }
	| { ok: false; code: "stale"; currentEpoch: number; expectedEpoch: number };

export type RevokedReason = "stopped_by_user" | "owner_disconnected" | "expired" | "transferred" | "paused_interfered";

export interface Revocation {
	agentId: string;
	leaseIds: string[];
	reason: RevokedReason;
}

export function toLeaseInfo(lease: Lease): LeaseInfo {
	return {
		leaseId: lease.leaseId,
		resourceKey: lease.resourceKey,
		agentId: lease.agentId,
		epoch: lease.epoch,
		expiresAt: lease.expiresAt,
		ttlMs: lease.ttlMs,
	};
}

export function holderInfo(lease: Lease, now: number): LeaseHolderInfo {
	return {
		agentId: lease.agentId,
		leaseId: lease.leaseId,
		expiresAt: lease.expiresAt,
		remainingMs: Math.max(0, lease.expiresAt - now),
	};
}

interface Waiter {
	agentId: string;
	resourceKey: string;
	baseEpoch?: number;
	deadline: number;
	resolve: (result: AcquireResult) => void;
	cancelTimer: () => void;
}

interface EpochSource {
	current(resourceKey: string): number;
	bump(resourceKey: string): number;
}

/**
 * App write leases. One holder per resource at a time; a conflict is either
 * `resource_busy` immediately or a FIFO wait for at most `waitTimeoutMs`.
 *
 * The manager owns no I/O. Every entry point takes `now` from the injected
 * clock and `sweep()` is the only place time advances state, so tests can drive
 * expiry and queue deadlines without sleeping.
 */
export class LeaseManager {
	private readonly leases = new Map<string, Lease>();
	private readonly byResource = new Map<string, string>();
	private readonly waiters: Waiter[] = [];
	private readonly now: () => number;
	private readonly schedule: Schedule;
	private readonly ttlMs: number;
	private readonly waitTimeoutMs: number;
	private counter = 0;
	/** Called when a lease is revoked without the holder asking for it. */
	onRevoke: ((revocation: Revocation) => void) | undefined;

	private readonly epochs: EpochSource;

	constructor(epochs: EpochSource, options: LeaseManagerOptions) {
		this.epochs = epochs;
		this.now = options.now;
		this.schedule = options.schedule ?? realSchedule;
		this.ttlMs = options.ttlMs;
		this.waitTimeoutMs = options.waitTimeoutMs;
	}

	holder(resourceKey: string): Lease | undefined {
		const leaseId = this.byResource.get(resourceKey);
		if (!leaseId) return undefined;
		const lease = this.leases.get(leaseId);
		if (!lease) {
			this.byResource.delete(resourceKey);
			return undefined;
		}
		if (lease.expiresAt <= this.now()) {
			this.expire(lease);
			return undefined;
		}
		return lease;
	}

	get(leaseId: string): Lease | undefined {
		const lease = this.leases.get(leaseId);
		if (!lease) return undefined;
		if (lease.expiresAt <= this.now()) {
			this.expire(lease);
			return undefined;
		}
		return lease;
	}

	leasesOf(agentId: string): Lease[] {
		this.sweep();
		return [...this.leases.values()].filter((lease) => lease.agentId === agentId);
	}

	all(): Lease[] {
		this.sweep();
		return [...this.leases.values()];
	}

	waitersOf(): Array<{ agentId: string; resourceKey: string; deadline: number }> {
		return this.waiters.map((waiter) => ({ agentId: waiter.agentId, resourceKey: waiter.resourceKey, deadline: waiter.deadline }));
	}

	/** Synchronous attempt. `wait: true` must use `acquire`. */
	tryAcquire(agentId: string, resourceKey: string, options: AcquireOptions = {}): AcquireResult {
		const now = this.now();
		// Epoch first: a stale observation is a different recovery than "wait and retry".
		if (options.baseEpoch !== undefined) {
			const current = this.epochs.current(resourceKey);
			if (options.baseEpoch !== current) {
				return { ok: false, code: "stale", currentEpoch: current, expectedEpoch: options.baseEpoch };
			}
		}
		const existing = this.holder(resourceKey);
		if (existing && existing.agentId !== agentId) {
			return { ok: false, code: "resource_busy", holder: holderInfo(existing, now) };
		}
		return this.grant(agentId, resourceKey, options, existing);
	}

	async acquire(agentId: string, resourceKey: string, options: AcquireOptions = {}): Promise<AcquireResult> {
		const immediate = this.tryAcquire(agentId, resourceKey, options);
		if (immediate.ok || immediate.code !== "resource_busy" || options.wait !== true) return immediate;
		return await new Promise<AcquireResult>((resolve) => {
			const waiter: Waiter = {
				agentId,
				resourceKey,
				baseEpoch: options.baseEpoch,
				deadline: this.now() + this.waitTimeoutMs,
				resolve,
				cancelTimer: () => undefined,
			};
			waiter.cancelTimer = this.schedule(() => {
				if (this.dropWaiter(waiter)) {
					const current = this.holder(resourceKey);
					resolve({ ok: false, code: "resource_busy", holder: holderInfo(current!, this.now()) });
				}
			}, this.waitTimeoutMs);
			this.waiters.push(waiter);
		});
	}

	renew(agentId: string, leaseId: string, ttlMs?: number): Lease | undefined {
		const lease = this.get(leaseId);
		if (!lease || lease.agentId !== agentId) return undefined;
		lease.ttlMs = ttlMs ?? lease.ttlMs;
		lease.expiresAt = this.now() + lease.ttlMs;
		return lease;
	}

	release(agentId: string, leaseId: string): boolean {
		const lease = this.leases.get(leaseId);
		if (!lease || lease.agentId !== agentId) return false;
		this.drop(lease);
		return true;
	}

	/** Hand a lease to a child agent, e.g. when the parent spawns a subagent. */
	transfer(agentId: string, leaseId: string, toAgentId: string): Lease | undefined {
		const lease = this.get(leaseId);
		if (!lease || lease.agentId !== agentId) return undefined;
		lease.agentId = toAgentId;
		lease.expiresAt = this.now() + lease.ttlMs;
		this.onRevoke?.({ agentId, leaseIds: [leaseId], reason: "transferred" });
		return lease;
	}

	/**
	 * Hand every lease an agent holds to another agent.
	 *
	 * Used when a parent hands an app to its subagent and when that subagent exits:
	 * a crashed child must not keep the app locked until the TTL expires, and the
	 * parent already earned the authorization.
	 */
	transferAll(agentId: string, toAgentId: string): Lease[] {
		const leases = [...this.leases.values()].filter((lease) => lease.agentId === agentId);
		for (const lease of leases) {
			lease.agentId = toAgentId;
			lease.expiresAt = this.now() + lease.ttlMs;
		}
		if (leases.length > 0) this.onRevoke?.({ agentId, leaseIds: leases.map((lease) => lease.leaseId), reason: "transferred" });
		return leases;
	}

	/** Drop every lease an agent holds. Returns the revoked ids. */
	revokeAgent(agentId: string, reason: RevokedReason): string[] {
		const revoked = [...this.leases.values()].filter((lease) => lease.agentId === agentId).map((lease) => lease.leaseId);
		for (const leaseId of revoked) {
			const lease = this.leases.get(leaseId);
			if (lease) this.drop(lease, reason, false);
		}
		if (revoked.length > 0) this.onRevoke?.({ agentId, leaseIds: revoked, reason });
		return revoked;
	}

	/** Expire TTLs and progress queued waiters. Safe to call repeatedly. */
	sweep(): void {
		const now = this.now();
		for (const lease of [...this.leases.values()]) {
			if (lease.expiresAt <= now) this.expire(lease);
		}
		this.grantWaiters();
	}

	clear(): void {
		for (const waiter of [...this.waiters]) {
			const holder = this.holder(waiter.resourceKey);
			this.dropWaiter(waiter);
			waiter.resolve({ ok: false, code: "resource_busy", holder: holder ? holderInfo(holder, this.now()) : { agentId: "closed", leaseId: "closed", expiresAt: 0, remainingMs: 0 } });
		}
		this.leases.clear();
		this.byResource.clear();
	}

	private grant(agentId: string, resourceKey: string, options: AcquireOptions, existing: Lease | undefined): AcquireResult {
		if (options.baseEpoch !== undefined) {
			const current = this.epochs.current(resourceKey);
			if (options.baseEpoch !== current) {
				return { ok: false, code: "stale", currentEpoch: current, expectedEpoch: options.baseEpoch };
			}
		}
		const ttlMs = options.ttlMs ?? existing?.ttlMs ?? this.ttlMs;
		const lease: Lease = existing ?? {
			leaseId: this.nextLeaseId(),
			resourceKey,
			agentId,
			epoch: 0,
			expiresAt: 0,
			ttlMs,
		};
		lease.agentId = agentId;
		lease.ttlMs = ttlMs;
		// Every accepted write consumes the next epoch, including a renewal by the
		// holder: the observation that authorized the previous write is spent.
		lease.epoch = this.epochs.bump(resourceKey);
		lease.expiresAt = this.now() + ttlMs;
		if (!existing) {
			this.leases.set(lease.leaseId, lease);
			this.byResource.set(resourceKey, lease.leaseId);
		}
		return { ok: true, lease };
	}

	private grantWaiters(): void {
		// Per-resource FIFO: the first waiter for a busy resource blocks later
		// waiters for that resource, but never waiters for other resources.
		for (const waiter of [...this.waiters]) {
			if (!this.waiters.includes(waiter)) continue;
			const holder = this.holder(waiter.resourceKey);
			if (holder && holder.agentId !== waiter.agentId) continue;
			this.dropWaiter(waiter);
			const result = this.grant(waiter.agentId, waiter.resourceKey, { baseEpoch: waiter.baseEpoch, ttlMs: this.ttlMs }, holder);
			waiter.resolve(result);
		}
	}

	private expire(lease: Lease): void {
		this.drop(lease, "expired");
	}

	private drop(lease: Lease, reason?: RevokedReason, notify = true): void {
		this.leases.delete(lease.leaseId);
		if (this.byResource.get(lease.resourceKey) === lease.leaseId) this.byResource.delete(lease.resourceKey);
		if (reason && notify) this.onRevoke?.({ agentId: lease.agentId, leaseIds: [lease.leaseId], reason });
		this.grantWaiters();
	}

	private dropWaiter(waiter: Waiter): boolean {
		const index = this.waiters.indexOf(waiter);
		if (index < 0) return false;
		this.waiters.splice(index, 1);
		waiter.cancelTimer();
		return true;
	}

	private nextLeaseId(): string {
		this.counter += 1;
		return `lease-${this.counter}`;
	}
}
