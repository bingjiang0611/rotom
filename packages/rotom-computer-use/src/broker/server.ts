import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { BrokerCore, type BrokerCoreOptions } from "./core.ts";
import { DEFAULT_IDLE_SHUTDOWN_MS, type BrokerEvent, type BrokerRequest, type BrokerReply } from "./protocol.ts";
import { ensurePrivateDir, assertNoSymlink, resolveBrokerSocketPath, UnsafePathError } from "./paths.ts";

export class BrokerAlreadyRunningError extends Error {
	readonly socketPath: string;

	constructor(socketPath: string) {
		super(`A broker is already listening on ${socketPath}.`);
		this.name = "BrokerAlreadyRunningError";
		this.socketPath = socketPath;
	}
}

export interface BrokerServerOptions extends BrokerCoreOptions {
	socketPath?: string;
	idleShutdownMs?: number;
	/** Poll interval for TTL expiry and heartbeat timeouts. */
	sweepIntervalMs?: number;
}

export interface BrokerServer {
	readonly socketPath: string;
	readonly core: BrokerCore;
	/** Resolves when the server has closed, for whatever reason. */
	readonly closed: Promise<void>;
	/** One housekeeping pass: sweep plus idle shutdown check. */
	tick(): boolean;
	close(): Promise<void>;
}

async function isConnectable(socketPath: string): Promise<boolean> {
	if (!existsSync(socketPath)) return false;
	try {
		if (!lstatSync(socketPath).isSocket()) return false;
	} catch {
		return false;
	}
	return await new Promise<boolean>((resolve) => {
		const probe = net.connect({ path: socketPath });
		const timer = setTimeout(() => {
			probe.destroy();
			resolve(false);
		}, 500);
		timer.unref?.();
		probe.once("connect", () => {
			clearTimeout(timer);
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			clearTimeout(timer);
			probe.destroy();
			resolve(false);
		});
	});
}

const LOCK_BUSY_RETRIES = 8;
const LOCK_BUSY_RETRY_MS = 25;

function pidFromLock(lockPath: string): number {
	try {
		const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
	} catch {
		return 0;
	}
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Take the start lock, or report that another broker is starting.
 *
 * `openSync(..., "wx")` creates the file before the owner has written its pid into
 * it, so a racing process can read an empty lock, decide it is stale, delete it,
 * and end up listening on the same socket (observed as `EADDRINUSE`). An empty or
 * unparsable lock is therefore treated as "someone is starting": it is retried for
 * a bounded time and only then treated as an orphan.
 */
async function acquireStartLock(lockPath: string): Promise<number | undefined> {
	assertNoSymlink(lockPath);
	for (let attempt = 0; attempt < LOCK_BUSY_RETRIES + 2; attempt += 1) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeSync(fd, `${process.pid}\n`);
			return fd;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const pid = pidFromLock(lockPath);
		if (pid > 0 && pidIsAlive(pid)) return undefined;
		if (pid === 0 && attempt < LOCK_BUSY_RETRIES) {
			// The owner may still be writing its pid; an orphaned empty lock is only
			// concluded after the bounded wait below.
			await new Promise((resolve) => setTimeout(resolve, LOCK_BUSY_RETRY_MS));
			continue;
		}
		try {
			unlinkSync(lockPath);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Start the Desktop Broker on a Unix socket.
 *
 * The socket directory is 0700 and the socket 0600. A start lock plus a
 * connectable-socket probe guarantee that two racing Pi processes end up with
 * exactly one broker: the loser exits and connects to the winner instead.
 */
export async function startBrokerServer(options: BrokerServerOptions = {}): Promise<BrokerServer> {
	const socketPath = options.socketPath ? path.resolve(options.socketPath) : resolveBrokerSocketPath();
	const directory = path.dirname(socketPath);
	ensurePrivateDir(directory);
	assertNoSymlink(socketPath);
	if (await isConnectable(socketPath)) throw new BrokerAlreadyRunningError(socketPath);

	const lockPath = `${socketPath}.lock`;
	const lockFd = await acquireStartLock(lockPath);
	if (lockFd === undefined) throw new BrokerAlreadyRunningError(socketPath);

	// The previous owner may have left a dead socket file behind.
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			/* ignore: listen() reports the real failure */
		}
	}

	const now = options.now ?? Date.now;
	const core = new BrokerCore(options);
	const sockets = new Map<string, net.Socket>();
	const clients = new Set<net.Socket>();
	const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
	let idleSince = now();

	const socketServer = net.createServer({ allowHalfOpen: false });

	socketServer.on("connection", (socket) => {
		clients.add(socket);
		let agentId: string | undefined;
		let buffer = "";
		const write = (message: BrokerReply | BrokerEvent) => {
			if (socket.destroyed) return;
			socket.write(`${JSON.stringify(message)}\n`);
		};
		core.attachTransport({
			send(target, event) {
				const targetSocket = sockets.get(target);
				if (!targetSocket || targetSocket.destroyed) return false;
				targetSocket.write(`${JSON.stringify(event)}\n`);
				return true;
			},
			connectedAgents: () => core.registry.connectedAgents().length,
		});

		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let request: BrokerRequest;
				try {
					request = JSON.parse(line) as BrokerRequest;
				} catch {
					write({ ok: false, code: "invalid_request", message: "Malformed JSON line." });
					continue;
				}
				if (agentId !== undefined) {
					// Every inbound request is also a heartbeat.
					core.registry.touch(agentId);
				}
				void core.handle(agentId, request).then((reply) => {
					// Echo the request id so the client can match this response.
					write({ ...reply, id: request.id } as BrokerReply);
					if (agentId === undefined && reply.ok && (reply as { type?: string }).type === "hello") {
						const registration = (request as Extract<BrokerRequest, { type: "hello" }>).agent;
						agentId = registration.agentId;
						sockets.set(agentId, socket);
						idleSince = now();
					}
				}).catch((error: unknown) => {
					write({ ok: false, code: "invalid_request", message: error instanceof Error ? error.message : String(error) });
				});
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			clients.delete(socket);
			if (agentId === undefined) return;
			sockets.delete(agentId);
			core.handleDisconnect(agentId);
			if (core.registry.connectedAgents().length === 0) idleSince = now();
		});
	});

	await new Promise<void>((resolve, reject) => {
		socketServer.once("error", reject);
		socketServer.listen(socketPath, () => {
			socketServer.removeListener("error", reject);
			resolve();
		});
	});
	chmodSync(socketPath, 0o600);

	let closedResolve!: () => void;
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});
	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			clearInterval(sweepTimer);
			const serverClosed = new Promise<void>((resolve, reject) => {
				socketServer.close((error) => error ? reject(error) : resolve());
			});
			core.close();
			for (const socket of clients) socket.destroy();
			clients.clear();
			sockets.clear();
			await serverClosed;
			try {
				unlinkSync(socketPath);
			} catch {
				/* already gone */
			}
			try {
				unlinkSync(lockPath);
			} catch {
				/* already gone */
			}
			closeSync(lockFd);
			closedResolve();
		})();
		return shutdownPromise;
	};

	const tick = (): boolean => {
		core.sweep();
		const idle = core.registry.connectedAgents().length === 0;
		if (!idle) {
			idleSince = now();
			return false;
		}
		if (now() - idleSince >= idleShutdownMs) {
			void shutdown();
			return true;
		}
		return false;
	};

	const sweepTimer = setInterval(() => tick(), options.sweepIntervalMs ?? 250);
	sweepTimer.unref?.();

	return {
		socketPath,
		core,
		closed,
		tick,
		close: shutdown,
	};
}

export { UnsafePathError };
