/**
 * Operating the loop: holdout cases, per-case repeats, the frozen baseline and the status
 * screen. No model and no network; git and npm are replaced by a recording fake.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { freezeBaseline, latestFrozen, type Run } from "../src/loop/freeze.ts";
import { effectiveModel, gateVerdict, judgeGateCase, parseGateManifest, repeatsFor, selectGateCases, type GateCase, type GateManifest } from "../src/loop/gate.ts";
import { gateHistoryRecords, poolGateHistory, type GateHistoryRecord } from "../src/loop/gate-history.ts";
import type { PreflightProblem } from "../src/loop/gate-preflight.ts";
import type { LedgerEntry } from "../src/loop/ledger.ts";
import { buildStatus, parseWeeklySnapshot, renderStatus } from "../src/loop/status.ts";
import { parseWeeklyConfig } from "../src/loop/weekly.ts";

const evalsRoot = resolve(import.meta.dirname, "..");
const checkedIn = JSON.parse(readFileSync(resolve(evalsRoot, "loop/gate.json"), "utf8")) as GateManifest;

const tuned: GateCase = {
	suite: "cases/continuation-regression.eval.ts",
	caseId: "tuned-case",
	role: "reproduced",
	enableEnv: "ROTOM_EVAL_CONTINUATION",
	caseEnv: "ROTOM_EVAL_CONTINUATION_CASE",
	repeatsEnv: "ROTOM_EVAL_CONTINUATION_REPEATS",
	ledger: "L-2026-11-24-example",
};
const holdout: GateCase = { ...tuned, caseId: "tuned-case-variant", split: "holdout", variantOf: "tuned-case" };
const keep: GateCase = { ...tuned, caseId: "keep-case", role: "control", repeats: 1 };
const manifest = (cases: GateCase[]): GateManifest => parseGateManifest(JSON.stringify({ schema: "rotom-loop-gate/v1", model: { provider: "qoder", model: "dfmodel" }, repeats: 3, cases }));
const report = (pairs: number, baseline: number, candidate: number) => ({ evalSets: [{ evalSet: "x", comparisons: [{ correctness: { eligiblePairs: pairs, baselinePassRate: baseline, candidatePassRate: candidate } }] }], diagnostics: [] });

describe("holdout cases", () => {
	it("are skipped unless asked for, so tuning a fix never looks at them", () => {
		const value = manifest([tuned, holdout, keep]);
		expect(selectGateCases(value, {}).map((item) => item.caseId)).toEqual(["tuned-case", "keep-case"]);
		expect(selectGateCases(value, { holdout: true }).map((item) => item.caseId)).toEqual(["tuned-case", "tuned-case-variant", "keep-case"]);
		// Naming a holdout without the flag is refused rather than silently run or silently skipped.
		expect(() => selectGateCases(value, { only: "tuned-case-variant" })).toThrow(/pass --holdout/u);
		expect(selectGateCases(value, { only: "tuned-case-variant", holdout: true })).toHaveLength(1);
		expect(() => selectGateCases(value, { only: "missing" })).toThrow(/no gate case matches/u);
	});

	it("runs every checked-in case on qoder/dfmodel, the only model the loop uses since 2026-11-25", () => {
		const value = parseGateManifest(JSON.stringify(checkedIn));
		expect(value.cases.map((item) => effectiveModel(item, value))).toEqual(value.cases.map(() => ({ provider: "qoder", model: "dfmodel" })));
	});

	it("leaves the default run of the checked-in manifest free of holdouts", () => {
		const value = parseGateManifest(JSON.stringify(checkedIn));
		expect(selectGateCases(value, {}).every((item) => item.split === undefined)).toBe(true);
		expect(selectGateCases(value, { holdout: true })).toHaveLength(value.cases.length);
	});

	it("must restate a tuned case, and cannot be the only reproduced case", () => {
		expect(() => manifest([tuned, { ...holdout, variantOf: undefined }])).toThrow(/variantOf/u);
		expect(() => manifest([{ ...tuned, variantOf: "tuned-case" }])).toThrow(/only a holdout/u);
		expect(() => manifest([tuned, { ...holdout, variantOf: "nowhere" }])).toThrow(/variantOf must name/u);
		expect(() => manifest([tuned, holdout, { ...holdout, caseId: "second", variantOf: "tuned-case-variant" }])).toThrow(/not itself a holdout/u);
		expect(() => manifest([{ ...tuned, split: "train" as never }])).toThrow(/split/u);
		// A manifest whose only reproduced case is a holdout would gate nothing by default.
		expect(() => manifest([keep, { ...holdout, variantOf: "keep-case" }])).toThrow(/at least one reproduced/u);
	});

	it("is reported beside the verdict instead of deciding it", () => {
		const results = [judgeGateCase(tuned, 3, "/a", report(3, 0, 1)), judgeGateCase(holdout, 3, "/b", report(3, 0, 2 / 3))];
		expect(results[1]).toMatchObject({ split: "holdout", verdict: "regressed" });
		expect(results[0]?.split).toBeUndefined();
		expect(gateVerdict(results.filter((result) => result.split !== "holdout"))).toBe("held");
		const records = gateHistoryRecords({ recordedAt: "2026-11-24T10:00:00.000Z", runId: "gate-1", candidateCommit: "b".repeat(40), baselineProduct: "/base/rotom", candidateProduct: "/repo/rotom", results });
		expect(records.map((record) => record.split)).toEqual([undefined, "holdout"]);
		expect(poolGateHistory(records).map((group) => [group.caseId, group.split, group.verdict])).toEqual([["tuned-case", undefined, "held"], ["tuned-case-variant", "holdout", "regressed"]]);
	});
});

describe("per-case repeats", () => {
	it("orders smoke, --repeats, the case and the manifest", () => {
		const value = manifest([tuned, keep]);
		expect(repeatsFor(tuned, { manifest: value })).toBe(3);
		expect(repeatsFor(keep, { manifest: value })).toBe(1);
		expect(repeatsFor(keep, { manifest: value, repeats: 5 })).toBe(5);
		expect(repeatsFor(tuned, { manifest: value, repeats: 5, smoke: true })).toBe(1);
		expect(() => manifest([{ ...tuned, repeats: 0 }])).toThrow(/repeats/u);
		expect(() => manifest([{ ...tuned, repeats: 6 }])).toThrow(/repeats/u);
	});

	it("records the count each case actually ran", () => {
		const records = gateHistoryRecords({ recordedAt: "2026-11-24T10:00:00.000Z", runId: "gate-1", candidateCommit: "b".repeat(40), baselineProduct: "/base/rotom", candidateProduct: "/repo/rotom", results: [judgeGateCase(tuned, 3, "/a", report(3, 0, 1)), judgeGateCase(keep, 1, "/b", report(1, 1, 1))] });
		expect(records.map((record) => record.repeats)).toEqual([3, 1]);
	});
});

describe("frozen baseline", () => {
	const sha = "a".repeat(40);
	function setup(installed: boolean) {
		const loopDir = mkdtempSync(join(tmpdir(), "rotom-freeze-"));
		const calls: string[][] = [];
		let ready = installed;
		const run: Run = (command, args) => {
			calls.push([command, ...args]);
			if (command === "git" && args.includes("rev-parse")) return { status: 0, stdout: `${sha}\n` };
			if (command === "git" && args.includes("worktree")) {
				// What a checkout provides: the product directory with its resolver.
				mkdirSync(join(loopDir, "frozen", sha, "rotom", "runtime"), { recursive: true });
				writeFileSync(join(loopDir, "frozen", sha, "rotom", "runtime", "resolve-installed-pi.mjs"), "");
				return { status: 0, stdout: "" };
			}
			if (command === "npm") ready = true;
			return { status: 0, stdout: "" };
		};
		const problem = (directory: string): PreflightProblem => ({ label: "baseline", product: "p", directory, detail: "not installed" });
		const check = () => (ready ? [] : [problem("runtime/pi"), problem("runtime/pi"), problem("extensions/third-party")]);
		return { loopDir, calls, run, check };
	}

	it("creates the worktree, installs each named directory once and records the pointer", () => {
		const { loopDir, calls, run, check } = setup(false);
		const product = join(loopDir, "frozen", sha, "rotom");
		const frozen = freezeBaseline({ ref: "v0.2.4", repoRoot: "/repo", loopDir, run, check, now: new Date("2026-11-24T00:00:00Z") });
		expect(frozen).toMatchObject({ sha, ref: "v0.2.4", product, reused: false });
		expect(calls).toEqual([
			["git", "-C", "/repo", "rev-parse", "--verify", "--quiet", "v0.2.4^{commit}"],
			["git", "-C", "/repo", "worktree", "add", "--detach", join(loopDir, "frozen", sha), sha],
			["npm", "--prefix", join(product, "runtime/pi"), "ci", "--ignore-scripts"],
			["npm", "--prefix", join(product, "extensions/third-party"), "ci", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps"],
		]);
		expect((statSync(join(loopDir, "frozen", "latest.json")).mode & 0o777).toString(8)).toBe("600");
		expect(latestFrozen(loopDir)).toMatchObject({ sha, ref: "v0.2.4", product });

		// Freezing the same commit again resolves the ref and does nothing else.
		calls.length = 0;
		expect(freezeBaseline({ ref: "v0.2.4", repoRoot: "/repo", loopDir, run, check }).reused).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("refuses what it cannot prove instead of guessing", () => {
		const { loopDir, run, check } = setup(false);
		expect(() => freezeBaseline({ ref: "--upload-pack=x", repoRoot: "/repo", loopDir, run, check })).toThrow(/commit, tag or branch/u);
		expect(() => freezeBaseline({ ref: "nope", repoRoot: "/repo", loopDir, run: () => ({ status: 1, stdout: "" }), check })).toThrow(/not a commit/u);
		// An install that leaves the product inconsistent is reported with the directory to fix.
		expect(() => freezeBaseline({ ref: "main", repoRoot: "/repo", loopDir, run: (command, args) => (command === "npm" ? { status: 0, stdout: "" } : run(command, args)), check: () => check().slice(0, 1) })).toThrow(/reinstall/u);
		expect(() => freezeBaseline({ ref: "main", repoRoot: "/repo", loopDir, run: (command, args) => (command === "npm" ? { status: 1, stdout: "" } : run(command, args)), check: () => check().slice(0, 1) })).toThrow(/npm ci failed/u);
		// An existing directory that is not a product is left alone, never deleted.
		const other = mkdtempSync(join(tmpdir(), "rotom-freeze-"));
		mkdirSync(join(other, "frozen", sha), { recursive: true });
		expect(() => freezeBaseline({ ref: "main", repoRoot: "/repo", loopDir: other, run, check })).toThrow(/remove it yourself/u);
	});

	it("reads no pointer as none and a broken pointer as an error", () => {
		const loopDir = mkdtempSync(join(tmpdir(), "rotom-freeze-"));
		expect(latestFrozen(loopDir)).toBeUndefined();
		mkdirSync(join(loopDir, "frozen"));
		writeFileSync(join(loopDir, "frozen", "latest.json"), "{");
		expect(() => latestFrozen(loopDir)).toThrow(/not JSON/u);
		writeFileSync(join(loopDir, "frozen", "latest.json"), JSON.stringify({ schema: "rotom-loop-frozen/v1", sha, ref: "main", product: "relative/rotom", frozenAt: "x" }));
		expect(() => latestFrozen(loopDir)).toThrow(/malformed/u);
		writeFileSync(join(loopDir, "frozen", "latest.json"), JSON.stringify({ schema: "rotom-loop-frozen/v1", sha, ref: "main", product: join(loopDir, "gone", "rotom"), frozenAt: "x" }));
		expect(() => latestFrozen(loopDir)).toThrow(/is gone/u);
	});
});

describe("status", () => {
	const entry = (id: string, fields: Partial<LedgerEntry>): LedgerEntry => ({ schema: "rotom-loop-ledger/v1", id, date: id.slice(2, 12), title: id, hypothesis: "h", change: "mechanism", measurement: "m", result: "r", evidence: "unmeasured", decision: "shipped", source: "docs/agent/optimization-loop.md", ...fields });
	const ledger = [
		entry("L-2026-11-01-with-metric", { acceptance: { startedAt: "2026-11-01T00:00:00Z", metric: "x", incident: "user_repeat", baselinePer100: 5, minimumTurns: 200, expect: "lower" } }),
		entry("L-2026-11-02-no-metric", {}),
		entry("L-2026-11-03-improved", { evidence: "improved" }),
		entry("L-2026-11-04-open", { decision: "open" }),
		entry("L-2026-11-05-eval", { change: "eval" }),
	];
	const sample = (fields: Partial<GateHistoryRecord>): GateHistoryRecord => ({ schema: "rotom-loop-gate-history/v1", recordedAt: "2026-11-20T10:00:00.000Z", runId: "gate-1", model: { provider: "qoder", model: "dfmodel" }, repeats: 3, candidateCommit: "b".repeat(40), baselineProduct: "/base/rotom", candidateProduct: "/repo/rotom", caseId: "tuned-case", role: "reproduced", verdict: "held", pairs: 3, baselinePass: 1, candidatePass: 3, artifacts: "/a", ...fields });
	const now = new Date("2026-11-24T12:00:00Z");

	it("prints never-measured as no record, not as zero", () => {
		const report = buildStatus({ manifest: manifest([tuned, holdout, keep]), history: undefined, ledger, weekly: undefined, now });
		expect(report).toMatchObject({ intervention: null, daysSinceGate: null, daysSinceWeekly: null, baseline: null, climb: { total: 1, proven: 0, flaky: 0 }, keep: 1, holdout: 1, unverified: { total: 2, withoutMetric: 1 } });
		const text = renderStatus(report);
		expect(text).toContain("interventions per 100 user turns            no record");
		expect(text).toContain("days since last gate / weekly               no record / no record");
		expect(text).toContain("baseline none frozen");
		expect(report.next).toEqual([
			"run `loop weekly`: no weekly report has been written on this machine",
			"no climb case discriminates on the model it runs on: triage the harvest queue for one reproducible failure",
			"run `loop freeze <release commit>` so `loop gate` has a baseline",
			"holdout tuned-case-variant has never run: pass `--holdout` at the next judging round",
		]);
	});

	it("counts proof per recorded verdict and pools every sample of a case", () => {
		const proven: GateCase = { ...tuned, reproduction: [{ model: "qoder/dfmodel", verdict: "reproduced", detail: "fails 2/3" }, { model: "openai-codex/gpt-6.1-sol", verdict: "not-reproduced", detail: "0/5" }] };
		const flaky: GateCase = { ...tuned, caseId: "flaky-case", reproduction: [{ model: "qoder/dfmodel", verdict: "flaky-candidate", detail: "fails 1/3" }] };
		const weekly = parseWeeklySnapshot(JSON.stringify({ generatedAt: "2026-11-19T09:00:00.000Z", northStar: { overall: [{ key: "all", turns: 4132, v2: 438, v2Per100: 10.6 }] }, records: [{ id: "L-2026-11-01-with-metric", status: "improved" }, { id: "L-2026-11-02-no-metric", status: "no-metric" }, { id: "L-x", status: "insufficient-exposure" }] }));
		const report = buildStatus({
			manifest: manifest([proven, flaky]),
			history: [sample({}), sample({ recordedAt: "2026-11-22T10:00:00.000Z", runId: "gate-2", verdict: "regressed", candidatePass: 2 })],
			ledger,
			weekly,
			weeklyDay: "thursday",
			frozen: { sha: "c".repeat(40), ref: "v0.2.4" },
			now,
		});
		expect(report).toMatchObject({ climb: { total: 2, proven: 1, flaky: 1 }, daysSinceGate: 2, daysSinceWeekly: 5, intervention: { per100: 10.6, turns: 4132, reportDate: "2026-11-19" }, ready: [{ id: "L-2026-11-01-with-metric", status: "improved" }] });
		expect(report.cases[0]).toMatchObject({ last: { date: "2026-11-22", verdict: "regressed", candidatePass: 2 }, pooled: { runs: 2, pairs: 6, baselineFail: 4, candidateFail: 1 } });
		expect(report.cases[1]).toMatchObject({ last: null, pooled: null });
		expect(report.next).toEqual(["update the ledger for 1 record(s) the weekly report reached a verdict on"]);
		const text = renderStatus(report);
		expect(text).toContain("weekly day thursday");
		expect(text).toContain("climb cases that discriminate (own model)   1 of 2 (1 flaky-candidate)");
		// A reproduction on another model does not make the case discriminate where it runs.
		const elsewhere: GateCase = { ...tuned, reproduction: [{ model: "openai-codex/gpt-6.1-sol", verdict: "reproduced", detail: "fails 3/3" }] };
		expect(buildStatus({ manifest: manifest([elsewhere]), history: [], ledger: [], weekly, now }).climb).toEqual({ total: 1, proven: 0, flaky: 0 });
		expect(text).toContain("baseline cccccccccccc (v0.2.4)");
	});

	it("asks for a weekly run once the last one is a week old and treats an unreadable summary as no record", () => {
		const weekly = parseWeeklySnapshot(JSON.stringify({ generatedAt: "2026-11-17T09:00:00.000Z" }));
		expect(weekly).toEqual({ generatedAt: "2026-11-17T09:00:00.000Z", turns: null, per100: null, records: [] });
		expect(buildStatus({ manifest: manifest([tuned]), history: [], ledger: [], weekly, frozen: { sha: "c".repeat(40), ref: "main" }, now }).next[0]).toBe("run `loop weekly`: the last report is 7 days old");
		expect(parseWeeklySnapshot("not json")).toBeUndefined();
		expect(parseWeeklySnapshot(JSON.stringify({ generatedAt: "yesterday" }))).toBeUndefined();
	});

	it("reads the weekly day from the checked-in config and refuses an unknown one", () => {
		expect(parseWeeklyConfig(readFileSync(resolve(evalsRoot, "loop/weekly.json"), "utf8")).day).toBe("thursday");
		expect(parseWeeklyConfig(JSON.stringify({ switchAt: "2026-11-12T02:47:28Z" })).day).toBeUndefined();
		expect(() => parseWeeklyConfig(JSON.stringify({ switchAt: "2026-11-12T02:47:28Z", day: "someday" }))).toThrow(/day must be one of/u);
	});
});
