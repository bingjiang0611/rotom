/**
 * The two real-machine modes that are not part of the ordinary ladder (A8).
 *
 * Kept out of `cu-v2-l2-check.mjs` so the harness stays readable: both need the
 * script's recorder and lookups passed in, and both are only ever pointed at a
 * fixture copy this run started.
 */
/**
 * Decide a click from the transport and from the app's own click counter.
 *
 * The first real run (2026-11-06 22:40) returned `delivery=l2` with `outcome=unknown`:
 * the targeted post reached the app, but the helper could not confirm the effect. The
 * B-phase contract makes an unread effect a blocker, so the transport alone is not a
 * pass.
 *
 * The first readback compared two booleans, and that was unusable (review 7, R1): the
 * script clicks the same button through the AX path first, so by the time the directed
 * click runs the fixture already reports `clicked` and a second click cannot show up.
 * The fixture now publishes `clicks: N`, and the judgement is `after == before + 1`:
 * unchanged means the click did not land, and a jump of two means something else
 * clicked while we were watching.
 */
/** @param {{survived: boolean, delivery: string, outcome: string, before?: number, after?: number, activated?: boolean, expectedDelivery?: string}} options */
export function judgeDirectedClick({ survived, delivery, outcome, before, after, activated = false, expectedDelivery = "l2" }) {
	if (!survived) return { result: "fail", reason: "helper did not survive the directed post" };
	if (delivery !== expectedDelivery) return { result: "fail", reason: `expected delivery=${expectedDelivery}, got ${delivery}` };
	if (typeof before === "number" && typeof after === "number") {
		if (after === before + 1) return { result: "pass", reason: `readback ${before}->${after}` };
		if (after === before) {
			// AppKit spends the first click on an inactive window activating it, so "the counter
			// did not move" and "the post never arrived" are different answers and only the
			// activation readback tells them apart (the second B0 window could not).
			return activated
				? { result: "inconclusive", reason: `readback unchanged at ${before}, but the click activated the fixture window (outcome=${outcome})` }
				: { result: "fail", reason: `readback unchanged at ${before} (outcome=${outcome})` };
		}
		return { result: "unknown", reason: `readback ${before}->${after} is not exactly one click (outcome=${outcome})` };
	}
	return { result: "inconclusive", reason: `no click counter to read (outcome=${outcome})` };
}

/** The fixture writes `clicks: N`; this is the only parsing rule needed. */
export function parseClickCount(text) {
	const match = /clicks:\s*(\d+)/.exec(String(text ?? ""));
	return match ? Number(match[1]) : undefined;
}

/**
 * The fixture's click counter as the app itself reports it.
 *
 * A static text may carry its content in `value`, `label` or `title` depending on the
 * app, so all of them are searched instead of guessing one.
 */
export function fixtureNodeCount(node) {
	if (!node) return undefined;
	for (const field of [node.value, node.label, node.title, node.description]) {
		const count = parseClickCount(field);
		if (count !== undefined) return count;
	}
	return undefined;
}

export async function fixtureControlCount(backend, target, identifier) {
	const look = await backend.observe({ target, readText: "auto", includeImage: false });
	const node = (look.parsedOutline?.nodes ?? look.nodes ?? []).find((candidate) => candidate.identifier === identifier);
	return fixtureNodeCount(node);
}

export async function fixtureClickCount(backend, target) {
	return fixtureControlCount(backend, target, "cu-fixture-button-result");
}

/**
 * W3: compare the two native process-targeted transports against a SwiftUI button
 * and an AppKit button whose first click is accepted while the window is inactive.
 * The fixture never activates, so every cell can report the fixture's own counter
 * without moving the operator back to an earlier App.
 */
export async function runDeliveryMatrix({ fixture, fixtureRun, backend, helper, record, alive }) {
	if (!fixture) {
		record("delivery matrix", "fixture", "skipped", "no fixture this run started; nothing to address directly");
		return;
	}
	const roots = await backend.listRoots({ pid: fixture.pid });
	const root = roots.find((candidate) => candidate.kind === "window");
	if (!root) {
		record("delivery matrix", "window", "skipped", "the fixture has no window; the matrix needs one");
		return;
	}
	const { buildDirectTransportRequest } = await import("./l2-direct.mjs");
	const target = { windowId: root.windowId, rootRef: root.rootRef };
	const buttons = [
		{ label: "SwiftUI", identifier: "cu-fixture-button" },
		{ label: "acceptsFirstMouse", identifier: "cu-fixture-first-mouse-button" },
	];

	for (const delivery of ["l2", "pid"]) {
		for (const button of buttons) {
			const look = await backend.observe({ target, readText: "auto", includeImage: false });
			const node = (look.parsedOutline?.nodes ?? look.nodes ?? []).find((candidate) => candidate.identifier === button.identifier);
			if (!node?.wireRef) {
				record("delivery matrix", `${delivery} / ${button.label}`, "skipped", `no ${button.identifier} target in the fixture window`);
				continue;
			}
			const before = fixtureNodeCount(node);
			const frontBefore = await backend.getFrontmost().catch(() => undefined);
			const request = buildDirectTransportRequest({ lookId: look.lookId, pid: fixture.pid, ref: node.wireRef, action: "click", delivery });
			let outcome = "unknown";
			let actualDelivery = "?";
			let failure = "";
			try {
				const result = await helper.command("act", request, { timeoutMs: 20_000 });
				outcome = result?.outcome ?? "unknown";
				actualDelivery = result?.performed?.delivery ?? "?";
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			const survived = await alive();
			const after = await fixtureControlCount(backend, target, button.identifier).catch(() => undefined);
			const frontAfter = await backend.getFrontmost().catch(() => undefined);
			const activated = frontBefore?.pid !== fixture.pid && frontAfter?.pid === fixture.pid;
			const judged = judgeDirectedClick({ survived, delivery: actualDelivery, outcome, before, after, activated, expectedDelivery: delivery });
			record(
				"delivery matrix",
				`${delivery} / ${button.label}`,
				judged.result,
				`button=${button.identifier} before=${before ?? "?"} after=${after ?? "?"} outcome=${outcome} delivery=${actualDelivery} requireTransport=true helperAlive=${survived} targetActiveBefore=${frontBefore?.pid === fixture.pid} targetActiveAfter=${frontAfter?.pid === fixture.pid} judgedBy=${judged.reason} bundle=${fixtureRun?.bundleId ?? fixture.bundleId}${failure ? ` error=${failure}` : ""}`,
			);
		}
	}
}

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
		// Read the app's own click counter before the post, so "did anything happen" is
		// answered by the app rather than by the helper's self-report.
		const target = { windowId: root.windowId, rootRef: root.rootRef };
		const effectBefore = action === "click" ? await fixtureClickCount(backend, target).catch(() => undefined) : undefined;
		// Whether the fixture already holds activation decides what a first click can do, so it
		// is read before the post and reported as a fact rather than judged as a failure.
		const frontBefore = action === "click" ? await backend.getFrontmost().catch(() => undefined) : undefined;
		const targetActive = frontBefore?.pid === fixture.pid;
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
		const effectAfter = action === "click" ? await fixtureClickCount(backend, target).catch(() => undefined) : undefined;
		const frontAfter = action === "click" ? await backend.getFrontmost().catch(() => undefined) : undefined;
		const activated = Boolean(action === "click" && !targetActive && frontAfter?.pid === fixture.pid);
		const judged = action === "click"
			? judgeDirectedClick({ survived, delivery, outcome, before: effectBefore, after: effectAfter, activated })
			: { result: !survived ? "fail" : outcome === "worked" ? "pass" : "inconclusive", reason: outcome };
		record(
			"direct L2",
			label,
			judged.result,
			`outcome=${outcome} delivery=${delivery} helperAlive=${survived} cursorMoved=${moved} judgedBy=${judged.reason} bundle=${fixtureRun?.bundleId ?? fixture.bundleId}${failure ? ` error=${failure}` : ""}`,
		);
		if (action === "click") {
			record(
				"direct L2",
				"target active",
				"recorded",
				targetActive
					? "the fixture was already the frontmost app before the post"
					: `frontmost=${frontBefore?.appName ?? "?"} pid=${frontBefore?.pid ?? "?"}; a first click on an inactive window activates it instead of pressing the control`,
			);
			if (activated) record("direct L2", "activation", "pass", `the directed post activated the fixture window (frontmost ${frontBefore?.appName ?? "?"} → ${frontAfter?.appName ?? "?"})`);
			// A second row, because the transport and the effect are different questions
			// (the same split B6 needed). Only the first row is required by the contract.
			const readable = typeof effectBefore === "number" && typeof effectAfter === "number";
			record(
				"direct L2",
				"click effect",
				!readable ? "skipped" : effectAfter === effectBefore + 1 ? "pass" : effectAfter !== effectBefore ? "unknown" : activated ? "inconclusive" : "fail",
				`before=clicks:${effectBefore ?? "?"} after=clicks:${effectAfter ?? "?"} outcome=${outcome}`,
			);
		}
		if (!survived) {
			record("direct L2", "helper crashed", "fail", "the private signature took the helper down; recorded as the result of this mode");
			break;
		}
	}
}
