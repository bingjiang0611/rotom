/**
 * Direct L2 requests for the F5 signature check (A8).
 *
 * The product decides delivery from the compatibility list (`src/policy/l2-compat.ts`)
 * and there is deliberately no product switch to widen it. This builder therefore
 * lives in the script layer: it produces a helper request that asks for
 * `delivery=l2` on a process the script itself started, so the very first real run
 * of `SLEventPostToPid` can be observed in isolation. No product code imports it.
 */
export const DIRECT_L2_SOURCE = "scripts/lib/l2-direct.mjs";

/**
 * A helper `act` request pinned to L2.
 *
 * `policy` stays `background`: the point is that the delivery class is explicit, not
 * that the foreground ladder is skipped.
 */
export function buildDirectL2Request({ lookId, pid, ref, action, params = {} }) {
	if (!lookId || !Number.isFinite(pid) || pid <= 0 || !ref) throw new Error("direct L2 needs lookId, pid and a ref");
	if (!["click", "typeText"].includes(action)) throw new Error(`direct L2 only covers click and typeText, got ${action}`);
	return {
		lookId,
		pid: Math.trunc(pid),
		target: { ref },
		action,
		params: { ...params, delivery: "l2" },
		policy: "background",
		// The overlay is a second moving part; the first real run measures delivery only.
		cursorOverlay: false,
	};
}

/** True when a request asks for L2 explicitly, i.e. it did not come from the whitelist. */
export function isDirectL2(request) {
	return request?.params?.delivery === "l2";
}
