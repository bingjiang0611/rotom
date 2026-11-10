import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { continuationCaseFor, continuationCases, scoreContinuationCase, unobservedReads } from "../src/continuation-cases.ts";
import { appendGateHistory, auditSmokeScores, effectiveModel, gateHistoryRecords, smokeScoresFromResults, gateVerdict, judgeGateCase, parseGateHistory, parseGateManifest, poolGateHistory, type GateCase, type GateHistoryRecord } from "../src/loop/gate.ts";
import { parseLedger, parseLedgerDir, PROMPT_RENT_SINCE, shardFile } from "../src/loop/ledger.ts";

const evalsRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(evalsRoot, "../..");
const manifestText = readFileSync(resolve(evalsRoot, "loop/gate.json"), "utf8");
const ledgerDir = resolve(evalsRoot, "loop/ledger");
const ledgerText = `[${readdirSync(ledgerDir)
	.filter((name) => name.endsWith(".json"))
	.sort()
	.map((name) => readFileSync(join(ledgerDir, name), "utf8").trim().replace(/^\[/u, "").replace(/\]$/u, ""))
	.join(",")}]`;

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
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], reproduction: [{ model: "qoder/dfmodel", verdict: "maybe", detail: "x" }] }] }))).toThrow(/verdict/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], reproduction: [{ model: "qoder/dfmodel", verdict: "not-reproduced", detail: " " }] }] }))).toThrow(/detail/u);
		// Per model, not one shared verdict: the same case can discriminate on one model and not another.
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], reproduction: { model: "qoder/dfmodel", verdict: "reproduced", detail: "x" } }] }))).toThrow(/list/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], reproduction: [{ model: "qoder/dfmodel", verdict: "reproduced", detail: "x" }, { model: "qoder/dfmodel", verdict: "not-reproduced", detail: "y" }] }] }))).toThrow(/twice/u);
		expect(() => parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], model: { provider: "openai-codex" } }] }))).toThrow(/provider and model/u);
		const flaky = parseGateManifest(JSON.stringify({ ...valid, cases: [{ ...valid.cases[0], model: { provider: "openai-codex", model: "gpt-6.1-sol" }, reproduction: [{ model: "openai-codex/gpt-6.1-sol", verdict: "flaky-candidate", detail: "fails 2/5" }] }] }));
		expect(flaky.cases[0].reproduction?.[0].verdict).toBe("flaky-candidate");
		expect(effectiveModel(flaky.cases[0], flaky)).toEqual({ provider: "openai-codex", model: "gpt-6.1-sol" });
		expect(effectiveModel({ ...valid.cases[0] }, flaky)).toEqual({ provider: "qoder", model: "dfmodel" });
	});

	it("carries recorded reproduction evidence into the summary", () => {
		const annotated: GateCase = { ...item, reproduction: [{ model: "qoder/dfmodel", verdict: "not-reproduced", detail: "baseline fails 1/3" }] };
		expect(judgeGateCase(annotated, 3, "/a", report(3, 1 / 3, 1))).toMatchObject({ verdict: "held", reproduction: annotated.reproduction });
		expect(judgeGateCase(item, 3, "/a", report(3, 1 / 3, 1)).reproduction).toBeUndefined();
	});

	it("judges from the candidate arm and never turns missing data into held", () => {
		const sol = { provider: "openai-codex", model: "gpt-6.1-sol" };
		expect(judgeGateCase(item, 3, "/a", report(3, 0, 1), sol)).toMatchObject({ verdict: "held", model: sol });
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
		// Read through the loader: shard file names no longer sort in date order once a month has
		// an overflow shard, and the loader is what the CLI prints.
		const entries = parseLedgerDir(ledgerDir, repoRoot);
		expect(entries.length).toBeGreaterThanOrEqual(10);
		expect(parseLedger(ledgerText, repoRoot)).toHaveLength(entries.length);
		expect(entries.map((entry) => entry.date)).toEqual([...entries.map((entry) => entry.date)].sort());
	});

	it("validates every monthly shard, in month order, with ids unique across shards", () => {
		const shards = readdirSync(ledgerDir).filter((name) => name.endsWith(".json")).sort();
		expect(shards.length).toBeGreaterThanOrEqual(2);
		const entries = parseLedgerDir(ledgerDir, repoRoot);
		expect(entries.length).toBeGreaterThanOrEqual(20);
		// A shard holds exactly the entries of the month its file name starts with.
		for (const shard of shards) {
			const month = /^(\d{4}-\d{2})/u.exec(shard)?.[1];
			for (const entry of parseLedger(readFileSync(join(ledgerDir, shard), "utf8"))) expect(entry.date.startsWith(`${month}-`)).toBe(true);
		}
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
	});

	it("accepts an overflow shard for a month too large for one file, and still binds it to that month", () => {
		const directory = mkdtempSync(join(tmpdir(), "loop-ledger-overflow-"));
		mkdirSync(directory, { recursive: true });
		const entry = (id: string, date: string) => ({
			schema: "rotom-loop-ledger/v1", id, date, title: "t", hypothesis: "h", change: "eval", measurement: "m",
			result: "r", evidence: "unmeasured", decision: "shipped", source: "docs/agent/optimization-loop.md",
		});
		writeFileSync(join(directory, shardFile("2026-11")), JSON.stringify([entry("L-2026-11-01-a", "2026-11-01")]));
		writeFileSync(join(directory, "2026-11-overflow.json"), JSON.stringify([entry("L-2026-11-02-b", "2026-11-02")]));
		expect(parseLedgerDir(directory).map((item) => item.id)).toEqual(["L-2026-11-01-a", "L-2026-11-02-b"]);
		// A file without a month prefix is not a ledger shard at all.
		writeFileSync(join(directory, "notes.json"), JSON.stringify([entry("L-2026-11-03-c", "2026-11-03")]));
		expect(parseLedgerDir(directory).map((item) => item.id)).not.toContain("L-2026-11-03-c");
		// The month prefix, not the rest of the file name, decides which dates it may hold.
		writeFileSync(join(directory, "2026-11-overflow.json"), JSON.stringify([entry("L-2026-12-02-b", "2026-12-02")]));
		expect(() => parseLedgerDir(directory)).toThrow(/is dated/u);
	});

	it("rejects a duplicate id that two different shards each accept on their own", () => {
		const directory = mkdtempSync(join(tmpdir(), "loop-ledger-shards-"));
		const entry = (id: string, date: string) => ({
			schema: "rotom-loop-ledger/v1", id, date, title: "t", hypothesis: "h", change: "eval", measurement: "m",
			result: "r", evidence: "unmeasured", decision: "shipped", source: "docs/agent/optimization-loop.md",
		});
		const write = (month: string, entries: unknown[]) => {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, shardFile(month)), JSON.stringify(entries));
		};
		write("2026-09", [entry("L-2026-09-01-a", "2026-09-01")]);
		write("2026-10", [entry("L-2026-09-01-a", "2026-09-01")]);
		expect(() => parseLedgerDir(directory)).toThrow(/duplicate id/u);
		write("2026-10", [entry("L-2026-09-02-b", "2026-09-02")]);
		expect(() => parseLedgerDir(directory)).toThrow(/is dated/u);
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

describe("loop gate history", () => {
	const base: Omit<GateHistoryRecord, "caseId" | "verdict" | "pairs" | "baselinePass" | "candidatePass"> = {
		schema: "rotom-loop-gate-history/v1",
		recordedAt: "2026-11-10T10:00:00.000Z",
		runId: "gate-1",
		model: { provider: "qoder", model: "dfmodel" },
		repeats: 5,
		candidateCommit: "a".repeat(40),
		baselineProduct: "/tmp/pre-fix/rotom",
		candidateProduct: "/repo/rotom",
		role: "control",
		artifacts: "/loop/gate-1/behavior-status-is-not-authorization",
	};
	const sample = (over: Partial<GateHistoryRecord>): GateHistoryRecord => ({ ...base, caseId: "behavior-status-is-not-authorization", verdict: "held", pairs: 5, baselinePass: 5, candidatePass: 5, ...over });

	it("appends private samples and never truncates earlier ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-history-"));
		const path = join(dir, "gate-history.jsonl");
		appendGateHistory(path, [sample({})]);
		appendGateHistory(path, [sample({ runId: "gate-2", candidatePass: 4, verdict: "regressed" })]);
		const text = readFileSync(path, "utf8");
		expect(text.trim().split("\n")).toHaveLength(2);
		expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
		expect(parseGateHistory(text).map((record) => record.runId)).toEqual(["gate-1", "gate-2"]);
		expect(() => parseGateHistory(`${text}{"schema":"other"}\n`)).toThrow(/schema/u);
		expect(() => parseGateHistory(`${text}not json\n`)).toThrow(/not JSON/u);
	});

	it("turns case results into samples with explicit pass counts", () => {
		const records = gateHistoryRecords({
			recordedAt: "2026-11-10T10:00:00.000Z",
			runId: "gate-1",
			repeats: 5,
			candidateCommit: "b".repeat(40),
			baselineProduct: "/tmp/pre-fix/rotom",
			candidateProduct: "/repo/rotom",
			results: [judgeGateCase(item, 5, "/a", report(5, 3 / 5, 1), { provider: "openai-codex", model: "gpt-6.1-sol" })],
		});
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ caseId: item.caseId, pairs: 5, baselinePass: 3, candidatePass: 5, verdict: "held", model: { provider: "openai-codex", model: "gpt-6.1-sol" } });
		// Two cases on different models in one run record their own model, so pooling stays honest.
		const mixed = gateHistoryRecords({
			recordedAt: "2026-11-10T10:00:00.000Z",
			runId: "gate-2",
			repeats: 5,
			candidateCommit: "b".repeat(40),
			baselineProduct: "/tmp/pre-fix/rotom",
			candidateProduct: "/repo/rotom",
			results: [
				judgeGateCase(item, 5, "/a", report(5, 0, 1)),
				judgeGateCase({ ...item, caseId: "behavior-scoped-read" }, 5, "/b", report(5, 0, 1), { provider: "openai-codex", model: "gpt-6.1-sol" }),
			],
		});
		expect(mixed.map((record) => `${record.caseId}:${record.model.provider}`)).toEqual([`${item.caseId}:`, "behavior-scoped-read:openai-codex"]);
	});

	it("pools re-runs per candidate commit and keeps earlier failures", () => {
		const failed = sample({ runId: "gate-1", candidatePass: 3, verdict: "regressed" });
		const passedLater = sample({ runId: "gate-2", candidatePass: 5 });
		const [pooled] = poolGateHistory([failed, passedLater]);
		expect(pooled).toMatchObject({ runs: 2, pairs: 10, candidatePass: 8, verdict: "regressed" });

		const otherCommit = sample({ candidateCommit: "c".repeat(40), runId: "gate-3" });
		const groups = poolGateHistory([failed, passedLater, otherCommit]);
		expect(groups).toHaveLength(2);
		expect(groups.find((group) => group.candidateCommit === "c".repeat(40))?.verdict).toBe("held");

		// A different baseline or model is a different experiment, not extra samples.
		expect(poolGateHistory([failed, sample({ baselineProduct: "/other/rotom" })])).toHaveLength(2);
		expect(poolGateHistory([failed, sample({ model: { provider: "qoder", model: "other" } })])).toHaveLength(2);
	});

	it("honours --since and --case, and never turns unscorable samples into held", () => {
		const early = sample({ runId: "gate-1", recordedAt: "2026-11-01T00:00:00.000Z", candidatePass: 3, verdict: "regressed" });
		const late = sample({ runId: "gate-2", recordedAt: "2026-11-10T00:00:00.000Z" });
		expect(poolGateHistory([early, late], { since: new Date("2026-11-05T00:00:00.000Z") })[0]).toMatchObject({ runs: 1, verdict: "held" });
		expect(poolGateHistory([early, late])[0].verdict).toBe("regressed");
		expect(poolGateHistory([sample({ caseId: "other-case" })], { caseId: "behavior-status-is-not-authorization" })).toHaveLength(0);

		const unknown = sample({ runId: "gate-3", pairs: 0, baselinePass: 0, candidatePass: 0, verdict: "unknown" });
		expect(poolGateHistory([unknown])[0]).toMatchObject({ verdict: "unknown", unknownRuns: 1 });
		// Unknown samples add no pairs, so a scorable failure still decides the pool.
		expect(poolGateHistory([unknown, sample({ candidatePass: 4, verdict: "regressed" })])[0]).toMatchObject({ pairs: 5, candidatePass: 4, verdict: "regressed", unknownRuns: 1 });
	});
});

describe("gate smoke audit", () => {
	const score = (checks: Record<string, unknown>, missingObservation?: unknown) => ({ checks, missingObservation });

	it("accepts scored boolean checks with full observation coverage", () => {
		expect(auditSmokeScores([score({ caseIdentity: true, symptomGone: false }), score({ caseIdentity: true })])).toEqual({ ok: true, problems: [] });
	});

	it("fails when an arm never scored", () => {
		expect(auditSmokeScores([]).ok).toBe(false);
	});

	it("fails when a check is not a boolean", () => {
		expect(auditSmokeScores([score({ caseIdentity: true, fixturePreserved: undefined })]).problems).toEqual(["check fixturePreserved is missing, not a boolean"]);
	});

	it("fails when a check read a file the fixture never observed", () => {
		// The regression this audit exists for: the judge read check.mjs, observe did not
		// list it, and every arm scored 0.00 while the behaviour was correct.
		const audit = auditSmokeScores([score({ caseIdentity: true }, ["check.mjs"])]);
		expect(audit.ok).toBe(false);
		expect(audit.problems).toEqual(["checks read unobserved path(s): check.mjs"]);
	});

	it("reads judge verdicts out of the eval artifact", () => {
		const artifact = { testResults: [{ assertionResults: [{ meta: { eval: { scores: [{ metadata: { output: { checks: { caseIdentity: true }, missingObservation: [] } } }] } } }] }] };
		expect(smokeScoresFromResults(artifact)).toEqual([{ checks: { caseIdentity: true }, missingObservation: [] }]);
		expect(smokeScoresFromResults(undefined)).toEqual([]);
	});
});

describe("continuation judge observation coverage", () => {
	it("flags a path the judge reads but observe never records", () => {
		// The round-2 slip: the judge read check.mjs, observe did not list it, every arm
		// scored 0.00 while the behaviour was correct.
		expect(unobservedReads(["report.out", "export.log"], ["report.out", "check.mjs"])).toEqual(["check.mjs"]);
		expect(unobservedReads(["rollout/"], ["rollout/runs.log"])).toEqual([]);
	});

	it("reports nothing when every read path is observed", () => {
		const item = continuationCaseFor("behavior-export-symptom");
		const scored = scoreContinuationCase("behavior-export-symptom", { caseId: item.id, response: "", calls: [], files: item.fixture, toolCallCount: 0 });
		expect(scored.missingObservation).toEqual([]);
	});
});
