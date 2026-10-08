import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "./summarize.mjs";

test("does not count censored state success as a comparable completed chain", () => {
	const chain = (arm, repetition, status) => ({ case: "tail-error", arm, repetition, status, elapsedMs: 10, grade: { pass: true, actions: 1 }, privateText: "never export" });
	const chains = [chain("baseline", 1, "CENSORED"), chain("candidate", 1, "PASS"), chain("baseline", 2, "PASS"), chain("candidate", 2, "PASS")];
	const report = { status: "INCONCLUSIVE", chains, priorRequests: 1, priorInfrastructureAttempt: { modelDispatches: 1, reportedTokens: 7 }, networkModelDispatches: 4,
		started: 0, ended: 100, requests: chains.map((c) => ({ ...c, phase: "summary", usage: { totalTokens: 10 } })) };
	const output = summarize(report, "digest");
	assert.equal(output.paired.baseline.chains, 1);
	assert.equal(output.paired.candidate.chains, 1);
	assert.equal(output.paired.baseline.reportedTokens, 10);
	assert.equal(output.all.reportedTokens, 47);
	assert.equal(output.all.admittedRequests, 5);
	assert.equal(output.all.modelDispatches, 5);
	assert.equal(output.all.statusCounts.CENSORED, 1);
	assert.equal(JSON.stringify(output).includes("never export"), false);
	assert.equal(summarize({ ...report, status: "REGRESSION" }, "digest").decision, "REGRESSION");
});
