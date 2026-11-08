/**
 * The three background agents of the PLAN §10 acceptance run.
 *
 * Kept out of `cu-v2-acceptance.mjs` so that script stays about the window, the
 * simulator and the assertions. Every subtask is bracketed: a cursor move observed inside
 * a bracket has to line up with a logged simulator move, which is how "the agents did not
 * disturb the user's session" becomes checkable rather than asserted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";

import { nowMs, sessionDelta, sessionProbe, sleep, wireRefByRole, wireRefsByRole } from "./live-helpers.mjs";
import { rememberRunLaunch } from "./run-owned-apps.mjs";

/**
 * Build the agent helpers bound to one run's backend, helper binary and work directory.
 *
 * `brackets` is shared with the assertions: it is the only record of *when* each action
 * ran, and the cursor evidence is judged against it afterwards.
 */
export function createAgentRunner({ backend, helper, record, brackets, fixtureSource, signIdentity, workDir, ownedPids }) {
	function prepareInstance(index) {
		const directory = path.join(workDir, `Fixture-${index}.app`);
		rmSync(directory, { recursive: true, force: true });
		cpSync(fixtureSource, directory, { recursive: true });
		const plist = path.join(directory, "Contents", "Info.plist");
		execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier com.example.cu-fixture-instance${index}`, plist]);
		execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleName CUFixture${index}`, plist]);
		// Editing Info.plist invalidates the signature and this machine refuses ad-hoc
		// signed binaries, so sign the copy again.
		execFileSync("codesign", ["--force", "--deep", "--sign", signIdentity, directory], { stdio: "pipe" });
		return { index, bundleId: `com.example.cu-fixture-instance${index}`, directory };
	}

	async function findInstance(bundleId) {
		return (await backend.listApps()).find((app) => app.bundleId === bundleId);
	}

	async function launchInstance(instance) {
		const launch = await backend.manageApps({ mode: "launch", path: instance.directory, activates: true });
		const pid = rememberRunLaunch(ownedPids, launch);
		if (!pid) return undefined;
		const deadline = nowMs() + 8000;
		while (nowMs() < deadline) {
			const app = await findInstance(instance.bundleId);
			if (app?.pid === pid) return app;
			await sleep(250);
		}
		return undefined;
	}

	async function fixtureWindow(pid) {
		return (await backend.listRoots({ pid })).find((candidate) => candidate.kind === "window");
	}

	async function actWithBracket(agent, look, pid, action, options = {}) {
		const policy = action.policy ?? "ax_only";
		const before = await sessionProbe(helper, backend);
		const result = await backend.act({ lookId: look.lookId, pid, target: { ref: action.ref }, policy, ...action }, { timeoutMs: 20_000 })
			.catch((error) => ({ ok: false, outcome: "error", error: error instanceof Error ? error.message : String(error) }));
		const after = await sessionProbe(helper, backend);
		const { cursorMoved } = sessionDelta(before, after);
		brackets.push({ agent, action: action.action, moved: cursorMoved, before, after });
		const outcome = result?.outcome ?? "unknown";
		// `unknown` means the helper could not confirm delivery; when the caller checks
		// the effect itself that is not a failure.
		const judged = outcome === "worked" || outcome === "foreground_required" ? "pass" : outcome === "unknown" && options.verifiedByReadback ? "inconclusive" : "fail";
		record(`agent ${agent}`, action.action, judged, `outcome=${outcome} delivery=${result?.performed?.delivery ?? "?"}${result?.error ? ` error=${result.error}` : ""}`);
		return outcome;
	}

	async function tabStates(root) {
		const look = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
		return wireRefsByRole(look, "AXRadioButton").join(",");
	}

	/** The five fixed subtasks of PLAN §10: fill a form, switch tab, pick a row, toggle, move a slider. */
	async function runAgent(agent, pid) {
		const root = await fixtureWindow(pid);
		if (!root) return record(`agent ${agent}`, "window", "fail", "the fixture window never appeared");
		const look = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
		const controls = {
			text: wireRefByRole(look, ["AXTextField"]),
			checkbox: wireRefByRole(look, ["AXCheckBox", "AXSwitch"]),
			slider: wireRefByRole(look, ["AXSlider"]),
			row: wireRefByRole(look, ["AXRow"]),
			disclosure: wireRefByRole(look, ["AXDisclosureTriangle"]),
			tabs: wireRefsByRole(look, "AXRadioButton"),
		};
		const missing = Object.entries(controls).filter(([, ref]) => (Array.isArray(ref) ? ref.length === 0 : !ref)).map(([name]) => name);
		record(`agent ${agent}`, "outline", missing.length === 0 ? "pass" : "inconclusive", `windowId=${root.windowId} missing=${missing.join(",") || "none"}`);

		if (controls.text) await actWithBracket(agent, look, pid, { action: "setText", ref: controls.text, params: { text: `agent ${agent} text` } });
		if (controls.checkbox) await actWithBracket(agent, look, pid, { action: "setChecked", ref: controls.checkbox, params: { checked: true } });
		if (controls.slider) await actWithBracket(agent, look, pid, { action: "setValue", ref: controls.slider, params: { value: 0.4 + Number(agent.replace(/\D/g, "")) * 0.1 } });
		if (controls.row) await actWithBracket(agent, look, pid, { action: "select", ref: controls.row });

		// A SwiftUI tab has no AXPress that lands, so the click needs pid delivery. It
		// still keeps the cursor and the frontmost app untouched, which is what this
		// run measures, but pid delivery cannot confirm itself: read the tabs back.
		if (controls.tabs.length > 1) {
			const before = await tabStates(root);
			await actWithBracket(agent, look, pid, { action: "click", ref: controls.tabs[1], policy: "background" }, { verifiedByReadback: true });
			const after = await tabStates(root);
			record(`agent ${agent}`, "tab switched (readback)", after !== before ? "pass" : "fail", `${before} → ${after}`);
		}

		// Switching tabs rebuilds the tree, so the refs above are stale now.
		const refreshed = await backend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
		const disclosure = wireRefByRole(refreshed, ["AXDisclosureTriangle"]);
		if (disclosure) await actWithBracket(agent, refreshed, pid, { action: "expand", ref: disclosure });
		else record(`agent ${agent}`, "expand", "inconclusive", "no disclosure triangle after the tab switch");
	}

	return { prepareInstance, findInstance, launchInstance, fixtureWindow, actWithBracket, tabStates, runAgent };
}
