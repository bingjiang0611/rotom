/**
 * The one retry a background action is allowed to make.
 *
 * Some apps are on the L2 compatibility list, so a background action asks for the
 * window-targeted transport. That transport is resolved from a private symbol before
 * any event is posted: when the symbol is missing nothing was delivered, and the action
 * may be repeated over pid-targeted posting. Any other failure propagates unchanged -
 * in particular this must never turn into a foreground attempt, which would move the
 * user's cursor (review G4).
 */
import type { NativeInputDelivery } from "../platform/types.ts";

export interface DeliveryFallbackOptions<Request, Result> {
	/** Build the request; the argument overrides the transport the policy picked. */
	request: (deliveryOverride?: NativeInputDelivery) => Request;
	act: (request: Request) => Promise<Result>;
	/** Retrying is refused when the caller is headless or the policy is already foreground. */
	mayFallBack: boolean;
}

export interface DeliveryFallbackResult<Result> {
	result: Result;
	/** Set when the request was answered over pid-targeted posting instead. */
	pidFallback?: "l2_unavailable";
}

export async function attemptWithDeliveryFallback<Request, Result>(
	options: DeliveryFallbackOptions<Request, Result>,
): Promise<DeliveryFallbackResult<Result>> {
	try {
		return { result: await options.act(options.request()) };
	} catch (error) {
		const code = (error as Error & { code?: string })?.code;
		if (!options.mayFallBack || code !== "l2_unavailable") throw error;
		return { result: await options.act(options.request("pid")), pidFallback: "l2_unavailable" };
	}
}
