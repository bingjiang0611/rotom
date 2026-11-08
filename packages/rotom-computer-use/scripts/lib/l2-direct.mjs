/**
 * Direct native-transport requests for the B0/B1 checks.
 *
 * The product decides delivery from policy and compatibility data; there is deliberately
 * no product switch that pins a transport. These builders therefore live in the script
 * layer and only address a process the script started. No product code imports them.
 */
export const DIRECT_L2_SOURCE = "scripts/lib/l2-direct.mjs";

/**
 * A helper `act` request pinned to L2.
 *
 * `policy` stays `background`: the point is that the delivery class is explicit, not
 * that the foreground ladder is skipped.
 */
export function buildDirectTransportRequest({ lookId, pid, ref, action, delivery, params = {} }) {
	if (!lookId || !Number.isFinite(pid) || pid <= 0 || !ref) throw new Error("direct delivery needs lookId, pid and a ref");
	if (!["click", "typeText"].includes(action)) throw new Error(`direct delivery only covers click and typeText, got ${action}`);
	if (!["l2", "pid"].includes(delivery)) throw new Error(`direct delivery must be l2 or pid, got ${delivery}`);
	return {
		lookId,
		pid: Math.trunc(pid),
		target: { ref },
		action,
		// `requireTransport` prevents an equivalent AX write from hiding whether the
		// requested native transport reached the target process.
		params: { ...params, delivery, requireTransport: true },
		policy: "background",
		// The overlay is a second moving part; the first real run measures delivery only.
		cursorOverlay: false,
	};
}

export function buildDirectL2Request(options) {
	return buildDirectTransportRequest({ ...options, delivery: "l2" });
}

/** True when a request asks for L2 explicitly, i.e. it did not come from the whitelist. */
export function isDirectL2(request) {
	return request?.params?.delivery === "l2";
}
