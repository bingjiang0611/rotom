import assert from "node:assert/strict";
import test from "node:test";
import { cumulativeReportedTokens, updateGoalUsage } from "../src/accounting.js";

const usage = (totalTokens: number) => ({ totalTokens });

test("budgets include tool model calls, independent usage and summaries once", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage(100) } },
		{ type: "message", message: { role: "toolResult", usage: usage(20), details: { calls: [{ usage: usage(20) }] } } },
		{ type: "usage", kind: "classifier", usage: usage(30) },
		{ type: "compaction", usage: usage(40) },
		{ type: "branch_summary", usage: usage(50) },
		{ type: "custom", data: { usage: usage(999) } },
	];
	assert.equal(cumulativeReportedTokens(entries), 240);
	assert.equal(cumulativeReportedTokens(entries, true), 100);
});

test("legacy Goal baselines migrate once without charging old auxiliary usage", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: usage(100) } },
		{ type: "compaction", usage: usage(40) },
	];
	const ctx = { sessionManager: { getBranch: () => entries } };
	const goal = { status: "paused", baselineTokens: 60, tokensUsed: 40, timeUsedSeconds: 0, updatedAt: 0 };
	updateGoalUsage(goal, ctx);
	assert.equal(goal.tokensUsed, 40);
	assert.equal(goal.baselineTokens, 100);
	entries.push({ type: "usage", usage: usage(10) } as any);
	updateGoalUsage(goal, ctx);
	assert.equal(goal.tokensUsed, 50);
	assert.equal(goal.baselineTokens, 100);
});
