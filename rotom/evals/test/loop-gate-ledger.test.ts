import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { continuationCases } from "../src/continuation-cases.ts";
import { gateVerdict, judgeGateCase, parseGateManifest, type GateCase } from "../src/loop/gate.ts";
import { parseLedger, PROMPT_RENT_SINCE } from "../src/loop/ledger.ts";

const evalsRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(evalsRoot, "../..");
const manifestText = readFileSync(resolve(evalsRoot, "loop/gate.json"), "utf8");
const ledgerText = readFileSync(resolve(evalsRoot, "loop/ledger.json"), "utf8");

const item: GateCase = {
	suite: "cases/continuation-regression.eval.ts",
	caseId: "behavior-authorized-follow-through",
	role: "reproduced",
	enableEnv: "ROTOM_EVAL_CONTINUATION",
	caseEnv: "ROTOM_EVAL_CONTINUATION_CASE",
	repeatsEnv: "ROTOM_EVAL_CONTINUATION_REPEATS",
	ledger: "L-2026-11-02-follow-through-recheck",
};

function report(eligiblePairs: number, baselinePassRate: number | null, candidatePassRate: number | null) {
	return { evalSets: [{ evalSet: "x", comparisons: [{ correctness: { eligiblePairs, baselinePassRate, candidatePassRate }, totalTokens: { baselineMean: 100, candidateMean: 120 } }] }], diagnostics: [] };
}

describe("loop gate", () => {
	it("checked-in manifest only names real mechanism cases admitted through the ledger", () => {
		const manifest = parseGateManifest(manifestText);
		expect(manifest.model).toEqual({ provider: "qoder", model: "dfmodel" });
		const ledgerIds = new Set(parseLedger(ledgerText).map((entry) => entry.id));
		for (const gateCase of manifest.cases) {
			const definition = continuationCases.find((candidate) => candidate.id === gateCase.caseId);
			expect(definition, gateCase.caseId).toBeDefined();
			expect(definition?.level).toBe("mechanism-reproduction");
			expect(ledgerIds.has(gateCase.ledger), gateCase.ledger).toBe(true);
		}
	});

	it("rejects malformed manifests", () => {
		const valid = JSON.parse(manifestText);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, schema: "x" }))).toThrow(/schema/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, repeats: 9 }))).toThrow(/repeats/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: valid.cases.map((entry: GateCase) => ({ ...entry, role: "control" })) }))).toThrow(/reproduced/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], enableEnv: "PATH" }] }))).toThrow(/env/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [valid.cases[0], valid.cases[0]] }))).toThrow(/duplicate/u);
	});

	it("judges from the candidate arm and never turns missing data into held", () => {
		expect(judgeGateCase(item, 3, "/a", report(3, 0, 1)).verdict).toBe("held");
		expect(judgeGateCase(item, 3, "/a", report(3, 1, 1)).verdict).toBe("held");
		expect(judgeGateCase(item, 3, "/a", report(3, 0, 2 / 3)).verdict).toBe("regressed");
		expect(judgeGateCase(item, 3, "/a", report(2, 0, 1))).toMatchObject({ verdict: "unknown", pairs: 2 });
		expect(judgeGateCase(item, 3, "/a", undefined)).toMatchObject({ verdict: "unknown", reason: "comparisons.json missing" });
		expect(gateVerdict([judgeGateCase(item, 3, "/a", report(3, 0, 1)), judgeGateCase(item, 3, "/a", undefined)])).toBe("unknown");
		expect(gateVerdict([judgeGateCase(item, 3, "/a", report(3, 0, 0)), judgeGateCase(item, 3, "/a", undefined)])).toBe("regressed");
	});
});

describe("loop ledger", () => {
	it("checked-in ledger is valid and every source exists", () => {
		const entries = parseLedger(ledgerText, repoRoot);
		expect(entries.length).toBeGreaterThanOrEqual(10);
		expect(entries.map((entry) => entry.date)).toEqual([...entries.map((entry) => entry.date)].sort());
	});

	it("requires measured improvement for prompt changes shipped under the new rule", () => {
		const entry = {
			schema: "rotom-loop-ledger/v1",
			id: `L-${PROMPT_RENT_SINCE}-new-rule`,
			date: PROMPT_RENT_SINCE,
			title: "t",
			hypothesis: "h",
			change: "prompt",
			measurement: "m",
			result: "r",
			evidence: "inconclusive",
			decision: "shipped",
			source: "docs/agent/optimization-loop.md",
		};
		expect(() => parseLedger(JSON.stringify([entry]))).toThrow(/improved/u);
		expect(() => parseLedger(JSON.stringify(entry))).toThrow(/array/u);
		expect(parseLedger(JSON.stringify([{ ...entry, evidence: "improved" }]))).toHaveLength(1);
		expect(() => parseLedger(JSON.stringify([{ ...entry, evidence: "improved" }, { ...entry, evidence: "improved" }]))).toThrow(/duplicate/u);
		expect(() => parseLedger(JSON.stringify([{ ...entry, id: "L-2026-01-01-x" }]))).toThrow(/match the id/u);
		expect(() => parseLedger(JSON.stringify([{ ...entry, evidence: "improved", source: "docs/nope.md" }]), repoRoot)).toThrow(/does not exist/u);
	});
});
