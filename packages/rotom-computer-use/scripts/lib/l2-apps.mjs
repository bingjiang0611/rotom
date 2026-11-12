import { wireRefByRole } from "./live-helpers.mjs";

/**
 * The positive path: apps the operator put on the L2 list, and only those this run started.
 *
 * A directed text input needs a text element and a directed click needs a button; a window
 * without one gets a `skipped` row rather than a blind click into a user's app.
 */
export async function driveListedApps({ backend, apps, probe, typed, record }) {
	for (const app of apps) {
		const name = app.appName ?? app.bundleId;
		const roots = await backend.listRoots({ pid: app.pid });
		const root = roots.find((candidate) => candidate.kind === "window");
		if (!root) {
			record(name, "window", "fail", "no window in listRoots");
			continue;
		}
		const look = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
		const text = wireRefByRole(look, ["AXTextField", "AXTextArea"]);
		if (text) await probe(name, look, app.pid, { action: "typeText", ref: text, params: { text: typed } }, {});
		else record(name, "typeText", "skipped", "no text input element in the window; not typing blind into a user app");
		const button = wireRefByRole(look, ["AXButton"]);
		if (button) await probe(name, look, app.pid, { action: "click", ref: button }, {});
		else record(name, "click", "skipped", "no button in the window");
	}
}
