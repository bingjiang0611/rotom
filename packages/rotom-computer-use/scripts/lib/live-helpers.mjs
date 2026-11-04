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

export const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
		/** Writes `<fileName>.md` plus a timestamped `.log`; returns the failure count. */
		writeEvidence({ fileName, title, intro = [] }) {
			mkdirSync(EVIDENCE_DIR, { recursive: true });
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
			writeFileSync(path.join(EVIDENCE_DIR, `${fileName}-${Date.now()}.log`), log.join("\n"));
			if (failures > 0) process.exitCode = 1;
			return failures;
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
