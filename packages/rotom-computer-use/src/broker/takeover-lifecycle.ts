import { judgeGlobalInputQuiet } from "../policy/global-input-quiet.mjs";
import { TAKEOVER_RESOURCE, TAKEOVER_END_REASONS, failure, type TakeoverEndReason, type BrokerReply, type TakeoverStateRequest, type TargetAppInfo } from "./protocol.ts";

export const TAKEOVER_PAUSE_TIMEOUT_MS = 120_000;
export const TAKEOVER_MAX_RESUMES = 3;
export const TAKEOVER_MAX_DURATION_MS = 600_000;

interface TakeoverRecord {
	id: string;
	agentId: string;
	leaseId: string;
	app: TargetAppInfo;
	startedAt: number;
	pausedAt?: number;
	sequence: number;
	resumes: number;
	resumePrepared?: number;
	resumeCommitted?: number;
}

/** Broker decisions; only the native helper can submit lifecycle observations. */
export class TakeoverLifecycle {
	private current?: TakeoverRecord;
	private readonly ctx: {
		now(): number;
		holder(): { agentId: string; leaseId: string } | undefined;
		granted(app: TargetAppInfo, agentId: string): boolean;
		end(agentId: string, reason: TakeoverEndReason): void;
		emit(agentId: string, state: "paused" | "resumed" | "ended", reason: string, takeoverId: string, leaseId: string): void;
	};
	constructor(ctx: TakeoverLifecycle["ctx"]) { this.ctx = ctx; }

	get status() {
		const state = this.current;
		return state ? { agentId: state.agentId, since: state.startedAt, leaseId: state.leaseId, paused: state.pausedAt !== undefined, resumes: state.resumes } : undefined;
	}

	get pausedAgent(): string | undefined { return this.current?.pausedAt === undefined ? undefined : this.current.agentId; }

	revoked(leaseIds: string[], reason: string): void {
		if (this.current && leaseIds.includes(this.current.leaseId)) this.finish(reason === "stopped_by_user" ? "released_by_user" : reason);
	}

	helperDisconnected(): void { this.finish("authorization_lost"); }

	sweep(): void {
		const state = this.current;
		if (!state) return;
		const holder = this.ctx.holder();
		const reason = !holder || holder.leaseId !== state.leaseId || holder.agentId !== state.agentId ? "authorization_lost"
			: !this.ctx.granted(state.app, state.agentId) ? "authorization_lost"
			: this.ctx.now() - state.startedAt >= TAKEOVER_MAX_DURATION_MS ? "takeover_duration_limit"
			: state.pausedAt !== undefined && this.ctx.now() - state.pausedAt >= TAKEOVER_PAUSE_TIMEOUT_MS ? "resume_timeout"
			: undefined;
		if (reason) this.finish(reason);
	}

	handle(request: TakeoverStateRequest): BrokerReply {
		this.sweep();
		const holder = this.ctx.holder();
		if (!holder || holder.agentId !== request.targetAgentId || holder.leaseId !== request.leaseId) return failure("not_holder", `No matching ${TAKEOVER_RESOURCE} lease.`);
		if (request.phase === "begin") {
			if (this.current) return failure("takeover_conditions", "A takeover is already registered; release it before beginning another.");
			if (!request.takeoverId || !request.app || !this.ctx.granted(request.app, request.targetAgentId)) return failure("takeover_conditions", "The foreground grant is no longer valid.");
			this.current = { id: request.takeoverId, agentId: request.targetAgentId, leaseId: holder.leaseId, app: request.app, startedAt: this.ctx.now(), sequence: 0, resumes: 0 };
			return { ok: true, type: "takeover_state", allowed: true };
		}
		const state = this.current;
		if (!state || state.id !== request.takeoverId || state.agentId !== request.targetAgentId) return failure("takeover_conditions", "The takeover has ended or its generation changed.");
		if (request.phase === "end") {
			if (request.reason && !TAKEOVER_END_REASONS.includes(request.reason)) return failure("invalid_request", "Unknown takeover end reason.");
			this.finish(request.reason ?? "released_by_user");
			return { ok: true, type: "takeover_state", allowed: false };
		}
		if (!Number.isSafeInteger(request.sequence) || request.sequence! < state.sequence) return failure("takeover_conditions", "Stale helper input generation.");
		if (request.phase === "pause") {
			state.sequence = request.sequence!;
			state.resumePrepared = undefined;
			state.resumeCommitted = undefined;
			if (state.pausedAt === undefined) {
				state.pausedAt = this.ctx.now();
				this.ctx.emit(state.agentId, "paused", "user_input_pause", state.id, state.leaseId);
			}
			return { ok: true, type: "takeover_state", allowed: false };
		}
		if (state.pausedAt === undefined) return failure("takeover_conditions", "No matching paused input generation.");
		if (request.phase === "prepare_resume") state.sequence = request.sequence!;
		if (request.sequence !== state.sequence) return failure("takeover_conditions", "Stale resume generation.");
		if (!request.targetValid) {
			this.finish("target_lost");
			return { ok: true, type: "takeover_state", allowed: false };
		}
		if (request.phase !== "resumed" && state.resumes >= TAKEOVER_MAX_RESUMES) {
			this.finish("resume_limit");
			return { ok: true, type: "takeover_state", allowed: false };
		}
		const observedAt = request.activity?.observedAt;
		if (!Number.isFinite(observedAt) || observedAt! > this.ctx.now() || this.ctx.now() - observedAt! > 2_000 || !judgeGlobalInputQuiet(request.activity).allowed) return { ok: true, type: "takeover_state", allowed: false };
		if (request.phase === "prepare_resume") {
			state.resumePrepared = this.ctx.now();
			state.resumeCommitted = undefined;
			return { ok: true, type: "takeover_state", allowed: true };
		}
		if (request.phase === "commit_resume") {
			if (state.resumePrepared === undefined || this.ctx.now() - state.resumePrepared > 2_000 || state.resumeCommitted !== undefined) return failure("takeover_conditions", "No fresh unconsumed helper resume admission.");
			state.resumeCommitted = this.ctx.now();
			state.resumes++;
			return { ok: true, type: "takeover_state", allowed: true };
		}
		if (request.phase !== "resumed" || state.resumeCommitted === undefined || this.ctx.now() - state.resumeCommitted > 2_000) return failure("takeover_conditions", "No fresh committed helper resume admission.");
		state.pausedAt = undefined;
		state.resumePrepared = undefined;
		state.resumeCommitted = undefined;
		this.ctx.emit(state.agentId, "resumed", "auto_resume", state.id, state.leaseId);
		return { ok: true, type: "takeover_state", allowed: true };
	}

	private finish(reason: string): void {
		const state = this.current;
		if (!state) return;
		this.current = undefined;
		const endReason: TakeoverEndReason = TAKEOVER_END_REASONS.includes(reason as TakeoverEndReason) ? reason as TakeoverEndReason : "authorization_lost";
		this.ctx.end(state.agentId, endReason);
		this.ctx.emit(state.agentId, "ended", endReason, state.id, state.leaseId);
	}
}
