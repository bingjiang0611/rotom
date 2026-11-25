/**
 * Shared loop records: what may leave a machine, how machines pool, and how private history is
 * imported. git is a recording fake; nothing touches a real repository or model.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { judgeGateCase, type GateCase } from "../src/loop/gate.ts";
import { poolGateHistory, type GateHistoryRecord } from "../src/loop/gate-history.ts";
import { gateRecord, importLocalHistory, latestWeeklyRecords, machineName, productIdAt, productIdentity, readGateRecords, recordSamples, setMachineName, weeklyRecord, writeGateRecord, writeWeeklyRecord, type Git } from "../src/loop/records.ts";

const tuned: GateCase = { suite: "cases/continuation-regression.eval.ts", caseId: "tuned-case", role: "reproduced", enableEnv: "ROTOM_EVAL_CONTINUATION", caseEnv: "ROTOM_EVAL_CONTINUATION_CASE", repeatsEnv: "ROTOM_EVAL_CONTINUATION_REPEATS", ledger: "L-2026-11-24-example" };
const report = (pairs: number, baseline: number, candidate: number) => ({ evalSets: [{ evalSet: "x", comparisons: [{ correctness: { eligiblePairs: pairs, baselinePassRate: baseline, candidatePassRate: candidate } }] }], diagnostics: [] });
const dfmodel = { provider: "qoder", model: "dfmodel" };
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);

/** Two commits with the same product tree and one with a different runtime; evals differ everywhere. */
const trees: Record<string, string> = {
	[A]: "040000 tree 1111\tbin\n040000 tree e1\tevals\n040000 tree 2222\truntime\n",
	[B]: "040000 tree 1111\tbin\n040000 tree e2\tevals\n040000 tree 2222\truntime\n",
	[C]: "040000 tree 1111\tbin\n040000 tree e3\tevals\n040000 tree 9999\truntime\n",
};
const git: Git = (args) => {
	const commit = String(args[1] ?? "").replace(/:rotom$/u, "");
	return args[0] === "ls-tree" && trees[commit] ? { status: 0, stdout: trees[commit] } : { status: 128, stdout: "" };
};

describe("product identity", () => {
	it("ignores evals, so commits that change only evals or docs run the same product", () => {
		expect(productIdAt(git, A)).toBe(productIdAt(git, B));
		expect(productIdAt(git, A)).not.toBe(productIdAt(git, C));
		expect(productIdAt(git, A)).toMatch(/^[0-9a-f]{16}$/u);
		expect(productIdAt(git, "unknown")).toBe("unknown");
		expect(productIdAt(git, "d".repeat(40))).toBe("unknown");
	});

	it("marks uncommitted product changes dirty, which never pools", () => {
		const inProduct = (porcelain: string): Git => (args) => (args[0] === "rev-parse" ? { status: 0, stdout: `${A}\n` } : { status: 0, stdout: porcelain });
		expect(productIdentity(git, inProduct(""))).toEqual({ commit: A, productId: productIdAt(git, A) });
		expect(productIdentity(git, inProduct(" M runtime/x.mjs\n"))).toEqual({ commit: A, productId: `dirty-${A.slice(0, 12)}` });
		expect(productIdentity(git, () => ({ status: 128, stdout: "" }))).toEqual({ commit: "unknown", productId: "unknown" });
	});
});

describe("gate records", () => {
	const run = (machine: string, runId: string, candidate: string, baselinePass: number, candidatePass: number) => gateRecord({
		machine,
		runId,
		recordedAt: "2026-11-25T03:00:00.000Z",
		baseline: { commit: C, productId: productIdAt(git, C) },
		candidate: { commit: candidate, productId: productIdAt(git, candidate) },
		results: [judgeGateCase(tuned, 3, "/private/artifacts", report(3, baselinePass / 3, candidatePass / 3), dfmodel)],
	});

	it("carries counts, commits and fingerprints but no local path", () => {
		const evalsRoot = mkdtempSync(join(tmpdir(), "rotom-records-"));
		const path = writeGateRecord(evalsRoot, run("mac1", "gate-2026-11-25T03-02-35-420Z", A, 2, 3));
		expect(path).toBe(join(evalsRoot, "loop/results/gate/mac1/gate-2026-11-25T03-02-35-420Z.json"));
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain("/private/artifacts");
		expect(JSON.parse(text).cases[0]).toEqual({ caseId: "tuned-case", role: "reproduced", model: "qoder/dfmodel", verdict: "held", pairs: 3, expectedPairs: 3, baselinePass: 2, candidatePass: 3 });
		// A run is recorded once.
		expect(() => writeGateRecord(evalsRoot, run("mac1", "gate-2026-11-25T03-02-35-420Z", A, 2, 3))).toThrow(/recorded once/u);
	});

	it("pools two machines that ran the same product from different commits", () => {
		const evalsRoot = mkdtempSync(join(tmpdir(), "rotom-records-"));
		writeGateRecord(evalsRoot, run("mac1", "gate-2026-11-25T03-02-35-420Z", A, 2, 3));
		writeGateRecord(evalsRoot, run("mac3", "gate-2026-11-25T02-49-06-998Z", B, 1, 3));
		writeGateRecord(evalsRoot, run("mac3", "gate-2026-11-26T01-00-00-000Z", C, 0, 3));
		const records = readGateRecords(evalsRoot);
		expect(records.map((record) => `${record.machine}:${record.runId}`)).toEqual(["mac1:gate-2026-11-25T03-02-35-420Z", "mac3:gate-2026-11-25T02-49-06-998Z", "mac3:gate-2026-11-26T01-00-00-000Z"]);
		const pooled = poolGateHistory(recordSamples(records));
		expect(pooled.map((group) => [group.runs, group.pairs, group.baselinePass, group.candidatePass])).toEqual(expect.arrayContaining([[2, 6, 3, 6], [1, 3, 0, 3]]));
		expect(pooled).toHaveLength(2);
	});

	it("refuses records that are malformed, misplaced or carry a local path", () => {
		const evalsRoot = mkdtempSync(join(tmpdir(), "rotom-records-"));
		const path = writeGateRecord(evalsRoot, run("mac1", "gate-2026-11-25T03-02-35-420Z", A, 2, 3));
		const good = readFileSync(path, "utf8");
		writeFileSync(path, good.replace('"baselinePass": 2', '"baselinePass": 4'));
		expect(() => readGateRecords(evalsRoot)).toThrow(/exceed pairs/u);
		writeFileSync(path, good.replace('"caseId": "tuned-case"', '"caseId": "tuned-case", "note": "/Users/someone/x"'));
		expect(() => readGateRecords(evalsRoot)).toThrow(/local paths/u);
		writeFileSync(path, good.replace('"machine": "mac1"', '"machine": "mac3"'));
		expect(() => readGateRecords(evalsRoot)).toThrow(/gate\/<machine>\/<runId>/u);
		expect(readGateRecords(mkdtempSync(join(tmpdir(), "rotom-records-")))).toEqual([]);
	});
});

describe("import and machine label", () => {
	it("turns each local run not yet committed into one record, reading the baseline commit from its path", () => {
		const sample = (runId: string, caseId: string): GateHistoryRecord => ({ schema: "rotom-loop-gate-history/v1", recordedAt: "2026-11-25T02:59:45.000Z", runId, model: dfmodel, repeats: 3, candidateCommit: A, baselineProduct: `/Users/x/.rotom/loop/frozen/${C}/rotom`, candidateProduct: "/Users/x/rotom/rotom", caseId, role: "reproduced", verdict: "held", pairs: 3, baselinePass: 1, candidatePass: 3, artifacts: "/Users/x/.rotom/loop/gate-1" });
		const history = [sample("gate-2026-11-25T02-49-06-998Z", "tuned-case"), sample("gate-2026-11-25T02-49-06-998Z", "other-case"), sample("gate-2026-11-25T03-22-59-213Z", "tuned-case")];
		const committed = [gateRecord({ machine: "mac3", runId: "gate-2026-11-25T03-22-59-213Z", recordedAt: "2026-11-25T03:22:59.000Z", baseline: { commit: C, productId: "x" }, candidate: { commit: A, productId: "y" }, results: [judgeGateCase(tuned, 3, "/a", report(3, 1, 1), dfmodel)] })];
		const baselineCommit = (path: string) => /\/frozen\/([0-9a-f]{40})\//u.exec(path)?.[1] ?? "unknown";
		const records = importLocalHistory({ history, machine: "mac3", committed, git, baselineCommit });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ machine: "mac3", runId: "gate-2026-11-25T02-49-06-998Z", baseline: { commit: C, productId: productIdAt(git, C) }, candidate: { commit: A, productId: productIdAt(git, A) } });
		expect(records[0]?.cases.map((item) => item.caseId)).toEqual(["tuned-case", "other-case"]);
		expect(JSON.stringify(records)).not.toMatch(/\/Users\//u);
		// Another machine's committed run with the same id does not hide this machine's run.
		expect(importLocalHistory({ history, machine: "mac1", committed, git, baselineCommit })).toHaveLength(2);
	});

	it("reads the label from the environment first, then the private file, and refuses a bad one", () => {
		const loopDir = mkdtempSync(join(tmpdir(), "rotom-records-"));
		expect(machineName(loopDir, {})).toBeUndefined();
		setMachineName(loopDir, "mac3");
		expect(machineName(loopDir, {})).toBe("mac3");
		expect(machineName(loopDir, { ROTOM_LOOP_MACHINE: "mac1" })).toBe("mac1");
		expect(() => machineName(loopDir, { ROTOM_LOOP_MACHINE: "U-NG6QRPKC" })).toThrow(/lowercase/u);
		expect(() => setMachineName(loopDir, "My Mac")).toThrow(/lowercase/u);
	});
});

describe("weekly records", () => {
	it("keeps the aggregate and leaves session ids behind", () => {
		const evalsRoot = mkdtempSync(join(tmpdir(), "rotom-records-"));
		const report = {
			generatedAt: "2026-11-25T02:44:10.000Z",
			window: { since: "2026-10-28T02:44:10.000Z" },
			northStar: {
				overall: [{ key: "all", turns: 4011, v2: 225, v2Per100: 5.6, interval: { low: 4.9, high: 6.3 }, sensitivity: { v2Per100: 4.9, droppedSessionId: "0123456789abcdef" } }],
				models: [{ key: "qoder/dfmodel", turns: 900, v2Per100: 8.1 }],
			},
			records: [{ id: "L-2026-11-10-x", status: "insufficient-exposure", turns: 10 }],
		};
		const path = writeWeeklyRecord(evalsRoot, weeklyRecord("mac1", report));
		expect(path).toBe(join(evalsRoot, "loop/results/weekly/mac1/2026-11-25.json"));
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain("0123456789abcdef");
		expect(latestWeeklyRecords(evalsRoot)).toEqual([{ schema: "rotom-loop-weekly-record/v1", machine: "mac1", generatedAt: report.generatedAt, since: report.window.since, overall: { turns: 4011, events: 225, per100: 5.6, band: [4.9, 6.3], withoutLargestPer100: 4.9 }, models: [{ model: "qoder/dfmodel", turns: 900, per100: 8.1 }], acceptance: [{ id: "L-2026-11-10-x", status: "insufficient-exposure" }] }]);
		mkdirSync(join(evalsRoot, "loop/results/weekly/mac3"), { recursive: true });
		expect(latestWeeklyRecords(evalsRoot).map((record) => record.machine)).toEqual(["mac1"]);
	});
});

it("accepts every record committed to this repository", () => {
	// The shared records are read by status and gate-pool on every machine; a malformed or
	// path-carrying file must fail here, in CI, rather than there.
	const evalsRoot = join(import.meta.dirname, "..");
	expect(() => readGateRecords(evalsRoot)).not.toThrow();
	expect(() => latestWeeklyRecords(evalsRoot)).not.toThrow();
});
