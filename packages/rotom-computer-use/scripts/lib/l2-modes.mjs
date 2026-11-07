/**
 * The two real-machine modes that are not part of the ordinary ladder (A8).
 *
 * Kept out of `cu-v2-l2-check.mjs` so the harness stays readable: both need the
 * script's recorder and lookups passed in, and both are only ever pointed at a
 * fixture copy this run started.
 */
import { restoreOperatorApp } from "./live-helpers.mjs";

/**
 * F5: the first real run of the directed-delivery signature.
 *
 * The whitelist is deliberately not involved: the request asks the helper for L2 on
 * this run's own fixture copy. A helper crash is recorded as the result, and the
 * next observation says whether anything moved.
 */
export async function runDirectL2({ fixture, fixtureRun, backend, helper, record, cursor, alive, wireRefByRole, typed, asciiInput = false }) {
	if (!fixture) {
		record("direct L2", "fixture", "skipped", "no fixture this run started; nothing to address directly");
		return;
	}
	const roots = await backend.listRoots({ pid: fixture.pid });
	const root = roots.find((candidate) => candidate.kind === "window");
	if (!root) {
		record("direct L2", "window", "skipped", "the fixture has no window; direct delivery needs one");
		return;
	}
	const { buildDirectL2Request } = await import("./l2-direct.mjs");
	// Fixture content controls carry identifiers. Without this filter the first
	// AXButton in the tree is the window's close button: pressing it closes the very
	// window the text probe needs, which is what happened on 2026-11-06.
	const pick = (look, role) => {
		const nodes = look.parsedOutline?.nodes ?? [];
		return nodes.find((node) => node.wireRef && node.role === role && typeof node.identifier === "string" && node.identifier.startsWith("cu-fixture"))?.wireRef
			?? wireRefByRole(look, [role]);
	};
	for (const [label, action, role, params] of [
		["click", "click", "AXButton", {}],
		["typeText", "typeText", "AXTextField", { text: typed }],
	]) {
		// Each action gets its own observation: the previous one may have changed the
		// tree, and a stale ref is refused rather than retried.
		const look = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
		// The text step exists to prove the transport, but a pinned transport means key
		// events, and an input method rewrites those ("l2probe" -> "里probe"). Skip the
		// text line rather than record a failure that says nothing about the product; the
		// click line still exercises the same delivery (review G5).
		if (role === "AXTextField" && !asciiInput) {
			record("direct L2", label, "skipped", "input method selected: pinned transport uses key events, so ASCII text would be rewritten");
			continue;
		}
		const ref = pick(look, role);
		if (!ref) {
			record("direct L2", label, "skipped", `no ${role} target in the fixture window`);
			continue;
		}
		const request = buildDirectL2Request({ lookId: look.lookId, pid: fixture.pid, ref, action, params });
		const cursorBefore = await cursor();
		let outcome = "unknown";
		let delivery = "?";
		let failure = "";
		try {
			const result = await helper.command("act", request, { timeoutMs: 20_000 });
			outcome = result?.outcome ?? "unknown";
			delivery = result?.performed?.delivery ?? "?";
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		const cursorAfter = await cursor();
		const moved = Math.hypot(cursorAfter.x - cursorBefore.x, cursorAfter.y - cursorBefore.y) >= 1;
		const survived = await alive();
		record(
			"direct L2",
			label,
			!survived ? "fail" : outcome === "worked" ? "pass" : "inconclusive",
			`outcome=${outcome} delivery=${delivery} helperAlive=${survived} cursorMoved=${moved} bundle=${fixtureRun?.bundleId ?? fixture.bundleId}${failure ? ` error=${failure}` : ""}`,
		);
		if (!survived) {
			record("direct L2", "helper crashed", "fail", "the private signature took the helper down; recorded as the result of this mode");
			break;
		}
	}
}

/**
 * HID path, run separately from the background invariant checks.
 *
 * One action is delivered through the foreground policy, which is the only path that
 * moves the real cursor. The operator's app must be in front again afterwards, and
 * that is read back rather than assumed (review 6, P2): B6 exists to catch exactly the
 * case where the run leaves the fixture in front.
 */
export async function runWithHid({ fixture, originalFrontmost, backend, record, cursor, wireRefByRole }) {
	if (!fixture) {
		record("with-hid", "fixture", "skipped", "no fixture this run started");
		return { restore: { restored: false, result: "skipped" } };
	}
	const root = await ensureRoot(backend, fixture);
	if (!root) {
		record("with-hid", "window", "skipped", "the fixture has no window");
		return { restore: { restored: false, result: "skipped" } };
	}
	const look = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
	const button = wireRefByRole(look, ["AXButton"]);
	if (!button) {
		record("with-hid", "click", "skipped", "no button in the fixture window; not clicking blind");
		return { restore: { restored: false, result: "skipped" } };
	}
	const before = await cursor();
	let outcome = "unknown";
	let delivery = "?";
	try {
		const result = await backend.act({ lookId: look.lookId, pid: fixture.pid, target: { ref: button }, action: "click", policy: "foreground" }, { timeoutMs: 20_000 });
		outcome = result?.outcome ?? "unknown";
		delivery = result?.performed?.delivery ?? "?";
	} catch (error) {
		outcome = `error:${error instanceof Error ? error.message : String(error)}`;
	}
	const after = await cursor();
	const moved = Math.hypot(after.x - before.x, after.y - before.y) >= 1;
	// Two questions, two rows (review 6, P4). "Did the input go through HID" is proven by
	// the delivery field; "did the click take effect" is what the outcome says, and an
	// `unknown` outcome must not borrow the delivery's pass.
	record("with-hid", "click went through HID", delivery === "hid" ? "pass" : "fail", `delivery=${delivery} outcome=${outcome} cursorMoved=${moved}`);
	record("with-hid", "click took effect", outcome === "worked" ? "pass" : outcome === "didnt" ? "fail" : "unknown", `outcome=${outcome}`);
	const restore = await restoreOperatorApp({ backend, original: originalFrontmost, record });
	return { restore };
}

async function ensureRoot(backend, fixture) {
	const roots = await backend.listRoots({ pid: fixture.pid });
	return roots.find((candidate) => candidate.kind === "window");
}
