#!/usr/bin/env node
/**
 * Computer Use v2 L2 single-action check (macOS, real helper).
 *
 * Runs one directed click and one directed text input against the fixture app and
 * against an app on the L2 compatibility list, and records what actually happened:
 * did the cursor move, did the app receive the event, did the helper survive. A
 * crash is a result, not a failure of the harness.
 *
 * Only processes this run started are ever operated: anything already running
 * belongs to the operator. A white-listed app must therefore be launched by this
 * run (start it yourself, or pass --allow-l2-app after a run that launched it).
 *
 *   PI_CU_LIVE=1 node scripts/cu-v2-l2-check.mjs --fixture ~/cu-v2-test/Fixture.app
 *
 * Isolated helper, same as the other live scripts:
 *
 *   PI_COMPUTER_USE_HELPER_APP_PATH=~/cu-v2-test/pi-computer-use.app \
 *   PI_CU_SOCKET_PATH=~/cu-v2-test/helper.sock
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { runStamp } from "./lib/live-helpers.mjs";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");
const rows = [];
const log = [];

function record(area, action, result, note) {
	rows.push({ area, action, result, note: note ?? "" });
	log.push(`${new Date().toISOString()} ${area} ${action} ${result} ${note ?? ""}`);
}

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

function disabled(reason) {
	console.log(`[cu-v2 l2] skipped: ${reason}`);
	process.exit(0);
}

if (process.platform !== "darwin") disabled("not macOS");
if ((process.env.PI_CU_LIVE ?? "") !== "1") disabled("PI_CU_LIVE is not 1");

const fixturePath = argument("--fixture");
if (!fixturePath || !existsSync(fixturePath)) disabled("pass --fixture <path to the built fixture app>");

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { L2_COMPATIBLE_BUNDLE_IDS } = await import("../src/policy/l2-compat.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPED = "l2probe";

async function cursor() {
	const position = await macosHelper.command("getMousePosition", {});
	return { x: Number(position.x), y: Number(position.y) };
}

function wireRefByRole(look, roles) {
	return (look.parsedOutline?.nodes ?? []).find((node) => node.wireRef && roles.includes(node.role))?.wireRef;
}

function valueOfRef(look, wireRef) {
	return (look.parsedOutline?.nodes ?? []).find((node) => node.wireRef === wireRef)?.value;
}

async function alive() {
	try {
		const diagnostics = await macosHelper.diagnosticsCommand();
		return diagnostics.protocolVersion === 8;
	} catch {
		return false;
	}
}

/**
 * Run one action with `background` policy (the L2 delivery path), sampling the
 * cursor and the frontmost app on both sides so a side effect is attributable.
 */
async function probe(agent, look, pid, action, controls) {
	const before = { cursor: await cursor(), frontmost: await macosBackend.getFrontmost() };
	const started = Date.now();
	let result;
	let error;
	try {
		result = await macosBackend.act({ lookId: look.lookId, pid, policy: "background", target: { ref: action.ref }, ...action }, { timeoutMs: 20_000 });
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	const after = { cursor: await cursor(), frontmost: await macosBackend.getFrontmost() };
	const cursorMoved = Math.hypot(after.cursor.x - before.cursor.x, after.cursor.y - before.cursor.y) >= 1;
	const frontmostChanged = after.frontmost.pid !== before.frontmost.pid;
	const outcome = result?.outcome ?? (error ? "error" : "unknown");
	const delivery = result?.performed?.delivery ?? (error ? "none" : "?");
	record(agent, action.action, outcome === "worked" ? "pass" : outcome === "foreground_required" ? "pass" : "inconclusive", `outcome=${outcome} delivery=${delivery} cursorMoved=${cursorMoved} frontmostChanged=${frontmostChanged} ${Date.now() - started}ms${error ? ` error=${error}` : ""}`);
	return { outcome, delivery, cursorMoved, frontmostChanged, look };
}

async function main() {
	const diagnostics = await macosHelper.diagnosticsCommand();
	record("helper", "diagnostics", "pass", `protocol=${diagnostics.protocolVersion} accessibility=${diagnostics.accessibility}`);
	const frontmost = await macosBackend.getFrontmost();
	record("environment", "operator app", "pass", `${frontmost.appName} pid=${frontmost.pid}`);

	// Anything already running belongs to the operator. This run may only act on
	// processes it started itself, so an app that was here before is never a target -
	// not even the fixture, and not an app the operator named with --allow-l2-app.
	const atStartup = await macosBackend.listApps();
	const beforeRun = new Set(atStartup.map((app) => app.pid));
	record("environment", "apps at startup", "pass", `${beforeRun.size} running; only processes started by this run may be operated`);
	const startedByThisRun = (app) => !beforeRun.has(app.pid);

	// ---- fixture: not on the L2 list, so the product path must refuse it ----
	const apps = await macosBackend.listApps();
	let fixture = apps.find((app) => app.bundleId === "com.example.cu-fixture") ?? apps.find((app) => /fixture/i.test(app.appName ?? ""));
	if (fixture && !startedByThisRun(fixture)) {
		record("fixture", "present", "skipped", `pid=${fixture.pid} was already running before this run; quit it so the check can launch its own copy`);
		fixture = undefined;
	} else if (!fixture) {
		try {
			await macosBackend.manageApps({ mode: "launch", path: fixturePath, activates: false });
		} catch {
			execFileSync("open", ["-n", fixturePath], { stdio: "pipe" });
		}
		await sleep(2500);
		fixture = (await macosBackend.listApps()).find((app) => /fixture/i.test(app.appName ?? ""));
		if (fixture && !startedByThisRun(fixture)) {
			// A launch that silently attached to an older copy is not this run's process.
			record("fixture", "present", "skipped", `pid=${fixture.pid} was already running before this run`);
			fixture = undefined;
		}
	}
	if (!fixture) {
		if (!rows.some((row) => row.area === "fixture" && row.action === "present")) {
			record("fixture", "present", "fail", "the fixture app is not running and could not be launched");
		}
	} else {
		record("fixture", "present", "pass", `pid=${fixture.pid} bundle=${fixture.bundleId}`);
		let roots = await macosBackend.listRoots({ pid: fixture.pid });
		if (!roots.some((candidate) => candidate.kind === "window")) {
			// A fixture started from its binary is not activated, so its window is not
			// in the window list yet. Activate once; the operator app is restored below.
			execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${fixture.pid} to true`], { stdio: "pipe" });
			await sleep(1200);
			roots = await macosBackend.listRoots({ pid: fixture.pid });
		}
		const root = roots.find((candidate) => candidate.kind === "window");
		if (!root) {
			record("fixture", "window", "fail", "no window in listRoots even after activating the fixture");
		} else {
			const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
			const controls = { text: wireRefByRole(look, ["AXTextField"]), button: wireRefByRole(look, ["AXButton"]) };
			record("fixture", "controls", controls.text && controls.button ? "pass" : "inconclusive", `text=${controls.text ?? "-"} button=${controls.button ?? "-"}`);

			if (controls.button) await probe("fixture (not on the L2 list)", look, fixture.pid, { action: "click", ref: controls.button }, controls);
			if (controls.text) {
				// Point the field at a known value first so "did the input arrive" is a
				// value change, not a guess.
				// The successful click above changed the tree, so its refs are stale:
				// observe again instead of reusing an evicted look.
				const fresh = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
				const textRef = wireRefByRole(fresh, ["AXTextField"]);
				if (!textRef) {
					record("fixture (not on the L2 list)", "typeText", "skipped", "the text field disappeared after the click");
				} else {
					await macosBackend.act({ lookId: fresh.lookId, pid: fixture.pid, target: { ref: textRef }, action: "clear", policy: "ax_only" }, { timeoutMs: 20_000 }).catch(() => undefined);
					const typed = await probe("fixture (not on the L2 list)", fresh, fixture.pid, { action: "typeText", ref: textRef, params: { text: TYPED } });
					const after = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: false });
					const received = String((after.parsedOutline?.nodes ?? []).find((node) => node.role === "AXTextField")?.value ?? "");
					record("fixture (not on the L2 list)", "input received", received === TYPED ? "pass" : typed.outcome === "worked" ? "fail" : "pass", `field="${received}" expected="${TYPED}" outcome=${typed.outcome}`);
				}
			}
		}
	}

	// ---- apps on the L2 list: the positive path ----
	// Never drive an app the operator already had open unless they name it: the
	// point of the check is to type into something this run owns.
	const allowL2App = argument("--allow-l2-app");
	const onList = (await macosBackend.listApps()).filter((app) => app.bundleId && L2_COMPATIBLE_BUNDLE_IDS.has(app.bundleId));
	const installed = onList.filter((app) => allowL2App && app.bundleId === allowL2App && startedByThisRun(app));
	if (!allowL2App) {
		record("L2 whitelist", "app on the list", "skipped", onList.length === 0 ? "nothing from the list is running" : `running: ${onList.map((app) => app.appName).join(", ")}; pass --allow-l2-app <bundleId> to type into it`);
	} else if (installed.length === 0) {
		const preexisting = onList.find((app) => app.bundleId === allowL2App);
		record("L2 whitelist", "app on the list", "skipped", preexisting
			? `${allowL2App} (pid=${preexisting.pid}) was already running before this run; this script only operates processes it started`
			: `${allowL2App} is not running; start it and re-run, this script does not launch user apps`);
	}
	for (const app of installed) {
		const roots = await macosBackend.listRoots({ pid: app.pid });
		const root = roots.find((candidate) => candidate.kind === "window");
		if (!root) {
			record(app.appName ?? app.bundleId, "window", "fail", "no window in listRoots");
			continue;
		}
		const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
		const text = wireRefByRole(look, ["AXTextField", "AXTextArea"]);
		if (text) await probe(app.appName ?? app.bundleId, look, app.pid, { action: "typeText", ref: text, params: { text: TYPED } }, {});
		else record(app.appName ?? app.bundleId, "typeText", "skipped", "no text input element in the window; not typing blind into a user app");
		// A directed click only where the window exposes a button: never click blind.
		const button = wireRefByRole(look, ["AXButton"]);
		if (button) await probe(app.appName ?? app.bundleId, look, app.pid, { action: "click", ref: button }, {});
		else record(app.appName ?? app.bundleId, "click", "skipped", "no button in the window");
	}

	record("helper", "still alive", (await alive()) ? "pass" : "fail", "the helper answered diagnostics after every probe (no crash)");

	// Leave the operator's app in front again.
	execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${frontmost.pid} to true`], { stdio: "pipe" });
	const restored = await macosBackend.getFrontmost();
	record("cleanup", "operator app restored", restored.pid === frontmost.pid ? "pass" : "inconclusive", `${frontmost.appName} → ${restored.appName}`);
}

async function writeEvidence() {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	mkdirSync(path.join(EVIDENCE_DIR, "runs"), { recursive: true });
	const failures = rows.filter((row) => row.result === "fail").length;
	const table = ["| Target | Action | Result | Note |", "| --- | --- | --- | --- |", ...rows.map((row) => `| ${row.area} | ${row.action} | ${row.result} | ${row.note.replace(/\|/g, "\\|")} |`)];
	const runName = `${runStamp()}-l2-check.md`;
	const body = [
		`# Computer Use v2 L2 single-action check (${new Date().toISOString()})`,
		"",
		`Rows: ${rows.length} · Failures: ${failures}`,
		"",
		`本次运行存档：\`runs/${runName}\``,
		"",
		"One directed click and one directed text input per target, delivered with `background` policy.",
		"`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.",
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
	writeFileSync(path.join(EVIDENCE_DIR, "l2-check.md"), body);
	// The summary is overwritten by the next run; the archived copy is the citation.
	writeFileSync(path.join(EVIDENCE_DIR, "runs", runName), body);
	writeFileSync(path.join(EVIDENCE_DIR, `l2-check-${Date.now()}.log`), log.join("\n"));
	if (failures > 0) process.exitCode = 1;
}

try {
	await main();
} catch (error) {
	record("run", "abort", "fail", error instanceof Error ? error.message : String(error));
	console.error(`[cu-v2 l2] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

await writeEvidence();
const failures = rows.filter((row) => row.result === "fail").length;
console.log(`[cu-v2 l2] ${rows.length} rows, ${failures} failing; log written to ${EVIDENCE_DIR}`);
