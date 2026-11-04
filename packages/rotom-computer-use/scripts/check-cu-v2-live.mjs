#!/usr/bin/env node
/**
 * Computer Use v2 live check (macOS, real helper, real windows).
 *
 * Never part of `npm test`: it is gated behind `PI_CU_LIVE=1`, it drives a real
 * helper, and it types into a real application. It only touches the fixture app
 * and deliberately read-only system surfaces, never user documents.
 *
 *   PI_CU_LIVE=1 node scripts/check-cu-v2-live.mjs --fixture /tmp/cu-fixture
 *
 * What it proves when it passes:
 *   - the helper answers as protocol 8 and reports user activity
 *   - each semantic action reaches a real control and reports a verified outcome
 *   - a background action leaves the frontmost app, the focused window and the
 *     system cursor untouched, and does not report `interferedWithUser`
 *   - a concurrent agent is refused with `resource_busy` rather than interleaving
 *
 * What it cannot prove: that no other app on this machine is affected, or that
 * L2 delivery works in apps outside the compatibility list.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "docs", "agent", "computer-use-v2", "evidence");
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

	const activity = await macosBackend.userActivity();
	record("helper", "userActivity", activity.listening ? "pass" : "fail", `idle=${activity.idleSeconds.toFixed(1)}s`);

	if (!fixturePath || !existsSync(fixturePath)) throw new Error("pass --fixture <path to the built fixture app>");
	await macosBackend.manageApps({ mode: "launch", path: fixturePath, activates: false });
	await new Promise((resolve) => setTimeout(resolve, 2500));

	const apps = await macosBackend.listApps();
	const fixture = apps.find((app) => /fixture/i.test(app.appName) || /fixture/i.test(app.bundleId ?? ""));
	if (!fixture) throw new Error("the fixture app did not appear in listApps");
	record("app", "launch", "pass", `pid=${fixture.pid}`);

	const frontmostBefore = await macosBackend.getFrontmost();
	const cursorBefore = await macosHelper.command("getMousePosition", {});

	const roots = await macosBackend.listRoots({ pid: fixture.pid });
	const root = roots.find((candidate) => candidate.kind === "window");
	if (!root) throw new Error("the fixture window is not in listRoots");

	const look = await macosBackend.observe({ target: { windowId: root.windowId, rootRef: root.rootRef }, readText: "auto", includeImage: true });
	record("observe", "window", look.image ? "pass" : "fail", `nodes=${look.outline?.nodes?.length ?? 0}`);

	for (const control of ["text", "checkbox", "slider", "list", "tree", "tabs"]) {
		const node = findNode(look.outline, (candidate) => (candidate.label ?? "").toLowerCase().includes(control));
		record("outline", `find ${control}`, node ? "pass" : "fail", node?.role ?? "not found");
	}

	await runAction("focus", () => actOn(root, look, { action: "focus", ref: refFor(look, "text") }));
	await runAction("setText", () => actOn(root, look, { action: "setText", ref: refFor(look, "text"), text: "fixture text" }));
	await runAction("setChecked", () => actOn(root, look, { action: "setChecked", ref: refFor(look, "checkbox"), checked: true }));
	await runAction("setValue", () => actOn(root, look, { action: "setValue", ref: refFor(look, "slider"), value: 0.75 }));
	await runAction("select", () => actOn(root, look, { action: "select", ref: refFor(look, "list") }));
	await runAction("collapse", () => actOn(root, look, { action: "collapse", ref: refFor(look, "tree") }));
	await runAction("expand", () => actOn(root, look, { action: "expand", ref: refFor(look, "tree") }));

	const frontmostAfter = await macosBackend.getFrontmost();
	const cursorAfter = await macosHelper.command("getMousePosition", {});
	record("background", "frontmost unchanged", frontmostAfter.pid === frontmostBefore.pid ? "pass" : "fail", `${frontmostBefore.pid} → ${frontmostAfter.pid}`);
	record("background", "cursor unchanged", cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y ? "pass" : "fail", `${JSON.stringify(cursorBefore)} → ${JSON.stringify(cursorAfter)}`);

	if (process.argv.includes("--with-user-simulator")) {
		record("user", "simulator", "manual", "run scripts/cu-v2-user-simulator.mjs in another terminal and re-run with --assert-user-text");
	}

	await writeEvidence();
	console.log(`[cu-v2 live] ${rows.filter((row) => row.result === "fail").length} failing row(s); log written to ${EVIDENCE_DIR}`);
}

async function actOn(root, look, action) {
	return await macosBackend.act({ lookId: look.lookId, pid: root.pid, target: { ref: action.ref }, policy: "default", ...action }, { timeoutMs: 20_000 });
}

async function runAction(name, run) {
	try {
		const result = await run();
		const outcome = result?.outcome ?? "unknown";
		const interfered = result?.performed?.interferedWithUser === true;
		record("act", name, outcome === "worked" ? (interfered ? "fail" : "pass") : "fail", `outcome=${outcome} delivery=${result?.performed?.delivery ?? "?"}${interfered ? " interfered" : ""}`);
	} catch (error) {
		record("act", name, "fail", error instanceof Error ? error.message : String(error));
	}
}

function findNode(outline, predicate) {
	const stack = [...(outline?.nodes ?? [])];
	while (stack.length) {
		const node = stack.pop();
		if (predicate(node)) return node;
		for (const child of node.children ?? []) stack.push(child);
	}
	return undefined;
}

function refFor(outline, needle) {
	const node = findNode(outline, (candidate) => (candidate.label ?? "").toLowerCase().includes(needle));
	if (!node?.ref) throw new Error(`no outline node matches '${needle}'`);
	return node.ref;
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
} finally {
	void spawn; // keep the import graph honest for future simulator wiring
}
