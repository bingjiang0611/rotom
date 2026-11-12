import { randomBytes } from "node:crypto";
import type { LeaseHolderInfo, LeaseInfo } from "./protocol.ts";

/** Returns a cancel function. Injected so tests can drive time deterministically. */
export type Schedule = (callback: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (callback, ms) => {
	const timer = setTimeout(callback, Math.max(0, ms));
	timer.unref?.();
	return () => clearTimeout(timer);
};

export interface LeaseManagerOptions {
	now: () => number;
	schedule?: Schedule;
	ttlMs: number;
	waitTimeoutMs: number;
	/**
	 * Prefix for lease ids. Random per manager by default, because the helper keeps
	 * revocations by id: a restarted broker handing out `lease-1` again would collide
	 * with the previous process's ids (review E2). Tests pass a fixed value.
	 */
	idPrefix?: string;
}

export interface Lease {
	leaseId: string;
	resourceKey: string;
	agentId: string;
	epoch: number;
	expiresAt: number;
	ttlMs: number;
	/** When the lease was granted, used to report how long a takeover has been held. */
	createdAt: number;
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

export type RevokedReason = "stopped_by_user" | "owner_disconnected" | "expired" | "transferred" | "paused_interfered" | "preempted_by_user" | "released_by_user" | "takeover_ended";

export interface Revocation {
	agentId: string;
	leaseIds: string[];
	reason: RevokedReason;
	/**
	 * Latest expiry among the revoked leases, in milliseconds.
	 *
	 * The helper keeps rejected ids only until this moment and then forgets them, so
	 * the set stays bounded without the helper having to know the broker's TTL policy
	 * (review E2).
	 */
	expiresAt: number;
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
	private readonly idPrefix: string;
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
		this.idPrefix = options.idPrefix ?? randomBytes(4).toString("hex");
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

	/**
	 * Hand a lease to a child agent, e.g. when the parent spawns a subagent.
	 *
	 * The receiver gets a new lease id and the old one is revoked: the helper keeps
	 * revocations by id, so reusing the id would make the receiver's very first write
	 * fail as `lease_invalid` (review E2).
	 */
	transfer(agentId: string, leaseId: string, toAgentId: string): Lease | undefined {
		const lease = this.get(leaseId);
		if (!lease || lease.agentId !== agentId) return undefined;
		const next = this.reissue(lease, toAgentId);
		this.notifyRevoked(agentId, [lease], "transferred");
		return next;
	}

	/**
	 * Hand every lease an agent holds to another agent.
	 *
	 * Used when a parent hands an app to its subagent and when that subagent exits:
	 * a crashed child must not keep the app locked until the TTL expires, and the
	 * parent already earned the authorization.
	 */
	transferAll(agentId: string, toAgentId: string): Lease[] {
		const held = [...this.leases.values()].filter((lease) => lease.agentId === agentId);
		const renewed = held.map((lease) => this.reissue(lease, toAgentId));
		this.notifyRevoked(agentId, held, "transferred");
		return renewed;
	}

	/** Drop every lease an agent holds. Returns the revoked ids. */
	revokeAgent(agentId: string, reason: RevokedReason): string[] {
		const held = [...this.leases.values()].filter((lease) => lease.agentId === agentId);
		const revoked = held.map((lease) => lease.leaseId);
		for (const lease of held) this.drop(lease, reason, false);
		this.notifyRevoked(agentId, held, reason);
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
			createdAt: this.now(),
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
		if (reason && notify) this.notifyRevoked(lease.agentId, [lease], reason);
		this.grantWaiters();
	}

	/** One revocation event, carrying the moment after which the ids can be forgotten. */
	private notifyRevoked(agentId: string, leases: Lease[], reason: RevokedReason): void {
		if (leases.length === 0) return;
		this.onRevoke?.({
			agentId,
			leaseIds: leases.map((lease) => lease.leaseId),
			reason,
			expiresAt: Math.max(...leases.map((lease) => lease.expiresAt)),
		});
	}

	/**
	 * Give the same resource to another agent under a new id.
	 *
	 * The epoch is bumped like a fresh grant: an observation taken under the previous
	 * holder is not valid for the new one.
	 */
	private reissue(lease: Lease, toAgentId: string): Lease {
		const next: Lease = {
			leaseId: this.nextLeaseId(),
			resourceKey: lease.resourceKey,
			agentId: toAgentId,
			epoch: this.epochs.bump(lease.resourceKey),
			expiresAt: this.now() + lease.ttlMs,
			ttlMs: lease.ttlMs,
			createdAt: this.now(),
		};
		this.leases.delete(lease.leaseId);
		this.leases.set(next.leaseId, next);
		this.byResource.set(next.resourceKey, next.leaseId);
		return next;
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
		return `lease-${this.idPrefix}-${this.counter}`;
	}
}
