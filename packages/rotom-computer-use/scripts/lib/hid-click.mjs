import { requireQuietGlobalInput } from "./global-input-gate.mjs";

/**
 * The opt-in HID step (B6), kept out of the live check so the check stays readable.
 *
 * Two questions, two rows (review 6 P4): "did the input go through HID" comes from the
 * delivery field, and "did the click take effect" comes from the fixture itself - the
 * button publishes its pressed state through `AXValue`, so the effect is read back
 * instead of borrowed. The previous single row let an `unknown` outcome ride a `pass`
 * on the transport, which is how B6 "passed" while nobody knew whether the click did
 * anything.
 *
 * Nothing here is retried: a failed readback is a result.
 */
export function nodeByIdentifier(observed, identifier) {
	return (observed.parsedOutline?.nodes ?? observed.nodes ?? []).find((node) => node.identifier === identifier);
}

export async function readIdentifier(backend, target, identifier) {
	const observed = await backend.observe({ target, readText: "auto", includeImage: false });
	return nodeByIdentifier(observed, identifier);
}

/**
 * Click the fixture's own button through the foreground policy and judge it twice.
 *
 * `look` must be the observation the ref came from; a stale ref is the helper's
 * business, not something to guess around. Immediately before the global action,
 * the helper must prove that it observed no unmarked input for 30 seconds.
 */
export async function runHidClick({ backend, helper, look, root, fixture, record }) {
	const button = nodeByIdentifier(look, "cu-fixture-button");
	if (!button?.wireRef) {
		record("act", "click went through HID", "fail", "the fixture button carrying cu-fixture-button is not in the outline; not clicking blind");
		record("act", "click took effect", "skipped", "nothing was clicked");
		return { delivery: undefined, outcome: undefined, pressed: undefined, stopped: true };
	}
	const quiet = await requireQuietGlobalInput({ helper, record });
	if (!quiet.allowed) {
		record("act", "click went through HID", "skipped", "global input quiet gate did not pass; no HID action was sent");
		record("act", "click took effect", "skipped", "nothing was clicked");
		return { delivery: undefined, outcome: undefined, pressed: undefined, stopped: true };
	}
	const before = await backend.userActivity();
	let delivery = "?";
	let outcome = "?";
	try {
		const result = await backend.act({ lookId: look.lookId, pid: fixture.pid, target: { ref: button.wireRef }, action: "click", params: {}, policy: "foreground" }, { timeoutMs: 20_000 });
		delivery = result?.performed?.delivery ?? "?";
		outcome = result?.outcome ?? "unknown";
		const after = await backend.userActivity();
		record("background", "agent events marked", after.agentEventCount > before.agentEventCount ? "pass" : "fail", `agentEvents ${before.agentEventCount} → ${after.agentEventCount}`);
		record("background", "user events exclude agent input", after.userEventCount === before.userEventCount ? "pass" : "inconclusive", `userEvents ${before.userEventCount} → ${after.userEventCount} (human input during the run)`);
		record("act", "click went through HID", delivery === "hid" ? "pass" : "fail", `delivery=${delivery} outcome=${outcome}`);
	} catch (error) {
		record("act", "click went through HID", "fail", error instanceof Error ? error.message : String(error));
	}
	const target = { windowId: root.windowId, rootRef: root.rootRef };
	const pressed = (await readIdentifier(backend, target, "cu-fixture-button"))?.value;
	const sibling = (await readIdentifier(backend, target, "cu-fixture-button-result"))?.value;
	// The effect is what the app reports: `clicked` is the button's own pressed state.
	// An `idle` value or a `didnt` outcome means the click did nothing; anything else is
	// honestly `unknown`.
	record(
		"act",
		"click took effect",
		pressed === "clicked" ? "pass" : outcome === "didnt" || pressed === "idle" ? "fail" : "unknown",
		`value=${pressed ?? "absent"} outcome=${outcome} result=${sibling ?? "absent"}`,
	);
	return { delivery, outcome, pressed, stopped: false };
}
