import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Lease tokens: the broker's write authority in a form the native helper can check.
 *
 * The broker is the arbiter, but the helper is the process that actually injects
 * the event. Without a token it can only trust whoever connects to its socket; with
 * one, an agent that never got a lease (or whose lease was revoked) cannot make the
 * helper write to an app.
 *
 * The key never leaves the broker and the helper: it is generated per broker
 * process, kept in memory, and handed to a `role=helper` connection only. It is
 * never written to disk and never passes through an agent.
 */
export interface LeaseClaims {
	agentId: string;
	resourceKey: string;
	/** Target process, for the `desktop-pid:<pid>` resources; absent otherwise. */
	pid?: number;
	leaseId: string;
	expiresAt: number;
}

/** `desktop-pid:<pid>` resources identify one process; other resources do not. */
export function leasePidOf(resourceKey: string): number | undefined {
	const match = /^desktop-pid:(\d+)$/.exec(resourceKey);
	if (!match) return undefined;
	const pid = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function mac(secret: Buffer, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signLeaseToken(secret: Buffer, claims: LeaseClaims): string {
	const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
	return `${payload}.${mac(secret, payload)}`;
}

export type LeaseTokenCheck =
	| { ok: true; claims: LeaseClaims }
	| { ok: false; code: "lease_invalid" | "lease_expired" };

/**
 * Verify a token. Used by tests and by any non-Swift helper that has to enforce
 * the same rule; the macOS helper implements the identical check in Swift.
 */
export function verifyLeaseToken(secret: Buffer, token: string, now: number): LeaseTokenCheck {
	const separator = token.lastIndexOf(".");
	if (separator <= 0 || separator === token.length - 1) return { ok: false, code: "lease_invalid" };
	const payload = token.slice(0, separator);
	const presented = token.slice(separator + 1);
	const expected = mac(secret, payload);
	const presentedBytes = Buffer.from(presented, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
		return { ok: false, code: "lease_invalid" };
	}
	let claims: LeaseClaims;
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LeaseClaims;
	} catch {
		return { ok: false, code: "lease_invalid" };
	}
	if (!claims || typeof claims.leaseId !== "string" || typeof claims.resourceKey !== "string" || typeof claims.expiresAt !== "number") {
		return { ok: false, code: "lease_invalid" };
	}
	if (claims.expiresAt <= now) return { ok: false, code: "lease_expired" };
	return { ok: true, claims };
}
