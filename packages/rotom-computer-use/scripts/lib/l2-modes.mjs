/**
 * The two real-machine modes that are not part of the ordinary ladder (A8).
 *
 * Kept out of `cu-v2-l2-check.mjs` so the harness stays readable: both need the
 * script's recorder and lookups passed in, and both are only ever pointed at a
 * fixture copy this run started.
 */
/**
 * Decide the directed click from the transport and from what the app reports.
 *
 * The first real run (2026-11-06 22:40) returned `delivery=l2` with `outcome=unknown`:
 * the targeted post reached the app, but the helper could not confirm the effect. The
 * B-phase contract makes an unread effect a blocker, so the transport alone is not a
 * pass - the click also has to show up in the fixture's own result text. Keeping the
 * decision in one pure function is what lets a test drive the three cases.
 */
export function judgeDirectedClick({ survived, delivery, outcome, before, after }) {
	if (!survived) return { result: "fail", reason: "helper did not survive the directed post" };
	if (delivery !== "l2") return { result: "fail", reason: `expected delivery=l2, got ${delivery}` };
	if (outcome === "worked") return { result: "pass", reason: "outcome" };
	if (before !== undefined && after !== undefined && before !== after) return { result: "pass", reason: "readback" };
	if (outcome === "didnt") return { result: "inconclusive", reason: "didnt and no readback change" };
	return { result: "inconclusive", reason: "unknown and no readback change" };
}

/**
 * A comparable snapshot of the fixture's result line.
 *
 * A static text may carry its content in `value`, `label` or `title` depending on the
 * app, so the signature keeps all of them instead of guessing one.
 */
export async function fixtureResultSignature(backend, target) {
	const look = await backend.observe({ target, readText: "auto", includeImage: false });
	const node = (look.parsedOutline?.nodes ?? look.nodes ?? []).find((candidate) => candidate.identifier === "cu-fixture-button-result");
	if (!node) return undefined;
	return JSON.stringify({ value: node.value ?? null, label: node.label ?? null, title: node.title ?? null, description: node.description ?? null });
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
		// Read the app's own result line before the post, so "did anything happen" is
		// answered by the app rather than by the helper's self-report.
		const target = { windowId: root.windowId, rootRef: root.rootRef };
		const effectBefore = action === "click" ? await fixtureResultSignature(backend, target).catch(() => undefined) : undefined;
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
		const effectAfter = action === "click" ? await fixtureResultSignature(backend, target).catch(() => undefined) : undefined;
		const judged = action === "click"
			? judgeDirectedClick({ survived, delivery, outcome, before: effectBefore, after: effectAfter })
			: { result: !survived ? "fail" : outcome === "worked" ? "pass" : "inconclusive", reason: outcome };
		record(
			"direct L2",
			label,
			judged.result,
			`outcome=${outcome} delivery=${delivery} helperAlive=${survived} cursorMoved=${moved} judgedBy=${judged.reason} bundle=${fixtureRun?.bundleId ?? fixture.bundleId}${failure ? ` error=${failure}` : ""}`,
		);
		if (action === "click") {
			// A second row, because the transport and the effect are different questions
			// (the same split B6 needed). Only the first row is required by the contract.
			record(
				"direct L2",
				"click effect",
				effectBefore === undefined || effectAfter === undefined ? "skipped" : effectBefore === effectAfter ? "fail" : "pass",
				`before=${effectBefore ?? "absent"} after=${effectAfter ?? "absent"} outcome=${outcome}`,
			);
		}
		if (!survived) {
			record("direct L2", "helper crashed", "fail", "the private signature took the helper down; recorded as the result of this mode");
			break;
		}
	}
}
