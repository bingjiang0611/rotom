import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BROKER_PROTOCOL_VERSION,
	type AcquireRequest,
	type AcquireResponse,
	type AgentRegistration,
	type ApprovalDecision,
	type ApprovalRequestEvent,
	type BrokerErrorCode,
	type BrokerEvent,
	type BrokerFailure,
	type BrokerReply,
	type BrokerRequest,
	type EpochResponse,
	type HelloResponse,
	type LeaseInfo,
	type PolicyResponse,
	type StatusResponse,
	type StopResponse,
	type TargetAppInfo,
	type AppTier,
} from "./protocol.ts";
import { resolveBrokerSocketPath } from "./paths.ts";

const DEFAULT_HEARTBEAT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export class BrokerRequestError extends Error {
	readonly code: BrokerErrorCode;
	readonly reply: BrokerFailure;

	constructor(code: BrokerErrorCode, message: string, reply: BrokerFailure) {
		super(message);
		this.name = "BrokerRequestError";
		this.code = code;
		this.reply = reply;
	}
}

export class BrokerUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokerUnavailableError";
	}
}

export interface BrokerClientOptions {
	socketPath?: string;
	agent: AgentRegistration;
	/** Start a detached broker when nothing is listening. */
	spawnIfMissing?: boolean;
	heartbeatMs?: number;
	requestTimeoutMs?: number;
	onEvent?: (event: BrokerEvent) => void;
	onApproval?: (event: ApprovalRequestEvent) => Promise<ApprovalDecision>;
}

interface PendingRequest {
	resolve: (reply: BrokerReply) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function daemonPath(): string {
	return fileURLToPath(new URL("./daemon.ts", import.meta.url));
}

interface DaemonHandle {
	child: import("node:child_process").ChildProcess;
	/** Set once the daemon process exits; 0 means another broker won the start lock. */
	exitCode: number | null | undefined;
	error?: Error;
}

/**
 * Start a detached broker process.
 *
 * Returns immediately: the caller polls the socket, because waiting for the
 * process to exit would always block for the lifetime of a *winning* daemon.
 */
export function spawnBrokerDaemon(socketPath: string): DaemonHandle {
	const handle: DaemonHandle = { child: undefined as unknown as DaemonHandle["child"], exitCode: undefined };
	const child = spawn(process.execPath, [daemonPath()], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, ROTOM_CU_BROKER_SOCKET: socketPath },
		cwd: path.dirname(socketPath),
	});
	handle.child = child;
	child.on("error", (error) => {
		handle.error = new BrokerUnavailableError(`Failed to start broker daemon: ${error.message}`);
	});
	child.on("exit", (code) => {
		handle.exitCode = code;
	});
	child.unref();
	return handle;
}

/**
 * Client for one agent.
 *
 * Requests are framed as JSON lines and matched to responses by id. Unsolicited
 * events are dispatched to the registered handlers; approval events are answered
 * with the decision the UI provider returns, so the model never sees the card
 * and can never answer it.
 */
export class BrokerClient {
	readonly socketPath: string;
	readonly agent: AgentRegistration;
	hello!: HelloResponse;
	private socket: net.Socket;
	private buffer = "";
	private counter = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly heartbeatMs: number;
	private readonly requestTimeoutMs: number;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private closedIntentionally = false;
	private onEvent: ((event: BrokerEvent) => void) | undefined;
	private onApproval: ((event: ApprovalRequestEvent) => Promise<ApprovalDecision>) | undefined;
	private reconnectAttempts = 0;

	private constructor(options: BrokerClientOptions, socket: net.Socket) {
		this.socketPath = options.socketPath ?? resolveBrokerSocketPath();
		this.agent = options.agent;
		this.socket = socket;
		this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.onEvent = options.onEvent;
		this.onApproval = options.onApproval;
		this.attach();
	}

	static async connect(options: BrokerClientOptions): Promise<BrokerClient> {
		const socketPath = options.socketPath ?? resolveBrokerSocketPath();
		let socket: net.Socket;
		try {
			socket = await connectOnce(socketPath);
		} catch (error) {
			if (!options.spawnIfMissing) {
				throw new BrokerUnavailableError(`No broker on ${socketPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			socket = await connectWithRetry(socketPath, spawnBrokerDaemon(socketPath));
		}
		const client = new BrokerClient({ ...options, socketPath }, socket);
		client.hello = await client.handshake();
		client.startHeartbeat();
		return client;
	}

	setHandlers(handlers: { onEvent?: (event: BrokerEvent) => void; onApproval?: (event: ApprovalRequestEvent) => Promise<ApprovalDecision> }): void {
		this.onEvent = handlers.onEvent;
		this.onApproval = handlers.onApproval;
	}

	get agentId(): string {
		return this.agent.agentId;
	}

	/** Throws `BrokerRequestError` for a structured failure. */
	async acquire(request: Omit<AcquireRequest, "id" | "type">): Promise<AcquireResponse> {
		return (await this.expect({ type: "acquire", ...request })) as AcquireResponse;
	}

	async renew(leaseId: string): Promise<LeaseInfo> {
		const reply = (await this.expect({ type: "renew", leaseId })) as { lease: LeaseInfo };
		return reply.lease;
	}

	async release(leaseId: string): Promise<void> {
		await this.expect({ type: "release", leaseId });
	}

	async transfer(leaseId: string, toAgentId: string): Promise<LeaseInfo> {
		const reply = (await this.expect({ type: "transfer", leaseId, toAgentId })) as { lease: LeaseInfo };
		return reply.lease;
	}

	async epoch(resourceKey: string): Promise<number> {
		return ((await this.expect({ type: "epoch", resourceKey })) as EpochResponse).epoch;
	}

	async status(): Promise<StatusResponse["status"]> {
		return ((await this.expect({ type: "status" })) as StatusResponse).status;
	}

	async stop(targetAgentId?: string): Promise<string[]> {
		return ((await this.expect({ type: "stop", targetAgentId })) as StopResponse).stopped;
	}

	async policy(op: "get" | "allow_app", app?: TargetAppInfo, tier?: AppTier): Promise<PolicyResponse["policy"]> {
		return ((await this.expect({ type: "policy", op, app, tier })) as PolicyResponse).policy;
	}

	/** Raw reply; never throws for a structured broker failure. */
	async request(request: Omit<BrokerRequest, "id"> & { id?: string }): Promise<BrokerReply> {
		const id = request.id ?? this.nextId();
		const payload = { ...request, id } as BrokerRequest;
		return await this.send(payload);
	}

	close(): void {
		this.closedIntentionally = true;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new BrokerUnavailableError("Broker connection closed."));
		}
		this.pending.clear();
		this.socket.destroy();
	}

	private async expect(request: Omit<BrokerRequest, "id">): Promise<BrokerReply> {
		const reply = await this.request(request);
		if (reply.ok === false) throw new BrokerRequestError(reply.code, reply.message, reply);
		return reply;
	}

	private attach(): void {
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				if (line) this.dispatchLine(line);
			}
		});
		this.socket.on("error", () => undefined);
		this.socket.on("close", () => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new BrokerUnavailableError("Broker connection closed."));
			}
			this.pending.clear();
			if (!this.closedIntentionally) void this.reconnect();
		});
	}

	private dispatchLine(line: string): void {
		let message: BrokerReply | BrokerEvent;
		try {
			message = JSON.parse(line) as BrokerReply | BrokerEvent;
		} catch {
			return;
		}
		if (message && typeof message === "object" && "event" in message) {
			this.handleEvent(message as BrokerEvent);
			return;
		}
		const reply = message as BrokerReply & { id?: string };
		const id = (reply as unknown as { id?: string }).id;
		if (!id) return;
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(reply);
	}

	private handleEvent(event: BrokerEvent): void {
		this.onEvent?.(event);
		if (event.event !== "approval") return;
		const handler = this.onApproval;
		const finish = (decision: ApprovalDecision) => {
			void this.request({ type: "approval_response", requestId: event.requestId, decision } as Omit<BrokerRequest, "id">).catch(() => undefined);
		};
		if (!handler) {
			finish("deny");
			return;
		}
		void handler(event).then(finish, () => finish("deny"));
	}

	private send(request: BrokerRequest): Promise<BrokerReply> {
		if (this.socket.destroyed) return Promise.reject(new BrokerUnavailableError("Broker connection is closed."));
		return new Promise<BrokerReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.id);
				reject(new BrokerUnavailableError(`Broker request ${request.type} timed out.`));
			}, this.requestTimeoutMs);
			timer.unref?.();
			this.pending.set(request.id, { resolve, reject, timer });
			this.socket.write(`${JSON.stringify(request)}\n`);
		});
	}

	private async handshake(): Promise<HelloResponse> {
		const reply = await this.request({ type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent: this.agent } as Omit<BrokerRequest, "id">);
		if (reply.ok === false) throw new BrokerRequestError(reply.code, reply.message, reply);
		return reply as HelloResponse;
	}

	private startHeartbeat(): void {
		if (this.heartbeatMs <= 0) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.socket.destroyed) return;
			void this.request({ type: "ping" } as Omit<BrokerRequest, "id">).catch(() => undefined);
		}, this.heartbeatMs);
		this.heartbeatTimer.unref?.();
	}

	private async reconnect(): Promise<void> {
		this.reconnectAttempts += 1;
		if (this.reconnectAttempts > 3) return;
		try {
			this.socket = await connectWithRetry(this.socketPath);
			this.buffer = "";
			this.attach();
			this.hello = await this.handshake();
			this.reconnectAttempts = 0;
		} catch {
			/* the caller observes the next request failing */
		}
	}

	private nextId(): string {
		this.counter += 1;
		return `${this.agent.agentId}:${this.counter}`;
	}
}

function connectOnce(socketPath: string): Promise<net.Socket> {
	return new Promise<net.Socket>((resolve, reject) => {
		const socket = net.connect({ path: socketPath });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("connect timed out"));
		}, 1_000);
		timer.unref?.();
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		});
	});
}

async function connectWithRetry(socketPath: string, daemon?: DaemonHandle): Promise<net.Socket> {
	let lastError: unknown;
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			return await connectOnce(socketPath);
		} catch (error) {
			lastError = error;
		}
		if (daemon?.error) throw daemon.error;
		if (daemon && daemon.exitCode !== undefined && daemon.exitCode !== null) {
			if (daemon.exitCode !== 0) throw new BrokerUnavailableError(`Broker daemon exited with code ${daemon.exitCode}.`);
			// Exit 0: another broker won the start lock and is starting up.
			daemon = undefined;
		}
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	throw new BrokerUnavailableError(`Could not connect to broker on ${socketPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
