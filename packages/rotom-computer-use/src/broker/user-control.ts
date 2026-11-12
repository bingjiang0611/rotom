import { holderInfo, type LeaseManager } from "./leases.ts";
import { parseUserActivityReport } from "./activity.ts";
import type { AgentRegistry } from "./registry.ts";
import {
	TAKEOVER_APPROVAL_WINDOW_MS,
	TAKEOVER_IDLE_MS,
	TAKEOVER_RESOURCE,
	failure,
	type AcquireRequest,
	type BrokerReply,
	type PingRequest,
	type BrokerTransport,
	type TargetAppInfo,
	type ReleaseOnYieldRequest,
} from "./protocol.ts";

/**
 * Decisions that belong to the user, not to the model.
 *
 * Stopping an agent, resuming a paused one, granting the foreground and taking it
 * back are all user actions. The broker enforces them here, in one place, so the
 * rule is identical for the main session, a subagent and any other Pi process:
 * only the helper connection may assert them, and an agent cannot grant itself
 * the screen or evict a peer.
 */
export interface UserControlContext {
	now(): number;
	registry: AgentRegistry;
	leases: LeaseManager;
	transport(): BrokerTransport | undefined;
	/** Agents paused after interfering with the user (PLAN §6 / F3). */
	paused: Map<string, { reason: "interfered_with_user"; at: number }>;
	/** True when the user allowed this app to take the foreground (L4). */
	foregroundGranted(app: TargetAppInfo | undefined, agentId: string): boolean;
}

function helperOrRefusal(ctx: UserControlContext, agentId: string | undefined, action: string): { ok: true } | { ok: false; reply: BrokerReply } {
	const requester = agentId ? ctx.registry.get(agentId) : undefined;
	if (!requester || requester.role !== "helper") {
		return { ok: false, reply: failure("not_permitted", `Only the helper may ${action}; the user does it from the menu bar or Ctrl+Option+Cmd+.`) };
	}
	return { ok: true };
}

export function handleStop(ctx: UserControlContext, agentId: string | undefined, targetAgentId: string | undefined): BrokerReply {
	const permission = helperOrRefusal(ctx, agentId, "stop agents");
	if (!permission.ok) return permission.reply;
	const targets = targetAgentId
		? [targetAgentId].filter((candidate) => ctx.registry.get(candidate))
		: ctx.registry.others(agentId ?? "").map((record) => record.agentId);
	for (const target of targets) {
		ctx.leases.revokeAgent(target, "stopped_by_user");
		ctx.transport()?.send(target, { event: "stopped", agentId: target });
	}
	return { ok: true, type: "stop", stopped: targets };
}

/** Metadata only: surrender releases cannot grant authorization or resume an agent. */
export function handleReleaseOnYield(ctx: UserControlContext, agentId: string | undefined, request: ReleaseOnYieldRequest): BrokerReply {
	const permission = helperOrRefusal(ctx, agentId, "report surrender releases");
	if (!permission.ok) return permission.reply;
	if (!ctx.registry.get(request.targetAgentId)) return failure("unknown_agent", "No such release recipient.");
	const valid = Array.isArray(request.releases) && request.releases.every((release) => release
		&& ["key", "modifier", "button"].includes(release.kind)
		&& Number.isInteger(release.code) && release.code >= 0
		&& release.code <= (release.kind === "button" ? 31 : 65535)
		&& typeof release.posted === "boolean");
	if (!valid) return failure("invalid_request", "Release metadata must contain only key codes or button categories and dispatch status.");
	const releases = request.releases.map(({ kind, code, posted }) => ({ kind, code, posted }));
	ctx.transport()?.send(request.targetAgentId, { event: "release_on_yield", agentId: request.targetAgentId, releases });
	return { ok: true, type: "release_on_yield" };
}

/**
 * Pause the reporting agent and take its write leases away.
 *
 * The observation ("frontmost changed while the user was typing within 2s") can
 * only be made by the helper, so it is reported as evidence and the broker owns
 * the consequence. Revoking is part of pausing: a paused agent cannot write, so
 * holding the app would only block the user and other agents.
 */
export function handleInterference(ctx: UserControlContext, agentId: string, evidence: string | undefined): BrokerReply {
	ctx.paused.set(agentId, { reason: "interfered_with_user", at: ctx.now() });
	ctx.leases.revokeAgent(agentId, "paused_interfered");
	ctx.transport()?.send(agentId, { event: "paused", agentId, reason: "interfered_with_user", at: ctx.now(), ...(evidence ? { evidence } : {}) });
	return { ok: true, type: "interference", paused: true };
}

/** Resume is a user action, like stopping: only the helper connection asks. */
export function handleResume(ctx: UserControlContext, agentId: string | undefined, targetAgentId: string): BrokerReply {
	const permission = helperOrRefusal(ctx, agentId, "resume a paused agent");
	if (!permission.ok) return permission.reply;
	if (!targetAgentId) return failure("invalid_request", "resume requires targetAgentId.");
	const wasPaused = ctx.paused.delete(targetAgentId);
	ctx.transport()?.send(targetAgentId, { event: "resumed", agentId: targetAgentId });
	return { ok: true, type: "resume", resumed: wasPaused ? [targetAgentId] : [] };
}

/** The user's own "let it take over" click; consent for the next takeover only. */
export function handleTakeoverApproval(ctx: UserControlContext, agentId: string | undefined, approvedAt: number): BrokerReply {
	const permission = helperOrRefusal(ctx, agentId, "report that the user allowed a foreground takeover");
	if (!permission.ok) return permission.reply;
	return { ok: true, type: "takeover_approval", approvedAt };
}

/**
 * PLAN §7 conditions for L4, all three of which must hold.
 *
 * 1. the user allowed this app's foreground mode,
 * 2. the user is idle for 10s, or just clicked "let it take over",
 * 3. nobody else holds the foreground (enforced by the lease, in core).
 */
export function takeoverRefusal(
	ctx: UserControlContext,
	agentId: string,
	request: AcquireRequest,
	approvedAt: number | undefined,
	lastUserInputAt: number | undefined,
): BrokerReply | undefined {
	const app = request.app;
	const name = app?.appName ?? app?.bundleId ?? "this app";
	if (!ctx.foregroundGranted(app, agentId)) {
		return failure(
			"takeover_conditions",
			`The user has not allowed ${name} to take the foreground. Add it to the foreground list in the Computer Use policy, or ask the user to allow it.`,
		);
	}
	const approved = approvedAt !== undefined && ctx.now() - approvedAt <= TAKEOVER_APPROVAL_WINDOW_MS;
	if (!approved) {
		// No activity report at all is "unknown", and unknown must not look idle: a
		// helper that never connected would otherwise hand over the screen.
		if (lastUserInputAt === undefined) {
			return failure(
				"takeover_conditions",
				'The helper has not reported any user activity yet, so the broker cannot tell whether the user is idle. The foreground is only offered after 10s without real input, or when the user clicks "let it take over".',
			);
		}
		const idleMs = ctx.now() - lastUserInputAt;
		if (idleMs < TAKEOVER_IDLE_MS) {
			const remaining = Math.max(0, Math.ceil((TAKEOVER_IDLE_MS - idleMs) / 1000));
			return failure(
				"takeover_conditions",
				`The user was active ${Math.round(idleMs / 1000)}s ago; the foreground is only offered after ${TAKEOVER_IDLE_MS / 1000}s without real input (about ${remaining}s more), or when the user clicks "let it take over".`,
			);
		}
	}
	const holder = ctx.leases.holder(TAKEOVER_RESOURCE);
	if (holder && holder.agentId !== agentId) {
		return failure("resource_busy", `Resource ${TAKEOVER_RESOURCE} is held by ${holder.agentId}.`, {
			holder: holderInfo(holder, ctx.now()),
		});
	}
	return undefined;
}

/** Heartbeats may report real user activity only through the trusted helper. */
export function handlePing(ctx: UserControlContext, agentId: string | undefined, request: PingRequest): BrokerReply {
	if (!agentId) return failure("unknown_agent", "Register with hello before pinging.");
	if (!ctx.registry.touch(agentId)) return failure("unknown_agent", `Unknown agent ${agentId}.`);
	// User activity comes from the helper's event tap. An agent that could
	// report it could claim the user is idle and grant itself the foreground.
	if (request.lastUserInputAt !== undefined && ctx.registry.get(agentId)?.role === "helper") {
		const activity = parseUserActivityReport(request.lastUserInputAt, ctx.now());
		if (!activity.ok) return failure("invalid_request", "lastUserInputAt must be milliseconds since the epoch.");
		ctx.registry.lastUserInputAt = Math.max(ctx.registry.lastUserInputAt ?? 0, activity.value);
	}
	return { ok: true, type: "ping", now: ctx.now() };
}
