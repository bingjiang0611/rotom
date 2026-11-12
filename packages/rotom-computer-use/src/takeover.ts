import type { BrokerSession } from "./tools/desktop-deps.ts";
import { TAKEOVER_RESOURCE } from "./broker/protocol.ts";
import { BrokerRequestError } from "./broker/client.ts";
import { LeaseUnavailableError } from "./runtime.ts";
import type { PlatformApp } from "./platform/types.ts";

/**
 * Foreground takeover (PLAN §7, L4).
 *
 * The broker owns the decision: it checks the user's foreground grant, the 10s of
 * idleness (or a fresh "let it take over" click) and that nobody else holds the
 * foreground. This class is the client half: it acquires the global lease, asks
 * the helper to show the border, keeps the lease alive, and stops using it the
 * moment the helper reports a pause. The lease keeps renewing while paused.
 *
 * Input delivery over L4 is not switched on here: this item wires the permission,
 * the border and the helper-owned pause/resume lifecycle. A batch keeps using the normal ladder until the
 * real-machine evidence in B5 exists.
 */
export interface TakeoverBackend {
	/** Show the full-screen border and start swallowing Escape. */
	takeoverBegin(
		input: { pid: number; label: string; agentId: string; leaseId: string; lease?: { token: string; resourceKey: string } },
		signal?: AbortSignal,
	): Promise<void>;
	/** Remove the border and stop swallowing Escape. */
	takeoverEnd(input: { agentId: string; leaseId: string }, signal?: AbortSignal): Promise<void>;
}

export interface TakeoverDeps {
	broker(): BrokerSession | undefined;
	/** Getter: the platform backend is replaced when the session restarts. */
	backend(): TakeoverBackend;
	listApps(signal?: AbortSignal): Promise<PlatformApp[]>;
	/** Headless (subagent, `-p`, RPC) sessions never take the foreground. */
	headless(): boolean;
	/** Renew interval; tests shorten it. */
	renewMs?: number;
}

export type TakeoverStart =
	| { ok: true; pid: number; app: PlatformApp; leaseId: string; expiresAt: number }
	| { ok: false; code: "headless" | "no_broker" | "unknown_app" | "not_holder" | "resource_busy" | "takeover_conditions" | "denied" | "approval_unavailable" | "approval_denied" | "paused_interfered" | "stopped_by_user" | "preempted_by_user" | "broker_unavailable"; message: string; holder?: { agentId: string; remainingMs: number } };

interface ActiveTakeover {
	pid: number;
	app: PlatformApp;
	leaseId: string;
	expiresAt: number;
	timer: ReturnType<typeof setInterval> | undefined;
	paused: boolean;
	pending: boolean;
}

/** Default renewal: well inside the broker's 60 s lease TTL. */
const DEFAULT_RENEW_MS = 20_000;

export class TakeoverController {
	private active: ActiveTakeover | undefined;
	private preemptedAt: number | undefined;
	private readonly deps: TakeoverDeps;
	private readonly renewMs: number;

	constructor(deps: TakeoverDeps) {
		this.deps = deps;
		this.renewMs = deps.renewMs ?? DEFAULT_RENEW_MS;
	}

	get state(): { pid: number; leaseId: string; expiresAt: number; paused: boolean } | undefined {
		return this.active ? { pid: this.active.pid, leaseId: this.active.leaseId, expiresAt: this.active.expiresAt, paused: this.active.paused } : undefined;
	}

	/** True while the agent holds the foreground; a batch checks this each step. */
	get activeTakeover(): boolean {
		return this.active !== undefined && !this.active.paused && !this.active.pending;
	}

	get preempted(): boolean {
		return this.preemptedAt !== undefined;
	}

	/** The broker told us the user took the foreground back. */
	markPreempted(at = Date.now()): void {
		this.preemptedAt = at;
		this.stopLocal();
	}

	markPaused(): void { if (this.active) this.active.paused = true; }
	markResumed(): void { if (this.active) this.active.paused = false; }

	async start(pid: number, signal?: AbortSignal): Promise<TakeoverStart> {
		if (this.deps.headless()) {
			return { ok: false, code: "headless", message: "Foreground takeover (L4) is never used in a headless session: there is no user watching the screen it would take over." };
		}
		const session = this.deps.broker();
		if (!session) return { ok: false, code: "no_broker", message: "The foreground is arbitrated by the Desktop Broker; set ROTOM_CU_BROKER=1 to use takeover." };
		const apps = await this.deps.listApps(signal);
		const app = apps.find((candidate) => candidate.pid === pid);
		if (!app) return { ok: false, code: "unknown_app", message: `No running app has pid ${pid}.` };
		if (this.active) {
			if (this.active.pending) return { ok: false, code: "not_holder", message: "A takeover request is still being admitted by the helper." };
			if (this.active.pid === pid) return { ok: true, pid, app, leaseId: this.active.leaseId, expiresAt: this.active.expiresAt };
			return { ok: false, code: "not_holder", message: `This session already holds the foreground for ${this.active.app.appName} (pid ${this.active.pid}); release it first.` };
		}

		let reply;
		try {
			reply = await session.client.acquire({
				resourceKey: TAKEOVER_RESOURCE,
				app: { appName: app.appName, bundleId: app.bundleId },
				action: { name: "takeover" },
			});
		} catch (error) {
			if (error instanceof BrokerRequestError && error.code === "resource_busy") {
				const holder = (error.reply as { holder?: { agentId: string; remainingMs: number } }).holder;
				return { ok: false, code: "resource_busy", message: error.message, ...(holder ? { holder } : {}) };
			}
			if (error instanceof BrokerRequestError) {
				const code = error.code === "takeover_conditions" ? "takeover_conditions" : "denied";
				return { ok: false, code, message: error.message };
			}
			const unavailable = error instanceof LeaseUnavailableError ? error.code : "broker_unavailable";
			return { ok: false, code: unavailable as "broker_unavailable", message: error instanceof Error ? error.message : String(error) };
		}

		this.preemptedAt = undefined;
		this.active = { pid, app, leaseId: reply.lease.leaseId, expiresAt: reply.lease.expiresAt, timer: undefined, paused: false, pending: true };
		this.startRenewal(session);
		try {
			await this.deps.backend().takeoverBegin(
				{
					pid,
					label: app.appName,
					agentId: session.client.agentId,
					leaseId: reply.lease.leaseId,
					...(reply.lease.token ? { lease: { token: reply.lease.token, resourceKey: reply.lease.resourceKey } } : {}),
				},
				signal,
			);
		} catch (error) {
			// The border is part of the promise: without it the user cannot see that
			// the machine is being driven, so the lease must not stay held.
			if (this.active?.leaseId === reply.lease.leaseId) this.stopLocal();
			await session.client.release(reply.lease.leaseId).catch(() => undefined);
			return { ok: false, code: "denied", message: `The takeover border could not be shown: ${error instanceof Error ? error.message : String(error)}` };
		}

		if (this.active?.leaseId !== reply.lease.leaseId) return { ok: false, code: "denied", message: "The takeover ended while it was being admitted. Request a new authorization." };
		this.active.pending = false;
		return { ok: true, pid, app, leaseId: reply.lease.leaseId, expiresAt: reply.lease.expiresAt };
	}

	async end(): Promise<{ released: string | undefined; pid: number | undefined }> {
		const active = this.active;
		this.stopLocal();
		const session = this.deps.broker();
		if (active && session) {
			await this.deps.backend().takeoverEnd({ agentId: session.client.agentId, leaseId: active.leaseId }).catch(() => undefined);
			await session.client.release(active.leaseId).catch(() => undefined);
		}
		return { released: active?.leaseId, pid: active?.pid };
	}

	private startRenewal(session: BrokerSession): void {
		const timer = setInterval(() => {
			const active = this.active;
			if (!active) return;
			void session.client
				.renew(active.leaseId)
				.then((lease) => {
					if (this.active?.leaseId === active.leaseId) this.active.expiresAt = lease.expiresAt;
				})
				.catch(() => {
					// The broker already took the lease away (preemption, stop, expiry):
					// acting on a lease we may not hold is exactly what must not happen.
					this.markPreempted();
				});
		}, this.renewMs);
		timer.unref?.();
		this.active!.timer = timer;
	}

	private stopLocal(): void {
		if (this.active?.timer) clearInterval(this.active.timer);
		this.active = undefined;
	}
}
