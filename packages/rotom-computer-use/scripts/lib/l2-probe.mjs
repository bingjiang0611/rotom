/**
 * The per-action probe the L2 check repeats, kept out of the script so the script reads
 * as the run's order of events.
 *
 * One action is performed with `background` policy - the L2 delivery path - and both sides
 * of it are sampled (cursor, frontmost app) so an effect is attributable to the agent
 * rather than to whoever else was at the machine.
 */
export const wireRefByRole = (look, roles) =>
	(look.parsedOutline?.nodes ?? []).find((node) => node.wireRef && roles.includes(node.role))?.wireRef;

/** Fixture content controls carry identifiers; window chrome does not. */
export const fixtureRef = (look, roles) => {
	const nodes = look.parsedOutline?.nodes ?? [];
	return nodes.find((node) => node.wireRef && roles.includes(node.role) && typeof node.identifier === "string" && node.identifier.startsWith("cu-fixture"))?.wireRef;
};

export function createProbe({ backend, record, cursor }) {
	return async function probe(agent, look, pid, action) {
		const before = { cursor: await cursor(), frontmost: await backend.getFrontmost() };
		const started = Date.now();
		let result;
		let error;
		try {
			result = await backend.act({ lookId: look.lookId, pid, policy: "background", target: { ref: action.ref }, ...action }, { timeoutMs: 20_000 });
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const after = { cursor: await cursor(), frontmost: await backend.getFrontmost() };
		const cursorMoved = Math.hypot(after.cursor.x - before.cursor.x, after.cursor.y - before.cursor.y) >= 1;
		const frontmostChanged = after.frontmost.pid !== before.frontmost.pid;
		const outcome = result?.outcome ?? (error ? "error" : "unknown");
		const delivery = result?.performed?.delivery ?? (error ? "none" : "?");
		record(agent, action.action, outcome === "worked" ? "pass" : outcome === "foreground_required" ? "pass" : "inconclusive", `outcome=${outcome} delivery=${delivery} cursorMoved=${cursorMoved} frontmostChanged=${frontmostChanged} ${Date.now() - started}ms${error ? ` error=${error}` : ""}`);
		return { outcome, delivery, cursorMoved, frontmostChanged, look };
	};
}
