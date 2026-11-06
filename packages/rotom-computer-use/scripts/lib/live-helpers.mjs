/**
 * Shared plumbing for the macOS real-machine scripts (live check, PLAN §10
 * acceptance, L2 single-action check).
 *
 * These scripts are never part of `npm test`: they need `PI_CU_LIVE=1`, a real
 * helper, and real windows. What they share is bookkeeping — the evidence table,
 * the gating rules, and the two samples that decide whether an action reached the
 * user's session.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// scripts/lib -> package -> packages -> repo root
export const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A filesystem-safe run id, so one run's evidence never overwrites another's. */
export function runStamp(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}
export const nowMs = () => Date.now();

/** `--name value` reader for the script arguments. */
export function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * Real-machine scripts gate on three things: macOS, an explicit `PI_CU_LIVE=1`,
 * and their own required arguments. A skip exits 0 so CI never sees a failure
 * for "this machine cannot run it".
 */
export function requireLive(prefix, requirements) {
	if (process.platform !== "darwin") skip(prefix, "not macOS");
	if ((process.env.PI_CU_LIVE ?? "") !== "1") skip(prefix, "PI_CU_LIVE is not 1");
	for (const [name, value, hint] of requirements) {
		if (!value) skip(prefix, `pass ${name} <${hint}>`);
	}
}

function skip(prefix, reason) {
	console.log(`[${prefix}] skipped: ${reason}`);
	process.exit(0);
}

/** Rows plus a plaintext log; both are written to `evidence/` at the end. */
export function createRecorder() {
	const rows = [];
	const log = [];
	return {
		rows,
		log,
		record(area, action, result, note) {
			rows.push({ area, action, result, note: note ?? "" });
			log.push(`${new Date().toISOString()} ${area} ${action} ${result} ${note ?? ""}`);
		},
		failures() {
			return rows.filter((row) => row.result === "fail").length;
		},
		/**
		 * Writes the summary `<fileName>.md`, a plaintext log, and an immutable copy
		 * under `runs/` that a document can cite by name. The summary is overwritten
		 * every run, so only the `runs/` copy proves what a specific run saw.
		 */
		writeEvidence({ fileName, title, intro = [] }) {
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			const runName = `${runStamp()}-${fileName}.md`;
			const runsDir = path.join(EVIDENCE_DIR, "runs");
			mkdirSync(runsDir, { recursive: true });
			const failures = rows.filter((row) => row.result === "fail").length;
			const table = [
				"| Area | Check | Result | Note |",
				"| --- | --- | --- | --- |",
				...rows.map((row) => `| ${row.area} | ${row.action} | ${row.result} | ${row.note.replace(/\|/g, "\\|")} |`),
			];
			const body = [
				`# ${title} (${new Date().toISOString()})`,
				"",
				`Rows: ${rows.length} · Failures: ${failures}`,
				"",
				`本次运行存档：\`runs/${runName}\``,
				"",
				...intro,
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
			writeFileSync(path.join(EVIDENCE_DIR, `${fileName}.md`), body);
			writeFileSync(path.join(runsDir, runName), body);
			writeFileSync(path.join(EVIDENCE_DIR, `${fileName}-${Date.now()}.log`), log.join("\n"));
			if (failures > 0) process.exitCode = 1;
			return { failures, runName };
		},
	};
}

/**
 * Outline nodes carry their own wire ref, so role lookups stay aligned with the
 * look that produced them even when the tree changes shape.
 */
export function wireRefByRole(look, roles) {
	return (look.parsedOutline?.nodes ?? []).find((node) => node.wireRef && roles.includes(node.role))?.wireRef;
}

/**
 * First node of a role whose accessibility identifier starts with `prefix`.
 *
 * Window chrome (close/minimise buttons) also carries `AXButton`, and clicking it
 * closes the very window the check is about to use. Preferring the fixture's own
 * identifiers keeps the probe on content.
 */
export function wireRefByIdentifierPrefix(look, role, prefix) {
	return (look.parsedOutline?.nodes ?? []).find((node) => node.wireRef && node.role === role && typeof node.identifier === "string" && node.identifier.startsWith(prefix))?.wireRef;
}

/** Every node of a role, in outline order. */
export function wireRefsByRole(look, role) {
	return (look.parsedOutline?.nodes ?? []).filter((node) => node.wireRef && node.role === role).map((node) => node.wireRef);
}

/**
 * Whether an action reached the user's session: the cursor position and the
 * frontmost app, sampled around the action.
 */
export async function sessionProbe(macosHelper, macosBackend) {
	const frontmost = await macosBackend.getFrontmost();
	const position = await macosHelper.command("getMousePosition", {});
	return { frontmost, cursor: { x: Number(position.x), y: Number(position.y) }, t: nowMs() };
}

export function sessionDelta(before, after) {
	return {
		cursorMoved: Math.hypot(after.cursor.x - before.cursor.x, after.cursor.y - before.cursor.y) >= 1,
		frontmostChanged: after.frontmost.pid !== before.frontmost.pid,
	};
}
