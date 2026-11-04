import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Socket override used by tests and by an isolated helper/session setup. */
export const BROKER_SOCKET_ENV = "ROTOM_CU_BROKER_SOCKET";

export function defaultBrokerSocketPath(): string {
	return path.join(os.homedir(), "Library", "Caches", "rotom-computer-use", "broker.sock");
}

export function resolveBrokerSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment[BROKER_SOCKET_ENV]?.trim();
	return configured ? path.resolve(configured) : defaultBrokerSocketPath();
}

export class UnsafePathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafePathError";
	}
}

/**
 * Create (or verify) a private directory.
 *
 * Symlinked ancestors are rejected outright: the broker socket and the trace
 * store both carry a trust decision ("only this user may read it"), and a
 * symlink can redirect either into a shared location.
 */
export function ensurePrivateDir(dir: string, mode = 0o700): void {
	assertNoSymlink(dir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode });
	const stats = lstatSync(dir);
	if (!stats.isDirectory()) throw new UnsafePathError(`${dir} is not a directory.`);
	if ((stats.mode & 0o077) !== 0) chmodSync(dir, mode);
}

export function assertNoSymlink(target: string): void {
	if (!existsSync(target)) return;
	if (lstatSync(target).isSymbolicLink()) throw new UnsafePathError(`${target} is a symlink; refusing to use it.`);
}
