#!/usr/bin/env node
/**
 * B-phase gate check: may a real-machine step run right now?
 *
 * Read-only: it prints one JSON object per call so a run archive can keep the exact
 * readings instead of a paraphrase. The decision itself lives in `scripts/lib/gate.mjs`,
 * which the run scripts call directly - this CLI is for the operator.
 *
 * Exit 0 = pass, 1 = hold, 2 = misconfigured.
 *
 *   node scripts/cu-v2-gate.mjs --window-start 2026-11-05T03:33:00-08:00 --window-minutes 60
 */
import process from "node:process";
import { readGate } from "./lib/gate.mjs";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const windowStart = arg("--window-start");
const windowMinutes = Number(arg("--window-minutes", "60"));
if (!windowStart || !Number.isFinite(windowMinutes)) {
	console.error("usage: cu-v2-gate.mjs --window-start <iso> [--window-minutes 60] [--require-idle-minutes 10] [--listening-since <iso>]");
	process.exit(2);
}

const report = await readGate({
	windowStart,
	windowMinutes,
	requireIdleMinutes: Number(arg("--require-idle-minutes", "10")),
	listeningSince: arg("--listening-since"),
});
console.log(JSON.stringify(report));
process.exit(report.verdict === "pass" ? 0 : 1);
