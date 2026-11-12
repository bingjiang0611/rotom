/**
 * Building the `act` request the helper receives.
 *
 * Moved out of `src/bridge.ts` so the request shape - in particular which delivery
 * the caller pins, and whether the transport must actually be used - can be
 * asserted in a test without a live look or backend.
 */
import type { OpenTarget } from "../open-target.ts";
import type { NativeInputDelivery, PlatformActRequest, PlatformDeliveryPolicy } from "../platform/types.ts";

/** What `helperActRequest` needs from the runtime, passed in so this stays pure. */
export interface ActRequestContext {
	lookId: string;
	pid: number;
	cursorAgentId: string;
	action: {
		action: string;
		params: Record<string, unknown>;
		target: unknown;
	};
	policy: PlatformDeliveryPolicy;
	/** Delivery the policy (or a fallback) picked for this target. */
	delivery: NativeInputDelivery;
	lease?: PlatformActRequest["lease"];
	/**
	 * Ask the helper to use the pinned delivery instead of an equivalent AX write.
	 *
	 * Only the direct-L2 check sets this: its whole purpose is to observe the
	 * directed-delivery transport, and a request that names `delivery` without this
	 * flag may legitimately be satisfied by AX text insertion first.
	 */
	requireTransport?: boolean;
}

export function buildActRequest(context: ActRequestContext): PlatformActRequest {
	const { lookId, pid, cursorAgentId, action, policy, lease } = context;
	const delivery = context.delivery;
	const transport = context.requireTransport ? { requireTransport: true as const } : {};
	const base = { lookId, pid, target: action.target as PlatformActRequest["target"], policy, cursorAgentId, ...(lease ? { lease } : {}) };
	const delivered = { delivery, ...transport };
	return ((): PlatformActRequest => {
		switch (action.action) {
			case "press":
			case "click": return { ...base, action: action.action, params: { ...action.params, ...delivered } };
			case "setText": return { ...base, action: action.action, params: { text: String(action.params.text ?? ""), ...delivered } };
			case "typeText": return { ...base, action: action.action, params: { text: String(action.params.text ?? ""), ...delivered } };
			case "keypress": return { ...base, action: action.action, params: { keys: action.params.keys as string[], ...delivered } };
			case "scroll": return { ...base, action: action.action, params: { scrollX: Number(action.params.scrollX ?? 0), scrollY: Number(action.params.scrollY ?? 0), ...delivered } };
			case "drag": return { ...base, action: action.action, params: { path: action.params.path as never, ...delivered } };
			case "moveMouse": return { ...base, action: action.action, params: delivered };
			case "hover": return { ...base, action: action.action, params: delivered };
			case "select":
				return { ...base, action: "select", params: { ...(typeof action.params.option === "string" ? { option: action.params.option } : {}), ...delivered } };
			case "setChecked":
				return { ...base, action: "setChecked", params: { checked: action.params.checked === true, ...delivered } };
			case "setValue":
				return { ...base, action: "setValue", params: { value: Number(action.params.value), ...delivered } };
			case "open":
				return { ...base, action: "open", params: {
					openTarget: action.params.openTarget as OpenTarget | undefined,
					openApproved: action.params.openApproved as boolean | undefined,
					...delivered,
				} };
			case "expand":
			case "collapse":
			case "scrollTo":
			case "focus":
			case "clear":
			case "showMenu":
				return { ...base, action: action.action, params: delivered };
			default:
				// Callers only build requests for actions the helper serves; anything else is
				// a programming error, not something to send with a guessed payload.
				throw new Error(`No helper request shape for action '${action.action}'`);
		}
	})();
}
