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
import path from "node:path";
import process from "node:process";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "docs", "agent", "computer-use-v2", "evidence");
const ACTIONS = ["observe", "focus", "setText", "typeText", "press", "setChecked", "expand", "scrollTo", "select", "setValue"];
const DELIVERY = ["ax_only", "background", "foreground"];

if (process.platform !== "darwin" || (process.env.PI_CU_LIVE ?? "") !== "1") {
	console.log("[cu-v2 matrix] not run: needs macOS and PI_CU_LIVE=1 with a real helper");
	process.exit(0);
}

const apps = (process.argv[process.argv.indexOf("--apps") + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (apps.length === 0) {
	console.error("[cu-v2 matrix] pass --apps with bundle ids or app paths");
	process.exit(2);
}

const { macosBackend } = await import("../src/platform/macos/backend.ts");

const rows = [];

for (const app of apps) {
	await macosBackend.manageApps({ mode: "launch", bundleId: app.includes(".") && !app.startsWith("/") ? app : undefined, path: app.startsWith("/") ? app : undefined, activates: false }).catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const installed = (await macosBackend.listApps()).find((candidate) => candidate.bundleId === app || app.startsWith("/") && candidate.appName.toLowerCase().includes(path.basename(app).toLowerCase()));
	if (!installed) {
		for (const action of ACTIONS) rows.push({ app, action, delivery: "-", result: "not-run", note: "app not running" });
		continue;
	}
	let root;
	try {
		root = (await macosBackend.listRoots({ pid: installed.pid })).find((candidate) => candidate.kind === "window");
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
		rows.push({ app, action: "observe", delivery: "-", result: "pass", note: `${look.outline?.nodes?.length ?? 0} nodes` });
	} catch (error) {
		rows.push({ app, action: "observe", delivery: "-", result: "fail", note: message(error) });
		continue;
	}
	for (const policy of DELIVERY) {
		for (const action of ACTIONS.filter((name) => name !== "observe")) {
			const cell = { app, action, delivery: policy, result: "not-run", note: "" };
			rows.push(cell);
			const ref = firstInteractiveRef(look, action);
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

function firstInteractiveRef(look, action) {
	const stack = [...(look?.outline?.nodes ?? [])];
	while (stack.length) {
		const node = stack.pop();
		if (node.ref && (node.wireRef || node.canPress || node.canFocus || node.canSetValue)) return node.ref;
		for (const child of node.children ?? []) stack.push(child);
	}
	return undefined;
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
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
	"`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.",
	"",
].join("\n");
await writeFile(path.join(EVIDENCE_DIR, "compat-matrix.md"), body);
console.log(`[cu-v2 matrix] wrote ${rows.length} cells to ${path.join(EVIDENCE_DIR, "compat-matrix.md")}`);
