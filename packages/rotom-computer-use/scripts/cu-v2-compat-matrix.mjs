#!/usr/bin/env node
/**
 * Compatibility matrix runner for Computer Use v2.
 *
 * The matrix answers one question per cell: with this delivery level, does this
 * app accept this action without touching the user's foreground? It only reports
 * what it observed; an action that returns `didnt` or `unknown` stays a failure
 * cell, and a cell that was never run stays `not-run` — the matrix never infers
 * success from a neighbouring app.
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-compat-matrix.mjs --apps com.apple.TextEdit,/tmp/cu-fixture
 *
 * Output: docs/agent/computer-use-v2/evidence/compat-matrix.md
 *
 * Apps: only the fixture and apps where read-only actions are safe (TextEdit with
 * an empty document, Finder windows). Never drives user documents.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { ensureFixtureWindow } from "./lib/fixture.mjs";
import { GateHold, requireGate } from "./lib/gate.mjs";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");
const ACTIONS = ["observe", "focus", "setText", "typeText", "press", "setChecked", "expand", "scrollTo", "select", "setValue"];
// `argument()` is declared below and hoisted. Indexing `process.argv` directly made an
// absent `--delivery` resolve to `process.argv[0]` (the node path), so the first B2 run
// labelled every cell with a policy that does not exist and ran one policy, not three.
const requestedDelivery = argument("--delivery");
// `foreground` raises the target window and posts HID input; leave it out on a
// machine someone is using and say so instead of quietly skipping it.
const DELIVERY = (requestedDelivery ? requestedDelivery.split(",").map((value) => value.trim()).filter(Boolean) : ["ax_only", "background", "foreground"]);

if (process.platform !== "darwin" || (process.env.PI_CU_LIVE ?? "") !== "1") {
	console.log("[cu-v2 matrix] not run: needs macOS and PI_CU_LIVE=1 with a real helper");
	process.exit(0);
}

/**
 * The gate runs here too (review G6): this matrix is the only script that deliberately
 * uses the `foreground` policy, so it must not start without an authorized window.
 */
function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

try {
	await requireGate({
		windowStart: argument("--window-start"),
		windowMinutes: argument("--window-minutes"),
		requireIdleMinutes: argument("--require-idle-minutes") ?? "10",
		listeningSince: argument("--listening-since"),
	});
} catch (error) {
	console.error(`[cu-v2 matrix] gate: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(error instanceof GateHold ? 1 : 2);
}

const apps = (argument("--apps", "") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (apps.length === 0) {
	console.error("[cu-v2 matrix] pass --apps with bundle ids or app paths");
	process.exit(2);
}

const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { disposeFixtureRun, prepareFixtureRun } = await import("./lib/fixture.mjs");
const { homedir } = await import("node:os");
const { runStamp } = await import("./lib/live-helpers.mjs");

const rows = [];

/**
 * A path argument may be a plain .app or a fixture the operator built. Each run gets
 * a fresh copy with its own bundle id, so LaunchServices cannot attach the matrix to
 * a copy that is already running (-10825) and the operator's instance is never the
 * target. `--no-fixture-copy` keeps the old behavior for a path that is already
 * unique per run.
 */
const copyFixtures = !process.argv.includes("--no-fixture-copy");
const runRoot = path.join(homedir(), "cu-v2-test", "runs", runStamp());
const prepared = [];
function targetFor(app) {
	if (!copyFixtures || !app.startsWith("/")) return app;
	const handle = prepareFixtureRun({ sourceApp: app, runRoot });
	prepared.push(handle);
	rows.push({ app, action: "fixture copy", delivery: "-", result: "prepared", note: `${handle.bundleId} at ${handle.bundlePath}` });
	return handle.bundlePath;
}

for (const requested of apps) {
	const app = targetFor(requested);
	await macosBackend.manageApps({ mode: "launch", bundleId: app.includes(".") && !app.startsWith("/") ? app : undefined, path: app.startsWith("/") ? app : undefined, activates: false }).catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const preparedHandle = prepared.find((handle) => handle.bundlePath === app);
	const installed = (await macosBackend.listApps()).find((candidate) => preparedHandle
		? candidate.bundleId === preparedHandle.bundleId
		: candidate.bundleId === app || app.startsWith("/") && candidate.appName.toLowerCase().includes(path.basename(app).toLowerCase()));
	if (!installed) {
		for (const action of ACTIONS) rows.push({ app, action, delivery: "-", result: "not-run", note: "app not running" });
		continue;
	}
	let root;
	const operatorFront = await macosBackend.getFrontmost().catch(() => undefined);
	try {
		// Only a fixture copy is ours to raise. Another app is used exactly as it stands,
		// which is also why a cell there says "no window" instead of activating it.
		root = await ensureFixtureWindow(macosBackend, { pid: installed.pid, bundleId: preparedHandle?.bundleId, path: preparedHandle?.bundlePath }, { activate: preparedHandle !== undefined });
		if (root && operatorFront) {
			execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${operatorFront.pid} to true`], { stdio: "pipe" });
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
	} catch (error) {
		for (const action of ACTIONS) rows.push({ app, action, delivery: "-", result: "not-run", note: `listRoots failed: ${message(error)}` });
		continue;
	}
	if (!root) {
		for (const action of ACTIONS) rows.push({ app, action, delivery: "-", result: "not-run", note: "no window" });
		continue;
	}
	let look;
	try {
		look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
		rows.push({ app, action: "observe", delivery: "-", result: "pass", note: `${look.parsedOutline?.nodes?.length ?? 0} nodes, ${look.image ? "image" : "no image"}` });
	} catch (error) {
		rows.push({ app, action: "observe", delivery: "-", result: "fail", note: message(error) });
		continue;
	}
	for (const policy of DELIVERY) {
		for (const action of ACTIONS.filter((name) => name !== "observe")) {
			const cell = { app, action, delivery: policy, result: "not-run", note: "" };
			rows.push(cell);
			look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true }).catch(() => look);
			const ref = wireRefForAction(look, action);
			if (!ref) {
				cell.result = "skip";
				cell.note = "no matching control";
				continue;
			}
			try {
				const result = await macosBackend.act({ lookId: look.lookId, pid: installed.pid, target: { ref }, action: actionFor(action), policy, params: paramsFor(action) }, { timeoutMs: 15_000 });
				cell.result = result?.outcome === "worked" ? "pass" : result?.outcome === "didnt" ? "fail" : "unknown";
				cell.note = `outcome=${result?.outcome ?? "?"} delivery=${result?.performed?.delivery ?? "?"}${result?.performed?.interferedWithUser ? " interfered" : ""}`;
			} catch (error) {
				cell.result = /foreground_required|background_unsupported|unsupported_action/.test(message(error)) ? "refused" : "fail";
				cell.note = message(error);
			}
		}
	}
	look = undefined;
}

function actionFor(name) {
	return name;
}

function paramsFor(name) {
	if (name === "setText" || name === "typeText") return { text: "cu-matrix" };
	if (name === "setChecked") return { checked: true };
	if (name === "setValue") return { value: 0.5 };
	return {};
}

// The helper only resolves wire refs, and each action needs a control whose role
// actually supports it. A generic "first interactive node" made every cell report
// unsupported_action instead of the app's real behaviour.
function wireRefForAction(look, action) {
	const roles = {
		focus: ["AXTextField", "AXTextArea", "AXSearchField"],
		setText: ["AXTextField", "AXTextArea", "AXSearchField"],
		typeText: ["AXTextField", "AXTextArea", "AXSearchField"],
		press: ["AXButton"],
		setChecked: ["AXCheckBox", "AXSwitch"],
		expand: ["AXDisclosureTriangle"],
		collapse: ["AXDisclosureTriangle"],
		scrollTo: ["AXRow", "AXStaticText"],
		select: ["AXRow"],
		setValue: ["AXSlider"],
	}[action] ?? [];
	const nodes = look?.parsedOutline?.nodes ?? [];
	// Never press a window control: pressing the close button ends the matrix run
	// with "no window" and looks like an app defect.
	const windowControls = new Set(["AXCloseButton", "AXMinimizeButton", "AXFullScreenButton", "AXZoomButton"]);
	const node = nodes.find((candidate) => candidate.wireRef && roles.includes(candidate.role) && !windowControls.has(candidate.subrole));
	return node?.wireRef;
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

for (const handle of prepared) {
	const cleanup = await disposeFixtureRun(handle, macosBackend).catch(() => ({ quit: [] }));
	rows.push({ app: path.basename(handle.bundlePath), action: "fixture cleanup", delivery: "-", result: cleanup.quit.length ? "removed" : "removed", note: `quit=${cleanup.quit.join(",") || "none"}` });
}

await mkdir(EVIDENCE_DIR, { recursive: true });
const counts = rows.reduce((accumulator, row) => ({ ...accumulator, [row.result]: (accumulator[row.result] ?? 0) + 1 }), {});
const body = [
	`# Computer Use v2 compatibility matrix (${new Date().toISOString()})`,
	"",
	`Cells: ${rows.length} · ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" · ")}`,
	"",
	"| App | Action | Delivery policy | Result | Note |",
	"| --- | --- | --- | --- | --- |",
	...rows.map((row) => `| ${row.app} | ${row.action} | ${row.delivery} | ${row.result} | ${row.note.replace(/\|/g, "\\|")} |`),
	"",
	"`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.",
	"",
	"`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.",
	"",
].join("\n");
await writeFile(path.join(EVIDENCE_DIR, "compat-matrix.md"), body);
console.log(`[cu-v2 matrix] wrote ${rows.length} cells to ${path.join(EVIDENCE_DIR, "compat-matrix.md")}`);
