import { fixtureClickCount } from "./l2-modes.mjs";
import { wireRefByRole } from "./l2-probe.mjs";

/** Exercise the ordinary AX-backed fixture path before a direct-delivery probe. */
export async function runFixtureBaseline({ backend, fixture, root, look, controls, probe, record, typed }) {
	if (controls.button) {
		// Review 7 R1: the same counter judges both clicks, so this row is no longer
		// stuck at `inconclusive` while the app really did change.
		const target = { windowId: root.windowId, rootRef: root.rootRef };
		const countBefore = await fixtureClickCount(backend, target).catch(() => undefined);
		await probe("fixture (not on the L2 list)", look, fixture.pid, { action: "click", ref: controls.button }, controls);
		const countAfter = await fixtureClickCount(backend, target).catch(() => undefined);
		const readable = typeof countBefore === "number" && typeof countAfter === "number";
		record("fixture (not on the L2 list)", "click effect", !readable ? "skipped" : countAfter === countBefore + 1 ? "pass" : countAfter === countBefore ? "fail" : "unknown", `before=clicks:${countBefore ?? "?"} after=clicks:${countAfter ?? "?"}`);
	}
	if (!controls.text) return;

	// The successful click above changed the tree, so its refs are stale: observe
	// again before clearing and typing into the field.
	const target = { windowId: root.windowId, rootRef: root.rootRef };
	const fresh = await backend.observe({ target, readText: "auto", includeImage: false });
	const textRef = wireRefByRole(fresh, ["AXTextField"]);
	if (!textRef) {
		record("fixture (not on the L2 list)", "typeText", "skipped", "the text field disappeared after the click");
		return;
	}
	await backend.act({ lookId: fresh.lookId, pid: fixture.pid, target: { ref: textRef }, action: "clear", policy: "ax_only" }, { timeoutMs: 20_000 }).catch(() => undefined);
	const result = await probe("fixture (not on the L2 list)", fresh, fixture.pid, { action: "typeText", ref: textRef, params: { text: typed } });
	const after = await backend.observe({ target, readText: "auto", includeImage: false });
	const received = String((after.parsedOutline?.nodes ?? []).find((node) => node.role === "AXTextField")?.value ?? "");
	record("fixture (not on the L2 list)", "input received", received === typed ? "pass" : result.outcome === "worked" ? "fail" : "pass", `field="${received}" expected="${typed}" outcome=${result.outcome}`);
}
