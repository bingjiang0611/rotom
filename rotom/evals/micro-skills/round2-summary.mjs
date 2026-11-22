import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tasks } from "./round2-tasks.mjs";

export function rollup(rows) {
	const summary = { attempts: rows.length, complete: 0, pass: 0, redundant: 0, failedCommands: 0, staleRuns: 0,
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalFromProvider: { true: 0, false: 0, missing: 0 },
		cost: 0, usageMissing: 0, costMissing: 0 };
	for (const row of rows) {
		if (row.infrastructure === null) {
			summary.complete++;
			summary.pass += Number(row.pass);
			summary.redundant += row.redundant;
			summary.failedCommands += row.failedCommands;
			summary.staleRuns += row.calls.filter(call => call.check === "stale").length;
		}
		// Spend even on aborted/infrastructure attempts still counts. Do not turn unknown into 0.
		for (const { usage } of row.messages) {
			const fields = ["input", "output", "cacheRead", "cacheWrite"];
			if (!fields.every(f => Number.isFinite(usage?.[f]))) summary.usageMissing++;
			for (const field of fields) if (Number.isFinite(usage?.[field])) summary[field] += usage[field];
			if (Number.isFinite(usage?.cost?.total)) summary.cost += usage.cost.total;
			else summary.costMissing++;
			const source = usage?.cost?.totalFromProvider;
			summary.totalFromProvider[typeof source === "boolean" ? String(source) : "missing"]++;
		}
		if (row.messages.length === 0) {
			summary.usageMissing++;
			summary.costMissing++;
		}
	}
	return summary;
}

export function summarize(rows) {
	const arms = ["A", "B", "C"];
	const byArm = matching => Object.fromEntries(arms.map(arm => [arm, rollup(matching.filter(row => row.arm === arm))]));
	const totals = byArm(rows);
	const byTask = Object.fromEntries(tasks.map(task => [task.id, byArm(rows.filter(row => row.task === task.id))]));
	const repeats = [1, 2, 3].map(repeat => byArm(rows.filter(row => row.repeat === repeat)));
	const complete = tasks.every(task => [1, 2, 3].every(repeat => arms.every(arm => {
		const matched = rows.filter(row => row.task === task.id && row.repeat === repeat && row.arm === arm);
		return matched.length === 1 && matched[0].infrastructure === null;
	}))) && rows.length === tasks.length * 9;
	const meetsDiscussionBar = complete && repeats.every(({ B, C }) => !B.usageMissing && !C.usageMissing &&
		!B.costMissing && !C.costMissing && C.redundant < B.redundant && C.cost <= B.cost && C.pass >= B.pass) &&
		Object.values(byTask).every(({ B, C }) => C.pass >= B.pass);
	return { totals, byTask, repeats, complete, meetsDiscussionBar };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
	assert.equal(data.schema, "rotom-micro-skills-round2/v1");
	console.log(JSON.stringify(summarize(data.rows), null, 2));
}
