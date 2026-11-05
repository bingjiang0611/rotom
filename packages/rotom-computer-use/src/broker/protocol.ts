/**
 * Desktop Broker wire protocol.
 *
 * One JSON object per line in both directions. Every request carries an `id`
 * that is echoed on its response. Events are broker-initiated and have no
 * matching request. Both sides ignore unknown fields so that a newer peer can
 * add metadata without breaking an older one.
 */
export const BROKER_PROTOCOL_VERSION = 1;

/** App write lease lifetime. Renewed by every action the holder dispatches. */
export const DEFAULT_LEASE_TTL_MS = 60_000;
/** `wait: true` callers queue FIFO for at most this long. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** A registered agent that stops heartbeating for this long is disconnected. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
/** The broker exits after this long with no connected agent. */
export const DEFAULT_IDLE_SHUTDOWN_MS = 600_000;
/** How long an approval request may stay unanswered before it is refused. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * The global foreground resource (PLAN §7, L4).
 *
 * Taking it converts the machine into "the agent is driving": physical input goes
 * to one app, the rest of the desktop is not the agent's. It is a single global
 * resource on purpose, so two agents can never both believe they own the screen.
 */
export const TAKEOVER_RESOURCE = "desktop-foreground";
/** The user must be idle this long before an agent may take the foreground. */
export const TAKEOVER_IDLE_MS = 10_000;
/** Window in which the user's explicit "let it take over" click counts as consent. */
export const TAKEOVER_APPROVAL_WINDOW_MS = 60_000;

export type BrokerErrorCode =
	| "invalid_request"
	| "protocol_mismatch"
	| "unknown_agent"
	| "unknown_lease"
	| "resource_busy"
	| "stale"
	| "not_holder"
	| "lease_expired"
	| "denied"
	| "approval_unavailable"
	| "approval_denied"
	| "stopped_by_user"
	| "not_permitted"
	| "paused_interfered"
	| "preempted_by_user"
	| "takeover_conditions"
	| "lease_invalid"
	| "unsupported";

/** Who currently holds a resource and how long the hold lasts. */
export interface LeaseHolderInfo {
	agentId: string;
	expiresAt: number;
	remainingMs: number;
	leaseId: string;
}

/**
 * Identity a Pi process registers as. `agentId` is derived locally per process,
 * `parentAgentId` comes from the spawning subagent host, and `pidChain` is the
 * process ancestry used to exclude the host terminal from observation.
 */
export interface AgentRegistration {
	agentId: string;
	parentAgentId?: string;
	hasUI: boolean;
	pid: number;
	/** Ancestor pids, nearest first (excluding self). */
	pidChain: number[];
	/** Session working directory; the broker applies that project's policy, which may only tighten. */
	cwd?: string;
	/**
	 * Connection role. `helper` is the native executor; only it may stop other
	 * agents, because stopping is the user's control surface and the helper is the
	 * only process the user drives directly. Everything else is an `agent`.
	 */
	role?: "agent" | "helper";
}

export interface TargetAppInfo {
	appName?: string;
	bundleId?: string;
}

/** One model-facing action the caller is about to dispatch. */
export interface ActionIntent {
	/** `act_ui` action name, new `act_ui` action, or tool name (`clipboard`, ...). */
	name: string;
	/** Text of the resolved element, used for sensitive-action matching only. */
	label?: string;
}

export interface HelloRequest {
	id: string;
	type: "hello";
	protocolVersion: number;
	agent: AgentRegistration;
}

export interface PingRequest {
	id: string;
	type: "ping";
	/** Broker-visible user activity, forwarded by the helper listener. */
	lastUserInputAt?: number;
}

export interface AcquireRequest {
	id: string;
	type: "acquire";
	resourceKey: string;
	/** Observation epoch the caller's state was taken at. Omitted for a fresh state. */
	baseEpoch?: number;
	/** Queue FIFO instead of failing with `resource_busy`. */
	wait?: boolean;
	ttlMs?: number;
	app?: TargetAppInfo;
	action?: ActionIntent;
}

export interface RenewRequest {
	id: string;
	type: "renew";
	leaseId: string;
}

export interface ReleaseRequest {
	id: string;
	type: "release";
	leaseId: string;
}

export interface TransferRequest {
	id: string;
	type: "transfer";
	leaseId: string;
	toAgentId: string;
}

export interface EpochRequest {
	id: string;
	type: "epoch";
	resourceKey: string;
}

export interface StatusRequest {
	id: string;
	type: "status";
}

export interface StopRequest {
	id: string;
	type: "stop";
	/** Omit to stop every agent except the caller. */
	targetAgentId?: string;
}

/**
 * An agent reporting that its own action disturbed the user.
 *
 * The helper is the only component that can see "the frontmost app changed while
 * the user was typing within 2 seconds" (PLAN §6), so it measures and the broker
 * enforces: the agent is paused and loses its write leases. Reads stay allowed.
 */
export interface InterferenceRequest {
	id: string;
	type: "interference";
	/** Short reason code from the observing surface; never user content. */
	evidence?: string;
}

/**
 * The user let an agent take the foreground ("让它接管").
 *
 * Only the helper may say so: it is a click in the menu bar, which no model can
 * press. The broker remembers it for `TAKEOVER_APPROVAL_WINDOW_MS` so the agent's
 * next takeover request does not have to wait for 10 s of idle.
 */
export interface TakeoverApprovalRequest {
	id: string;
	type: "takeover_approval";
}

/**
 * A real user input arrived while an agent held the foreground.
 *
 * Reported by the helper (it is the only process that can see the event tap), and
 * the broker owns the consequence: the takeover lease is revoked and the agent is
 * told `preempted_by_user`. The already-dispatched steps stay as they happened.
 */
export interface PreemptedRequest {
	id: string;
	type: "preempted";
	targetAgentId: string;
	/** Constant reason code; never user content. */
	reason?: "user_input";
}

/** Resume a paused agent. User control only: the helper connection may ask. */
export interface ResumeRequest {
	id: string;
	type: "resume";
	targetAgentId: string;
}

export interface ApprovalResponseRequest {
	id: string;
	type: "approval_response";
	requestId: string;
	decision: ApprovalDecision;
}

export interface PolicyRequest {
	id: string;
	type: "policy";
	/** `get` returns the effective policy; `allow_app` persists a permanent grant. */
	op: "get" | "allow_app";
	app?: TargetAppInfo;
	/** Tier the caller observed in the request card; must match the broker's. */
	tier?: AppTier;
}

export type AppTier = "view" | "click" | "full";
export type ApprovalDecision = "allow_session" | "always" | "deny";

export type BrokerRequest =
	| HelloRequest
	| PingRequest
	| AcquireRequest
	| RenewRequest
	| ReleaseRequest
	| TransferRequest
	| EpochRequest
	| StatusRequest
	| StopRequest
	| InterferenceRequest
	| TakeoverApprovalRequest
	| PreemptedRequest
	| ResumeRequest
	| ApprovalResponseRequest
	| PolicyRequest;

export interface LeaseInfo {
	leaseId: string;
	/**
	 * Signed proof of this lease for the native helper.
	 *
	 * Only the broker and the helper know the key, so a helper that has one can
	 * refuse writes from an agent without a valid, unrevoked, unexpired lease.
	 */
	token?: string;
	resourceKey: string;
	agentId: string;
	/** Epoch granted to this write; the caller stores it in its observation state. */
	epoch: number;
	expiresAt: number;
	ttlMs: number;
}

export interface AgentStatus {
	agentId: string;
	parentAgentId?: string;
	hasUI: boolean;
	pid: number;
	lastSeenAt: number;
	leases: Array<{ resourceKey: string; leaseId: string; expiresAt: number }>;
	/** Present while the agent is paused after interfering with the user. */
	paused?: { reason: "interfered_with_user"; at: number };
}

export interface BrokerStatus {
	protocolVersion: number;
	pid: number;
	startedAt: number;
	agents: AgentStatus[];
	resources: Array<{ resourceKey: string; epoch: number; holder?: LeaseHolderInfo }>;
	waiters: Array<{ agentId: string; resourceKey: string; deadline: number }>;
	lastUserInputAt?: number;
	/** Who currently holds the foreground, if anyone. */
	takeover?: { agentId: string; since: number };
}

export type BrokerFailureCode = BrokerErrorCode;

export interface BrokerFailure {
	ok: false;
	code: BrokerFailureCode;
	message: string;
	holder?: LeaseHolderInfo;
	currentEpoch?: number;
	expectedEpoch?: number;
	tier?: AppTier;
}

export interface HelloResponse {
	ok: true;
	type: "hello";
	protocolVersion: number;
	brokerPid: number;
	startedAt: number;
	/** Base64 lease-signing key; present only for `role=helper` registrations. */
	leaseKey?: string;
}

export interface PongResponse {
	ok: true;
	type: "ping";
	now: number;
}

export interface AcquireResponse {
	ok: true;
	type: "acquire";
	lease: LeaseInfo;
	tier: AppTier;
	/** True when the tier decision required a (cached) approval. */
	approved?: boolean;
}

export interface RenewResponse {
	ok: true;
	type: "renew";
	lease: LeaseInfo;
}

export interface ReleaseResponse {
	ok: true;
	type: "release";
	leaseId: string;
}

export interface TransferResponse {
	ok: true;
	type: "transfer";
	lease: LeaseInfo;
}

export interface EpochResponse {
	ok: true;
	type: "epoch";
	resourceKey: string;
	epoch: number;
}

export interface StatusResponse {
	ok: true;
	type: "status";
	status: BrokerStatus;
}

export interface StopResponse {
	ok: true;
	type: "stop";
	stopped: string[];
}

export interface InterferenceResponse {
	ok: true;
	type: "interference";
	/** False when the report did not meet the pause rule. */
	paused: boolean;
}

export interface ResumeResponse {
	ok: true;
	type: "resume";
	resumed: string[];
}

export interface TakeoverApprovalResponse {
	ok: true;
	type: "takeover_approval";
	/** Timestamp the consent is valid from; the broker's clock. */
	approvedAt: number;
}

export interface PreemptedResponse {
	ok: true;
	type: "preempted";
	/** True when the agent really held the foreground at that moment. */
	revoked: boolean;
}

export interface ApprovalResponseAck {
	ok: true;
	type: "approval_response";
	requestId: string;
}

export interface PolicyResponse {
	ok: true;
	type: "policy";
	policy: {
		path: string;
		projectPath: string;
		apps: Record<string, AppTier>;
		/** Apps the user allowed to take the foreground (L4). */
		foreground?: string[];
		sensitive: boolean;
	};
}

export type BrokerResponse =
	| HelloResponse
	| PongResponse
	| AcquireResponse
	| RenewResponse
	| ReleaseResponse
	| TransferResponse
	| EpochResponse
	| StatusResponse
	| StopResponse
	| InterferenceResponse
	| TakeoverApprovalResponse
	| PreemptedResponse
	| ResumeResponse
	| ApprovalResponseAck
	| PolicyResponse;

export interface ApprovalRequestEvent {
	event: "approval";
	requestId: string;
	agentId: string;
	resourceKey: string;
	app?: TargetAppInfo;
	tier: AppTier;
	action?: ActionIntent;
	/** Present for high-risk app categories (terminal, IDE, Finder, Settings, password managers). */
	warning?: string;
	deadline: number;
}

export interface RevokedEvent {
	event: "revoked";
	agentId: string;
	leaseIds: string[];
	reason: "stopped_by_user" | "owner_disconnected" | "expired" | "transferred" | "paused_interfered" | "preempted_by_user";
}

/** The agent was paused because one of its actions disturbed the user (PLAN §6). */
export interface PausedEvent {
	event: "paused";
	agentId: string;
	reason: "interfered_with_user";
	at: number;
	/** Constant reason code from the observing surface; never user content. */
	evidence?: string;
}

/** A user action lifted a pause; the model cannot resume itself. */
export interface ResumedEvent {
	event: "resumed";
	agentId: string;
}

export interface StoppedEvent {
	event: "stopped";
	agentId: string;
}

/** The user touched the machine while this agent held the foreground (L4 ended). */
export interface PreemptedEvent {
	event: "preempted";
	agentId: string;
	reason: "user_input";
	at: number;
}

export type BrokerEvent = ApprovalRequestEvent | RevokedEvent | StoppedEvent | PausedEvent | ResumedEvent | PreemptedEvent;

export function isBrokerEvent(value: unknown): value is BrokerEvent {
	if (!value || typeof value !== "object") return false;
	const event = (value as { event?: unknown }).event;
	return event === "approval" || event === "revoked" || event === "stopped" || event === "paused" || event === "resumed" || event === "preempted";
}

/** Response envelope: either a typed success or a structured failure. */
export type BrokerReply = BrokerResponse | BrokerFailure;

export function failure(
	code: BrokerErrorCode,
	message: string,
	extra: Omit<BrokerFailure, "ok" | "code" | "message"> = {},
): BrokerFailure {
	return { ok: false, code, message, ...extra };
}
