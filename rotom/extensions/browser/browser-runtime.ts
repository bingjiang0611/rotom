import { type BrowserObservationV1, BrowserRelayClientV1, BrowserArtifactStoreV1, BrowserRelayUnavailableErrorV1, BROWSER_INSPECT_TOOL_V1, BROWSER_INTERACT_TOOL_V1 } from "./browser-relay.ts";
import { observationTextBaseline } from "./chrome-extension/interaction-observation.js";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BROWSER_INTERACTION_AUDIT_ENTRY, MAX_RESULT_BYTES, MAX_SNAPSHOT_CURSORS } from "./tool-contract.ts";
import { record, validateTabs, browserResult } from "./tool-results.ts";
import { relayClientTimeoutMs } from "./chrome-extension/relay-deadline.js";
import { type BrowserLeaseCapabilityV1, BROWSER_LEASE_SCOPE_ENV_V1, loadBrowserLeaseForCallV1, checkBrowserLeaseV1 } from "./browser-lease.ts";
import { dirname } from "node:path";
import { type BrowserPolicyCapabilityV1, type BrowserPolicyDecisionV1, decideBrowserPolicyV1, readBrowserPolicyV1, browserPolicyPathV1 } from "./browser-policy.ts";
import { type SensitiveReasonV1, sensitiveAutoApprovedV1, SENSITIVE_CONFIRM_ENV_V1, sensitiveReasonTextV1 } from "./sensitive-actions.ts";
import { randomUUID } from "node:crypto";
import { foregroundBrowserFallbackReason } from "./browser-shell-guard.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRelayExtensionDependenciesV1 } from "./browser-dependencies.ts";
// A child lease outlives one task, not the session; the parent rewrites it to extend.
export const LEASE_TTL_MS = 12 * 60 * 60000;
export const LEASE_DEFAULT_MAX_TABS = 8;
export const SNAPSHOT_PAGE_TTL_MS = 5 * 60000;
export type SnapshotCursorV1 = {
	observation: BrowserObservationV1;
	offset: number;
	expiresAt: number;
};
export function createBrowserRuntimeV1(pi: ExtensionAPI, dependencies: BrowserRelayExtensionDependenciesV1) {
	let relay: Pick<BrowserRelayClientV1, "request" | "close" | "closed"> | undefined;
	let artifacts: BrowserArtifactStoreV1 | undefined;
	let currentSessionId: string | undefined;
	let browserRouteActive = false;
	const freshRoute = () => ({ fallbackAllowed: false, requestStarted: false, launchAttempted: false });
	let route = freshRoute();
	const fallbackReplayReason = () => route.launchAttempted
		? "launch_browser 已尝试，启动结果可能为 unknown，不可重试或跨浏览器重放。"
		: route.requestStarted ? "本次运行已派发 Relay 请求，禁止改用 launch_browser 回退；不可跨浏览器重放，也不要重复探测来解锁回退。" : undefined;
	let epoch = 0;
	let shutdown = false;
	let activeCommand: AbortController | undefined;
	const cursors = new Map<string, SnapshotCursorV1>();
	const textBaselines = new Map<number, ReturnType<typeof observationTextBaseline>>();
	const closeRuntime = async () => {
		// Retire and capture *all* resources before the first await. Old cleanup must
		// never close a store opened by a later tree/session operation.
		epoch += 1;
		activeCommand?.abort();
		route = freshRoute();
		const currentRelay = relay;
		const currentArtifacts = artifacts;
		relay = undefined;
		artifacts = undefined;
		cursors.clear();
		textBaselines.clear();
		currentSessionId = undefined;
		browserRouteActive = false;
		if (currentRelay && !currentRelay.closed) {
			try {
				await currentRelay.request("close", { all: true }, { timeoutMs: 5000 });
			}
			catch { /* abnormal relay loss preserves tabs for the next recovery instead of deleting them */ }
			currentRelay.close();
		}
		if (currentArtifacts)
			await currentArtifacts.close();
	};
	const recoverInteractionAudits = (ctx: ExtensionContext) => {
		const intents = new Map<string, Record<string, unknown>>();
		const terminal = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry?.type !== "custom" || entry.customType !== BROWSER_INTERACTION_AUDIT_ENTRY || !record(entry.data) || typeof entry.data.actionId !== "string")
				continue;
			if (entry.data.kind === "rotom-browser-interaction-intent" && entry.data.sessionId === ctx.sessionManager.getSessionId())
				intents.set(entry.data.actionId, entry.data);
			if (entry.data.kind === "rotom-browser-interaction-terminal")
				terminal.add(entry.data.actionId);
		}
		for (const actionId of intents.keys())
			if (!terminal.has(actionId))
				pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "unknown", actionAcknowledged: false, businessOutcome: "unknown", recoveryReason: "intent-without-terminal", timestamp: new Date().toISOString() });
	};
	const bindSession = async (ctx: ExtensionContext, signal?: AbortSignal) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const retiring = currentSessionId && currentSessionId !== sessionId ? closeRuntime() : undefined;
		const ownerEpoch = epoch;
		const assertOwner = () => {
			if (shutdown || epoch !== ownerEpoch || signal?.aborted)
				throw new Error("browser operation owner retired; result unknown, do not replay writes");
		};
		await retiring;
		assertOwner();
		currentSessionId = sessionId;
		recoverInteractionAudits(ctx);
		return assertOwner;
	};
	const client = async (ctx: ExtensionContext, assertOwner: () => void) => {
		assertOwner();
		const attemptRoute = route;
		attemptRoute.fallbackAllowed = false;
		if (!relay || relay.closed) {
			const connected = await dependencies.connectRelay({ sessionId: ctx.sessionManager.getSessionId() }).catch((error) => {
				assertOwner();
				// Never turn a reconnect after a dispatched operation into permission to replay
				// in another browser. Only typed, local pre-connect evidence grants one launch.
				if (route === attemptRoute && error instanceof BrowserRelayUnavailableErrorV1) {
					const blockedReason = fallbackReplayReason();
					if (blockedReason)
						throw new Error(`${error.message}；${blockedReason}`, { cause: error });
					route.fallbackAllowed = true;
					throw new Error(`${error.message}；本次未派发页面操作，可回退 launch_browser 一次。先告知用户：独立浏览器不继承 Chrome 登录态，可能需要重新登录。`, { cause: error });
				}
				throw error;
			});
			try {
				assertOwner();
			}
			catch (error) {
				connected.close();
				throw error;
			}
			if (relay && !relay.closed)
				connected.close();
			else {
				relay = connected;
				textBaselines.clear();
			}
		}
		const captured = relay!;
		return {
			async request(...args: Parameters<BrowserRelayClientV1["request"]>) {
				assertOwner();
				attemptRoute.requestStarted = true;
				attemptRoute.fallbackAllowed = false;
				const result = await captured.request(...args);
				assertOwner();
				return result;
			},
			/** Absent for the main agent; a child is always started with one. */
			get leaseToken() { return captured.leaseToken; },
			/** The published lease scope and the widened child leases are keyed by this. */
			get rootSessionId() { return captured.rootSessionId; },
			get keepTabs() { return captured.keepTabs; },
			/** Lease files live next to the socket this session actually connected to. */
			get socketPath() { return captured.socketPath; },
		};
	};
	const artifactStore = async (assertOwner: () => void) => {
		assertOwner();
		if (!artifacts) {
			const opened = await dependencies.openArtifactStore();
			try {
				assertOwner();
			}
			catch (error) {
				await opened.close();
				throw error;
			}
			if (artifacts)
				await opened.close();
			else
				artifacts = opened;
		}
		assertOwner();
		return artifacts!;
	};
	const readTabs = async (relayClient: Awaited<ReturnType<typeof client>>, signal?: AbortSignal) => validateTabs(await relayClient.request("tabs", {}, { signal, timeoutMs: relayClientTimeoutMs("tabs", {}) }));
	// Only origins and capabilities actually checked by the parent reach new child leases.
	// Listing a tab is not a grant: it can redirect or belong to a claimed user tab.
	// Full parent access does not give children every site; a child cannot publish scope.
	const parentGrantedOrigins = new Map<string, Set<BrowserLeaseCapabilityV1>>();
	const grantParentOrigin = (origin: string, capability: BrowserLeaseCapabilityV1) => {
		const granted = parentGrantedOrigins.get(origin) ?? new Set<BrowserLeaseCapabilityV1>();
		granted.add(capability);
		parentGrantedOrigins.set(origin, granted);
	};
	// Origins this run has opened. Used for in-flight relay checks, never as a grant.
	const authorizedOrigins = new Set<string>();
	const publishLeaseScope = (relayClient: Awaited<ReturnType<typeof client>>) => {
		if (relayClient.leaseToken !== undefined)
			return;
		if (parentGrantedOrigins.size === 0)
			return;
		process.env[BROWSER_LEASE_SCOPE_ENV_V1] = JSON.stringify({
			schemaVersion: 1,
			rootSessionId: relayClient.rootSessionId,
			origins: [...parentGrantedOrigins].map(([origin, capabilities]) => ({ origin, capabilities: [...capabilities] })),
			allow: { devtools: false, upload: false, download: false },
			maxTabs: LEASE_DEFAULT_MAX_TABS,
			keepTabs: relayClient.keepTabs,
			expiresAt: Date.now() + LEASE_TTL_MS,
		});
	};
	/**
	 * Structured refusal instead of a dispatched request. The parent decides what to
	 * do with it (T20); this layer never asks the user and never sends the request.
	 */
	const leaseRefusal = (denied: {
		origin: string;
		capability: BrowserLeaseCapabilityV1;
		reason: string;
	}) => browserResult({
		kind: "needs-approval",
		origin: denied.origin,
		capability: denied.capability,
		reason: denied.reason,
		message: `当前 lease 未授权 ${denied.capability} ${denied.origin || "(未知来源)"}（${denied.reason}）；该操作没有发出请求，需要父 agent 更新 lease 后重试。`,
	});
	/**
	 * Downloads cannot be refused per action, because the page starts them. The relay
	 * therefore learns the current lease answer on every write and cancels agent downloads
	 * that are not allowed; this reads that answer from the same lease file the write checks.
	 */
	const leaseAllowsDownload = async (relayClient: Awaited<ReturnType<typeof client>>) => {
		const token = relayClient.leaseToken;
		if (token === undefined)
			return true;
		const lease = await loadBrowserLeaseForCallV1({ relayDir: dirname(relayClient.socketPath), token, scope: process.env[BROWSER_LEASE_SCOPE_ENV_V1] });
		if (lease === undefined)
			return false;
		return lease.origins.some((entry) => checkBrowserLeaseV1(lease, { origin: entry.origin, capability: "download" }).ok);
	};
	/** Returns a refusal result, or undefined when the operation may proceed. */
	const leaseDenial = async (relayClient: Awaited<ReturnType<typeof client>>, capability: BrowserLeaseCapabilityV1, origin: string | undefined) => {
		const token = relayClient.leaseToken;
		// No token means no lease at all: the main agent is not gated.
		if (token === undefined)
			return undefined;
		const lease = await loadBrowserLeaseForCallV1({
			relayDir: dirname(relayClient.socketPath),
			token,
			scope: process.env[BROWSER_LEASE_SCOPE_ENV_V1],
		});
		const decision = checkBrowserLeaseV1(lease, { origin, capability });
		return decision.ok ? undefined : leaseRefusal(decision);
	};
	/** Concrete origins checked before dispatch; redirects cannot reuse another site's grant. */
	const policyAuthorizedOrigins = new Set<string>();
	const policyRefusal = (denied: {
		origin: string;
		capability: BrowserPolicyCapabilityV1;
		reason: string;
		message: string;
	}) => browserResult({
		kind: "needs-approval",
		...denied,
	});
	/** Full access by default. Explicit blocklists and child leases still apply. */
	const policyDenial = async (relayClient: Awaited<ReturnType<typeof client>>, capability: BrowserPolicyCapabilityV1, origin: string | undefined) => {
		if (origin === undefined)
			return undefined;
		let decision: BrowserPolicyDecisionV1;
		try {
			decision = decideBrowserPolicyV1(await readBrowserPolicyV1(browserPolicyPathV1()), { origin, capability });
		}
		catch (error) {
			return policyRefusal({ origin, capability, reason: "invalid-policy", message: `${error instanceof Error ? error.message : String(error)}；该操作没有发出请求。` });
		}
		if (decision.decision === "deny")
			return policyRefusal({ origin, capability, reason: "blocklist", message: `${origin} 在 browser-policy.json 的 blocklist 里（${decision.pattern}），不允许 ${capability}。` });
		policyAuthorizedOrigins.add(origin);
		if (relayClient.leaseToken === undefined)
			grantParentOrigin(origin, capability);
		return undefined;
	};
	/** A relay confirmation refusal proves no dispatch occurred, so approve it once.
	 * Children still report sensitive actions upward instead of granting themselves access. */
	const confirmSensitive = (relayClient: Awaited<ReturnType<typeof client>>, input: {
		reason: SensitiveReasonV1;
		matchedWord?: string | undefined;
		origin: string;
	}) => {
		const approval = (confirmation: "auto-full-access" | "auto-localhost") => ({ confirmed: true as const, confirmation });
		if (relayClient.leaseToken === undefined)
			return approval("auto-full-access");
		if (sensitiveAutoApprovedV1({ origin: input.origin, env: process.env[SENSITIVE_CONFIRM_ENV_V1] }))
			return approval("auto-localhost");
		const detail = sensitiveReasonTextV1({ reason: input.reason, matchedWord: input.matchedWord });
		return { confirmed: false as const, result: browserResult({
				kind: "needs-approval",
				origin: input.origin,
				capability: "interact",
				reason: "sensitive-action",
				message: `${detail}；${input.reason} 需要用户确认，子 agent 不能代替用户确认，该操作没有派发。`,
			}) };
	};
	const makeSnapshotPage = (freshObservation: BrowserObservationV1 | undefined, requestedLimit: number, cursor?: string) => {
		let offset = 0;
		let observation = freshObservation;
		if (cursor) {
			const cached = cursors.get(cursor);
			cursors.delete(cursor);
			if (!cached || cached.expiresAt < Date.now())
				throw new Error("snapshot cursor 已过期或不属于当前 observation");
			observation = cached.observation;
			offset = cached.offset;
		}
		if (!observation)
			throw new Error("snapshot observation 缺失");
		const { selection, ...publicObservation } = observation;
		let limit = Math.max(1, Math.min(requestedLimit, observation.nodes.length || 1));
		let result: Record<string, unknown>;
		for (;;) {
			const nodes = observation.nodes.slice(offset, offset + limit);
			const nextOffset = offset + nodes.length;
			result = { kind: "observation", observation: { ...publicObservation, nodes }, offset, availableNodes: observation.nodes.length, ...(selection ? { selection } : {}) };
			if (nextOffset < observation.nodes.length)
				result.nextCursor = "pending";
			if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESULT_BYTES || limit === 1)
				break;
			limit = Math.max(1, Math.floor(limit / 2));
		}
		if (result.nextCursor) {
			while (cursors.size >= MAX_SNAPSHOT_CURSORS)
				cursors.delete(cursors.keys().next().value!);
			const nextCursor = `pi1_browser_cursor_${randomUUID()}`;
			cursors.set(nextCursor, { observation, offset: offset + (result.observation as BrowserObservationV1).nodes.length, expiresAt: Date.now() + SNAPSHOT_PAGE_TTL_MS });
			result.nextCursor = nextCursor;
		}
		return result;
	};
	pi.on("before_agent_start", async () => { route = freshRoute(); });
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "launch_browser") {
			// Respect explicit tool selection: do not require a tool the caller excluded.
			if (!pi.getActiveTools().includes(BROWSER_INSPECT_TOOL_V1))
				return undefined;
			if (shutdown || ctx.signal?.aborted || currentSessionId !== ctx.sessionManager.getSessionId() || !route.fallbackAllowed || route.launchAttempted) {
				return { block: true, reason: fallbackReplayReason() ?? "请先使用 browser_inspect/browser_interact。仅本次 Relay 连接明确不可用且未派发页面操作时允许 launch_browser 一次；登录页、空结果、stale、超时、unknown、取消或协议/权限错误不授权回退。" };
			}
			// Consume at preflight, not on success: a failed/unknown launch may have spawned.
			route.fallbackAllowed = false;
			route.launchAttempted = true;
			if (ctx.hasUI)
				ctx.ui.notify("Relay 不可用，回退到独立浏览器；不继承 Chrome 登录态，可能需要重新登录。", "warning");
			return undefined;
		}
		if (event.toolName === BROWSER_INSPECT_TOOL_V1 || event.toolName === BROWSER_INTERACT_TOOL_V1)
			route.fallbackAllowed = false;
		if (event.toolName !== "bash")
			return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const reason = foregroundBrowserFallbackReason(command, browserRouteActive);
		if (!reason)
			return undefined;
		return { block: true, reason };
	});
	pi.on("session_start", async (_event, ctx) => { await bindSession(ctx); });
	pi.on("session_tree", async (_event, ctx) => { await closeRuntime(); await bindSession(ctx); });
	pi.on("session_before_tree", closeRuntime);
	pi.on("session_before_switch", closeRuntime);
	pi.on("session_before_fork", closeRuntime);
	pi.on("session_shutdown", async () => { shutdown = true; await closeRuntime(); });
	return { textBaselines, bindSession, client, artifactStore, readTabs, authorizedOrigins, publishLeaseScope, leaseRefusal, leaseAllowsDownload, leaseDenial, policyAuthorizedOrigins, policyDenial, confirmSensitive, makeSnapshotPage,
		get browserRouteActive() { return browserRouteActive; },
		set browserRouteActive(value: boolean) { browserRouteActive = value; },
		get activeCommand() { return activeCommand; },
		set activeCommand(value: AbortController | undefined) { activeCommand = value; },
		get epoch() { return epoch; },
		get shutdown() { return shutdown; } };
}
export type BrowserRuntimeV1 = ReturnType<typeof createBrowserRuntimeV1>;
