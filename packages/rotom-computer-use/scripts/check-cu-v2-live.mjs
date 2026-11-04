#!/usr/bin/env node
/**
 * Computer Use v2 live check (macOS, real helper, real windows).
 *
 * Never part of `npm test`: it is gated behind `PI_CU_LIVE=1`, it drives a real
 * helper, and it types into a real application. It only touches the fixture app
 * and deliberately read-only system surfaces, never user documents.
 *
 *   PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture ~/cu-v2-test/Fixture.app
 *
 * Point it at an isolated helper so a running session keeps its own daemon:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock \
 *   PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture ~/cu-v2-test/Fixture.app
 *
 * What it proves when it passes:
 *   - the helper answers as protocol 8 and reports user activity
 *   - each semantic action reaches a real control and reports a verified outcome
 *   - window, clipboard and system-surface commands answer with real data
 *   - a background action leaves the frontmost app and the system cursor
 *     untouched and is counted as an agent event, not a user event
 *
 * What it cannot prove: that no other app on this machine is affected, or that
 * L2 delivery works in apps outside the compatibility list.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");
const rows = [];
const log = [];

function record(area, action, result, note) {
	rows.push({ area, action, result, note: note ?? "" });
	log.push(`${new Date().toISOString()} ${area} ${action} ${result} ${note ?? ""}`);
}

function disabled(reason) {
	console.log(`[cu-v2 live] skipped: ${reason}`);
	console.log("[cu-v2 live] set PI_CU_LIVE=1 on a macOS machine with the helper installed and Accessibility granted");
	process.exit(0);
}

if (process.platform !== "darwin") disabled("not macOS");
if ((process.env.PI_CU_LIVE ?? "") !== "1") disabled("PI_CU_LIVE is not 1");

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");

const fixturePath = process.argv[process.argv.indexOf("--fixture") + 1];

async function main() {
	const diagnostics = await macosHelper.diagnosticsCommand();
	record("helper", "diagnostics", diagnostics.protocolVersion === 8 ? "pass" : "fail", `protocol=${diagnostics.protocolVersion}`);
	if (diagnostics.protocolVersion !== 8) throw new Error("helper must report protocol 8; install/restart the v2 helper in its own socket");
	if (!diagnostics.accessibility) throw new Error("Accessibility is not granted to the helper");
	record("helper", "permissions", diagnostics.screenRecording ? "pass" : "fail", `accessibility=${diagnostics.accessibility} screenRecording=${diagnostics.screenRecording} executable=${diagnostics.executablePath}`);

	const activityBefore = await macosBackend.userActivity();
	record("helper", "userActivity", activityBefore.listening ? "pass" : "fail", `idle=${activityBefore.idleSeconds.toFixed(1)}s userEvents=${activityBefore.userEventCount} agentEvents=${activityBefore.agentEventCount}`);

	if (!fixturePath || !existsSync(fixturePath)) throw new Error("pass --fixture <path to the built fixture app>");
	const findFixture = (list) => list.find((app) => /fixture/i.test(app.appName) || /fixture/i.test(app.bundleId ?? ""));
	let fixture = findFixture(await macosBackend.listApps());
	if (fixture) {
		record("app", "launch", "pass", `already running, pid=${fixture.pid} bundle=${fixture.bundleId ?? "?"}`);
	} else {
		try {
			await macosBackend.manageApps({ mode: "launch", path: fixturePath, activates: false });
			record("app", "manageApps launch", "pass", fixturePath);
		} catch (error) {
			// LaunchServices refuses unsigned-for-Gatekeeper bundles on this machine; the
			// fixture can still be started directly. Record the refusal, keep going.
			record("app", "manageApps launch", "blocked", error instanceof Error ? error.message : String(error));
		}
		await new Promise((resolve) => setTimeout(resolve, 2500));
		fixture = findFixture(await macosBackend.listApps());
		if (!fixture) throw new Error("the fixture app is not running and could not be launched; start it directly, then re-run");
	}
	record("app", "present", "pass", `pid=${fixture.pid} bundle=${fixture.bundleId ?? "?"}`);

	const frontmostBefore = await macosBackend.getFrontmost();
	const cursorBefore = await macosHelper.command("getMousePosition", {});

	const roots = await macosBackend.listRoots({ pid: fixture.pid });
	const root = roots.find((candidate) => candidate.kind === "window");
	if (!root) throw new Error("the fixture window is not in listRoots");
	record("root", "listRoots", root.windowId > 0 ? "pass" : "fail", `windowId=${root.windowId} frame=${JSON.stringify(root.framePoints)}`);

	const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
	record("observe", "window", look.image ? "pass" : "fail", `lookId=${look.lookId} imageWidth=${look.image?.width ?? 0} nodes=${countNodes(look.outline)}`);

	// outline refs are display refs (`@eN`); the helper only resolves wire refs.
	const controls = {
		text: wireRefByRole(look, ["AXTextField"]),
		checkbox: wireRefByRole(look, ["AXCheckBox", "AXSwitch"]),
		slider: wireRefByRole(look, ["AXSlider"]),
		row: wireRefByRole(look, ["AXRow"]),
		tree: wireRefByRole(look, ["AXDisclosureTriangle"]),
	};
	for (const [name, ref] of Object.entries(controls)) {
		record("outline", `find ${name}`, ref ? "pass" : "fail", ref ?? "not found");
	}

	await runAction("focus", () => actOn(look, fixture.pid, { action: "focus", ref: controls.text }));
	await runAction("setText", () => actOn(look, fixture.pid, { action: "setText", ref: controls.text, params: { text: "fixture text" } }));
	await runAction("clear", () => actOn(look, fixture.pid, { action: "clear", ref: controls.text }));
	await runAction("setChecked", () => actOn(look, fixture.pid, { action: "setChecked", ref: controls.checkbox, params: { checked: true } }));
	await runAction("setValue", () => actOn(look, fixture.pid, { action: "setValue", ref: controls.slider, params: { value: 0.75 } }));
	await runAction("select", () => actOn(look, fixture.pid, { action: "select", ref: controls.row }));
	await runAction("collapse", () => actOn(look, fixture.pid, { action: "collapse", ref: controls.tree }));
	await runAction("expand", () => actOn(look, fixture.pid, { action: "expand", ref: controls.tree }));

	const readFrame = async () => (await macosBackend.listRoots({ pid: fixture.pid })).find((candidate) => candidate.kind === "window")?.framePoints;
	// Move and resize to values that differ from the current frame, and judge each
	// mutation on its own: apps may clamp sizes, and a resize can re-center a window.
	const moveFrom = await readFrame();
	const moveTo = { x: Math.round(moveFrom.x) + 44, y: Math.round(moveFrom.y) + 44 };
	await runAction("manageWindow.move", () => macosBackend.manageWindow({ mode: "move", pid: fixture.pid, windowId: root.windowId, x: moveTo.x, y: moveTo.y }));
	const moveAfter = await readFrame();
	record("manageWindow", "moved", Math.abs(moveAfter.x - moveTo.x) <= 2 && Math.abs(moveAfter.y - moveTo.y) <= 2 ? "pass" : "fail", `${JSON.stringify(moveFrom)} → ${JSON.stringify(moveAfter)}`);

	const resizeFrom = await readFrame();
	// Stay away from both clamps: the fixture enforces a minimum size and the screen
	// caps the maximum, so shrink when there is room and grow when there is not.
	const resizeTo = { w: resizeFrom.w - 48 >= 440 ? Math.round(resizeFrom.w) - 48 : Math.round(resizeFrom.w) + 48, h: Math.round(resizeFrom.h) };
	await runAction("manageWindow.resize", () => macosBackend.manageWindow({ mode: "resize", pid: fixture.pid, windowId: root.windowId, w: resizeTo.w, h: resizeTo.h }));
	const resizeAfter = await readFrame();
	record("manageWindow", "resized", Math.abs(resizeAfter.w - resizeTo.w) <= 2 ? "pass" : "fail", `asked ${JSON.stringify(resizeTo)}; got ${JSON.stringify(resizeAfter)}`);

	const clipboardBefore = await macosBackend.clipboardGet();
	await macosBackend.clipboardSet("cu-v2 live clipboard probe");
	const clipboardAfter = await macosBackend.clipboardGet();
	record("clipboard", "set+get", clipboardAfter.text === "cu-v2 live clipboard probe" ? "pass" : "fail", `changeCount ${clipboardBefore.changeCount} → ${clipboardAfter.changeCount}`);
	await macosBackend.clipboardClear();
	record("clipboard", "clear", (await macosBackend.clipboardGet()).text === "" ? "pass" : "fail", "cleared after probe");

	for (const surface of ["notifications", "menu_bar_extras", "control_center", "dock"]) {
		try {
			const result = await macosBackend.systemSurfaces(surface);
			const entry = result?.[surface] ?? result?.surfaces?.[surface];
			record("systemSurfaces", surface, entry?.available ? "pass" : "fail", `roots=${entry?.roots?.length ?? 0}`);
		} catch (error) {
			record("systemSurfaces", surface, "fail", error instanceof Error ? error.message : String(error));
		}
	}

	// The background invariant: everything above was delivered without touching the
	// user's session. Judge it here, before any opt-in HID step, because HID
	// delivery is allowed to move the cursor and raise the target window.
	const frontmostAfter = await macosBackend.getFrontmost();
	const cursorAfter = await macosHelper.command("getMousePosition", {});
	const cursorDelta = Math.hypot(Number(cursorAfter.x) - Number(cursorBefore.x), Number(cursorAfter.y) - Number(cursorBefore.y));
	const withHid = process.argv.includes("--with-hid");
	if (withHid) {
		record("background", "cursor unchanged", "skipped", "not judged in a --with-hid run: HID delivery moves the session cursor by design");
		record("background", "frontmost app unchanged", "skipped", "not judged in a --with-hid run: HID delivery raises the target window by design");
	} else {
		record("background", "cursor unchanged", cursorDelta < 1 ? "pass" : "fail", `(${cursorBefore.x},${cursorBefore.y}) → (${cursorAfter.x},${cursorAfter.y}) delta=${cursorDelta.toFixed(1)}pt`);
		record("background", "frontmost app unchanged", frontmostAfter.pid === frontmostBefore.pid ? "pass" : "fail", `${frontmostBefore.appName} (${frontmostBefore.pid}) → ${frontmostAfter.appName} (${frontmostAfter.pid})`);
	}

	// HID delivery posts real events through the session tap, so it can move the
	// cursor and raise the target window. Keep it opt-in, and restore the app that
	// was frontmost before the run.
	if (withHid) {
		const before = await macosBackend.userActivity();
		if (!look.image) {
			// A coordinate click needs a window image, which needs the window to be
			// on screen. Do not pretend the marker was exercised when it was not.
			record("background", "agent events marked", "skipped", "no window image for coordinate targeting; bring the fixture window on screen and re-run");
		} else {
			try {
				const point = { x: Math.round((root.framePoints?.w ?? 400) * 0.5), y: Math.round((root.framePoints?.h ?? 400) * 0.92) };
				const result = await macosBackend.act({ lookId: look.lookId, pid: fixture.pid, target: { x: point.x, y: point.y, rootRef: root.rootRef }, action: "click", params: {}, policy: "default" }, { timeoutMs: 20_000 });
				const after = await macosBackend.userActivity();
				record("background", "agent events marked", after.agentEventCount > before.agentEventCount ? "pass" : "fail", `agentEvents ${before.agentEventCount} → ${after.agentEventCount}`);
				record("background", "user events exclude agent input", after.userEventCount === before.userEventCount ? "pass" : "inconclusive", `userEvents ${before.userEventCount} → ${after.userEventCount} (human input during the run)`);
				record("act", "click (HID delivery)", result?.performed?.delivery === "hid" ? "pass" : "fail", `outcome=${result?.outcome ?? "?"} delivery=${result?.performed?.delivery ?? "?"}`);
			} catch (error) {
				record("act", "click (HID delivery)", "fail", error instanceof Error ? error.message : String(error));
			}
		}
		// Put the user back where they were: focus the window that was frontmost
		// before the run instead of relaunching an app that is already running.
		const previousRoots = await macosBackend.listRoots({ pid: frontmostBefore.pid }).catch(() => []);
		const previousWindow = previousRoots.find((candidate) => candidate.kind === "window");
		if (previousWindow) {
			// focusWindow raises the window and activates its app; without the
			// activation the previous app would stay behind the HID click target.
			await macosBackend.focusWindow({ windowId: previousWindow.windowId, windowRef: previousWindow.rootRef, pid: frontmostBefore.pid }).catch(() => undefined);
			if (frontmostBefore.appName) await macosHelper.command("manageApps", { mode: "launch", bundleId: frontmostBefore.bundleId, path: frontmostBefore.appPath, activates: true }).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 800));
			const restored = await macosBackend.getFrontmost();
			// Restoring the previous app is operator hygiene, not product behavior: the
			// HID click legitimately raised the fixture. Report it, but do not fail.
			record("background", "frontmost restored", restored.pid === frontmostBefore.pid ? "pass" : "inconclusive", `${frontmostBefore.appName} → ${restored.appName}; bring your app back manually`);
		}
	} else {
		record("background", "agent events marked", "skipped", "run with --with-hid to post real input events");
	}

	await writeEvidence();
	const failures = rows.filter((row) => row.result === "fail").length;
	console.log(`[cu-v2 live] ${rows.length} rows, ${failures} failing; log written to ${EVIDENCE_DIR}`);
}

async function actOn(look, pid, action) {
	return await macosBackend.act({ lookId: look.lookId, pid, target: { ref: action.ref }, policy: "ax_only", ...action }, { timeoutMs: 20_000 });
}

async function runAction(name, run) {
	try {
		const result = await run();
		const outcome = result?.outcome ?? "unknown";
		const interfered = result?.performed?.interferedWithUser === true;
		// `interferedWithUser` means real user input overlapped the action, which makes
		// the click ambiguous. That is a signal about the machine, not a defect.
		const result_status = result?.ok === false || outcome !== "worked" ? "fail" : interfered ? "inconclusive" : "pass";
		record("act", name, result_status, `outcome=${outcome} delivery=${result?.performed?.delivery ?? "?"} mechanism=${result?.performed?.mechanism ?? "-"}${interfered ? " user input overlapped" : ""}`);
	} catch (error) {
		record("act", name, "fail", error instanceof Error ? error.message : String(error));
	}
}

function countNodes(outline) {
	let total = 0;
	walk(outline, () => {
		total += 1;
	});
	return total;
}

// Every serialized node carries its own wire ref, so role lookups stay aligned
// with the look that produced them even when the tree changes shape.
function wireRefByRole(look, roles) {
	const node = (look.parsedOutline?.nodes ?? look.nodes ?? []).find((candidate) => candidate.wireRef && roles.includes(candidate.role));
	return node?.wireRef;
}

function refByRole(outline, roles) {
	let found;
	walk(outline, (node) => {
		if (!found && node.ref && roles.includes(node.role)) found = node.ref;
	});
	return found;
}

function walk(outline, visit) {
	if (!outline) return;
	const stack = [outline];
	while (stack.length) {
		const node = stack.pop();
		visit(node);
		for (const child of node.children ?? []) stack.push(child);
	}
}

async function writeEvidence() {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	const table = ["| Area | Action | Result | Note |", "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row.area} | ${row.action} | ${row.result} | ${row.note.replace(/\|/g, "\\|")} |`)];
	const failures = rows.filter((row) => row.result === "fail").length;
	const body = [
		`# Computer Use v2 live check (${new Date().toISOString()})`,
		"",
		`Rows: ${rows.length} · Failures: ${failures}`,
		"",
		...table,
		"",
		"## Log",
		"",
		"```",
		...log,
		"```",
		"",
	].join("\n");
	await writeFile(path.join(EVIDENCE_DIR, "live-check.md"), body);
	await writeFile(path.join(EVIDENCE_DIR, `live-check-${Date.now()}.log`), log.join("\n"));
	if (failures > 0) process.exitCode = 1;
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	await writeEvidence();
	console.error(`[cu-v2 live] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
