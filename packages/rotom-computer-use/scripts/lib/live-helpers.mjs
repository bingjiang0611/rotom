/**
 * Shared plumbing for the macOS real-machine scripts (live check, PLAN §10
 * acceptance, L2 single-action check).
 *
 * These scripts are never part of `npm test`: they need `PI_CU_LIVE=1`, a real
 * helper, and real windows. What they share is bookkeeping — the evidence table,
 * the gating rules, and the two samples that decide whether an action reached the
 * user's session.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { finishStep } from "./b-window.mjs";

// scripts/lib -> package -> packages -> repo root
export const EVIDENCE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "docs", "agent", "computer-use-v2", "evidence");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which keyboard input source is selected.
 *
 * Key events pass through the selected input source, so an IME rewrites them
 * ("l2probe" arrived as "里probe" on 2026-11-06: the digit picked a candidate). A
 * check that types ASCII must know this *before* it runs, otherwise the text line says
 * nothing about the product.
 */
export function inputSourceInfo(exec = execFileSync) {
	try {
		const out = exec("defaults", ["read", "com.apple.HIToolbox", "AppleSelectedInputSources"], { encoding: "utf8" });
		// `defaults read` prints an old-style plist: a key with a space is quoted, a
		// single word is not (`"KeyboardLayout Name" = ABC;` vs `InputSourceKind = ...`).
		// Matching only the bare form made every layout invisible, so ASCII was never
		// detected and the L2 text line was always skipped (review H1).
		const layouts = [...out.matchAll(/"?KeyboardLayout Name"?\s*=\s*"?([^";]+)"?;/g)].map((match) => match[1].trim());
		const inputMethods = [...out.matchAll(/"?Input Mode"?\s*=\s*"?([^";]+)"?;/g)].map((match) => match[1].trim());
		const ascii = inputMethods.length === 0 && layouts.length > 0;
		return {
			ascii,
			description: ascii ? `layout ${layouts.join(",")}` : `input method ${[...inputMethods, ...layouts].join(",") || "unknown"}`,
		};
	} catch (error) {
		// Not knowing is not the same as knowing it is ASCII.
		return { ascii: false, description: `unreadable (${error instanceof Error ? error.message : String(error)})` };
	}
}

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
		writeEvidence({ fileName, title, intro = [], step, commit, runsDir = path.join(EVIDENCE_DIR, "runs") }) {
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			const runName = `${runStamp()}-${fileName}.md`;
			mkdirSync(runsDir, { recursive: true });
			const failures = rows.filter((row) => row.result === "fail").length;
			const table = [
				"| Area | Check | Result | Note |",
				"| --- | --- | --- | --- |",
				...rows.map((row) => `| ${row.area} | ${row.action} | ${row.result} | ${row.note.replace(/\|/g, "\\|")} |`),
			];
			// These three lines are what the B-phase order check reads: without them an
			// archive is a record, not permission for the next step.
			const verdict = step && commit ? finishStep({ step, commit, dir: runsDir, failures, run: runName }) : undefined;
			const body = [
				`# ${title} (${new Date().toISOString()})`,
				"",
				`Rows: ${rows.length} · Failures: ${failures}`,
				"",
				...(step ? [`Step: ${step}`] : []),
				...(commit ? [`Commit: ${commit}`] : []),
				...(verdict ? [`Verdict: ${verdict}`] : []),
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
			return { failures, runName, verdict };
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

/**
 * Refusals a helper reports on purpose, as opposed to failures.
 *
 * Classified by `error.code` (review 6 P4): the message text changes with the policy
 * name, and the previous message-matching regex turned `ax_only` correctly refusing
 * `typeText` into a `fail` cell. The code is part of the helper's contract.
 */
export const REFUSAL_CODES = Object.freeze(["foreground_required", "background_unsupported", "unsupported_action", "l2_unavailable"]);

export function classifyActFailure(error) {
	const code = typeof error?.code === "string" ? error.code : undefined;
	return { result: code && REFUSAL_CODES.includes(code) ? "refused" : "fail", code: code ?? "none" };
}

/**
 * The lease a restore has to use (review 6 P2).
 *
 * `focusWindow` is a write since Q5, so with a broker in front of the helper an
 * unsigned call is refused. Without one the helper enforces nothing, and the honest
 * label is "unverified" - not "passed".
 */
export async function leaseForRestore({ pid, brokerEnabled = process.env.ROTOM_CU_BROKER === "1", acquire } = {}) {
	if (!brokerEnabled) return { lease: undefined, state: "unverified", note: "no broker: the helper enforces no token, so this write is unverified" };
	let lease;
	try {
		lease = await (acquire ?? brokerLease)(`desktop-pid:${pid}`);
	} catch (error) {
		return { lease: undefined, state: "unavailable", note: `the broker issued no lease: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!lease?.token) return { lease: undefined, state: "unavailable", note: "the broker returned a lease without a token" };
	return { lease, state: "signed", note: `broker-signed lease ${lease.leaseId ?? "?"}` };
}

/** Ask the broker for a desktop lease. Only reachable with `ROTOM_CU_BROKER=1`. */
async function brokerLease(resourceKey) {
	const { BrokerClient } = await import("../../src/broker/client.ts");
	const client = await BrokerClient.connect({
		agent: { agentId: `cu-v2-script-${process.pid}`, hasUI: false, pid: process.pid, pidChain: [], role: "agent" },
		spawnIfMissing: false,
	});
	try {
		const acquired = await client.acquire({ resourceKey, wait: false });
		return acquired?.lease;
	} finally {
		client.close?.();
	}
}

/**
 * Whether the operator's app is in front again.
 *
 * Split from the call so the decision is testable: a restore that leaves the fixture in
 * front is exactly what B6 exists to catch, so it is a `fail`, not `inconclusive`.
 */
export function restoreOutcome({ original, after }) {
	const restored = Boolean(original && after && after.pid === original.pid);
	return {
		restored,
		result: restored ? "pass" : "fail",
		note: `${original?.appName ?? "?"} (${original?.pid ?? "?"}) → ${after?.appName ?? "?"} (${after?.pid ?? "?"})`,
	};
}

/**
 * Put the operator's app back in front, through `focusWindow` with a lease.
 *
 * The previous version re-launched the app with `manageApps ... activates: true`,
 * swallowed any error and reported `inconclusive`. `manageApps` deliberately does not
 * re-activate a running app (its `launchApp` documents that activation would steal
 * focus), so the restore never had a chance; and `inconclusive` let B6 "pass" while the
 * user's app stayed in the background.
 */
export async function restoreOperatorApp({ backend, original, record, brokerEnabled, acquire }) {
	if (!original) {
		record("restore", "operator app", "skipped", "no frontmost app was recorded before the run");
		return { restored: false, result: "skipped" };
	}
	const roots = await backend.listRoots({ pid: original.pid }).catch(() => []);
	const window = roots.find((candidate) => candidate.kind === "window");
	if (!window) {
		record("restore", "operator window", "fail", `${original.appName} pid=${original.pid} exposes no window to raise`);
		return { restored: false, result: "fail" };
	}
	const plan = await leaseForRestore({ pid: original.pid, brokerEnabled, acquire });
	let focused;
	let error;
	try {
		focused = await backend.focusWindow({ pid: original.pid, windowId: window.windowId, windowRef: window.rootRef }, undefined, plan.lease);
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
	}
	const after = await backend.getFrontmost().catch(() => undefined);
	const outcome = restoreOutcome({ original, after });
	record(
		"restore",
		"operator app",
		outcome.result,
		`${outcome.note} focused=${focused?.focused ?? "?"} alreadyFocused=${focused?.alreadyFocused ?? "?"} reason=${focused?.reason ?? "-"} lease=${plan.state} (${plan.note})${error ? ` error=${error}` : ""}`,
	);
	return { ...outcome, focused, lease: plan.state, error };
}
