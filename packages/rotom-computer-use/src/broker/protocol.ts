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
	| ApprovalResponseRequest
	| PolicyRequest;

export interface LeaseInfo {
	leaseId: string;
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
}

export interface BrokerStatus {
	protocolVersion: number;
	pid: number;
	startedAt: number;
	agents: AgentStatus[];
	resources: Array<{ resourceKey: string; epoch: number; holder?: LeaseHolderInfo }>;
	waiters: Array<{ agentId: string; resourceKey: string; deadline: number }>;
	lastUserInputAt?: number;
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
	reason: "stopped_by_user" | "owner_disconnected" | "expired" | "transferred";
}

export interface StoppedEvent {
	event: "stopped";
	agentId: string;
}

export type BrokerEvent = ApprovalRequestEvent | RevokedEvent | StoppedEvent;

export function isBrokerEvent(value: unknown): value is BrokerEvent {
	if (!value || typeof value !== "object") return false;
	const event = (value as { event?: unknown }).event;
	return event === "approval" || event === "revoked" || event === "stopped";
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
