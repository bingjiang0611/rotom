import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGateManifest } from "../src/loop/gate.ts";
import { countVerdicts, parseReplayCases, replayCaseSummaries, replayGateProducts, replayGateVerdict, validateReplayCase } from "../src/loop/replay-gate.ts";

function casesDir() {
	const dir = mkdtempSync(join(tmpdir(), "replay-cases-"));
	writeFileSync(join(dir, "check.sh"), "exit 1\n");
	for (const [name, kind] of [["zh", "zh"], ["alt", "alternative"]]) {
		writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify({ type: "message", id: "aaaaaaaa", message: { role: "assistant", content: [{ type: "text", text: kind }] } })}\n`);
	}
	return dir;
}

/** The two answers every case must carry before its check may be used. */
const answers = (dir: string) => [
	{ label: "中文答案", kind: "zh", session: join(dir, "zh.jsonl"), cut: "aaaaaaaa" },
	{ label: "different route", kind: "alternative", session: join(dir, "alt.jsonl"), cut: "aaaaaaaa" },
];

/** Built at run time so the repository never carries a personal home path. */
const HOME_PATH = ["", "Users", "someone"].join("/");

const valid = (dir: string) => JSON.stringify({
	schema: "rotom-loop-replay-cases/v1",
	cases: [{ id: "replay-one", incident: "01a13eb3-818e-705e-ba57-2464f351ba33:bdf0b669", check: join(dir, "check.sh"), mechanism: "answers with a reading guide instead of opening the package", answers: answers(dir) }],
});

describe("parseReplayCases", () => {
	it("accepts a case whose check lives in the private case directory", () => {
		const dir = casesDir();
		expect(parseReplayCases(valid(dir), dir)).toHaveLength(1);
	});

	it("refuses a check outside the case directory so nothing else is executed", () => {
		const dir = casesDir();
		const text = JSON.stringify({ schema: "rotom-loop-replay-cases/v1", cases: [{ id: "replay-one", incident: "01a13eb3-818e-705e-ba57-2464f351ba33:bdf0b669", check: "/bin/echo", mechanism: "x" }] });
		expect(() => parseReplayCases(text, dir)).toThrow(/absolute path inside/u);
	});

	it("refuses a mechanism summary that carries a local path", () => {
		const dir = casesDir();
		const text = JSON.stringify({ schema: "rotom-loop-replay-cases/v1", cases: [{ id: "replay-one", incident: "01a13eb3-818e-705e-ba57-2464f351ba33:bdf0b669", check: join(dir, "check.sh"), mechanism: `opens ${HOME_PATH}/project` }] });
		expect(() => parseReplayCases(text, dir)).toThrow(/must not carry a local path/u);
	});

	it("refuses an unregistered shape: bad incident, duplicate id, missing mechanism", () => {
		const dir = casesDir();
		const base = { id: "replay-one", incident: "01a13eb3-818e-705e-ba57-2464f351ba33:bdf0b669", check: join(dir, "check.sh"), mechanism: "m", answers: answers(dir) };
		const wrap = (cases: unknown[]) => JSON.stringify({ schema: "rotom-loop-replay-cases/v1", cases });
		expect(() => parseReplayCases(wrap([{ ...base, incident: "nope" }]), dir)).toThrow(/incident/u);
		expect(() => parseReplayCases(wrap([base, base]), dir)).toThrow(/duplicate/u);
		expect(() => parseReplayCases(wrap([{ ...base, mechanism: "  " }]), dir)).toThrow(/mechanism/u);
	});
});

describe("current-only weekly replay", () => {
	it("selects exactly the current product; default comparison mode retains both arms", () => {
		expect(replayGateProducts("/daily", "/frozen", true)).toEqual([{ label: "candidate", directory: "/daily" }]);
		expect(replayGateProducts("/daily", "/frozen")).toEqual([{ label: "frozen", directory: "/frozen" }, { label: "candidate", directory: "/daily" }]);
	});
	it("checks the existing oracle without crediting an improvement or treating unknown as pass", () => {
		const absent = { pass: 0, fail: 0, unknown: 0 };
		expect(replayGateVerdict(absent, { pass: 3, fail: 0, unknown: 0 }, true)).toBe("held");
		expect(replayGateVerdict(absent, { pass: 2, fail: 1, unknown: 0 }, true)).toBe("regressed");
		expect(replayGateVerdict(absent, { pass: 2, fail: 0, unknown: 1 }, true)).toBe("unknown");
		expect(replayGateVerdict(absent, absent, true)).toBe("unknown");
		expect(replayGateVerdict(absent, { pass: 3, fail: 0, unknown: 0 })).toBe("unknown");
	});
});

describe("replayGateVerdict", () => {
	it("treats a failing candidate as regressed", () => {
		expect(replayGateVerdict({ pass: 0, fail: 1, unknown: 0 }, { pass: 0, fail: 1, unknown: 0 })).toBe("regressed");
	});

	it("never counts a product that did not start, or a run with no verdict, as a pass", () => {
		expect(replayGateVerdict({ pass: 1, fail: 0, unknown: 0 }, { pass: 0, fail: 0, unknown: 1 })).toBe("unknown");
		expect(replayGateVerdict({ pass: 1, fail: 0, unknown: 0 }, { pass: 0, fail: 0, unknown: 0 })).toBe("unknown");
	});

	it("refuses to credit a candidate when the frozen product no longer fails the case", () => {
		expect(replayGateVerdict({ pass: 1, fail: 0, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 })).toBe("unknown");
	});

	it("holds when the frozen product fails and the candidate does not", () => {
		expect(replayGateVerdict({ pass: 0, fail: 1, unknown: 0 }, { pass: 1, fail: 0, unknown: 0 })).toBe("held");
	});

	it("counts check verdicts without inventing one", () => {
		expect(countVerdicts([{ check: "pass" }, { check: "fail" }, { check: "unknown" }, { check: "silly" }])).toEqual({ pass: 1, fail: 1, unknown: 2 });
	});
});

describe("replay cases in the committed gate manifest", () => {
	const manifest = (replays: unknown) => JSON.stringify({
		schema: "rotom-loop-gate/v1",
		model: { provider: "qoder", model: "dfmodel" },
		repeats: 3,
		cases: [{ suite: "cases/x.eval.ts", caseId: "c", role: "reproduced", enableEnv: "ROTOM_EVAL_A", caseEnv: "ROTOM_EVAL_B", repeatsEnv: "ROTOM_EVAL_C", ledger: "L-2026-11-10-x" }],
		replays,
	});

	it("keeps only an id, the kind and a de-identified summary", () => {
		const parsed = parseGateManifest(manifest([{ id: "replay-one", kind: "replay", mechanism: "answers instead of opening the package" }]));
		expect(parsed.replays).toEqual([{ id: "replay-one", kind: "replay", mechanism: "answers instead of opening the package" }]);
	});

	it("rejects a summary that would put a local path into the repo", () => {
		expect(() => parseGateManifest(manifest([{ id: "replay-one", kind: "replay", mechanism: `a printed ${HOME_PATH}/session` }]))).toThrow(/local path/u);
	});

	it("rejects a case that is not a replay", () => {
		expect(() => parseGateManifest(manifest([{ id: "replay-one", kind: "prompt", mechanism: "m" }]))).toThrow(/kind must be replay/u);
	});

	it("summarises the private file for the manifest without its incident or check", () => {
		const dir = casesDir();
		expect(replayCaseSummaries(parseReplayCases(valid(dir), dir))).toEqual([
			{ id: "replay-one", kind: "replay", mechanism: "answers with a reading guide instead of opening the package" },
		]);
	});
});

describe("validateReplayCase", () => {
	const dir = casesDir();
	const item = { id: "replay-one", incident: "01a13eb3-818e-705e-ba57-2464f351ba33:bdf0b669", check: join(dir, "check.sh"), mechanism: "m", answers: answers(dir) } as never;
	writeFileSync(join(dir, "original.jsonl"), "{}\n");
	const original = { session: join(dir, "original.jsonl"), cut: "aaaaaaaa" };

	it("accepts a check that rejects the failure and accepts both answers", () => {
		const codes = new Map<string, number>([[join(dir, "zh.jsonl"), 0], [join(dir, "alt.jsonl"), 0]]);
		const validation = validateReplayCase(item, original, ({ REPLAY_SESSION }) => codes.get(REPLAY_SESSION) ?? 1);
		expect(codes.get(join(dir, "zh.jsonl"))).toBe(0);
		expect(validation.usable).toBe(true);
		expect(validation.detail).toMatch(/zh answer/u);
	});

	it("refuses a check that rejects a correct answer", () => {
		const validation = validateReplayCase(item, original, ({ REPLAY_SESSION }) => (REPLAY_SESSION.endsWith("alt.jsonl") ? 1 : 0));
		expect(validation.usable).toBe(false);
		expect(validation.detail).toMatch(/alternative answer different route: rejected/u);
	});

	it("refuses a check that also passes the original trajectory", () => {
		const runs = new Map<string, number>([[join(dir, "zh.jsonl"), 0], [join(dir, "alt.jsonl"), 0]]);
		const validation = validateReplayCase(item, original, ({ REPLAY_SESSION }) => (REPLAY_SESSION === original.session ? 0 : (runs.get(REPLAY_SESSION) ?? 1)));
		expect(validation.usable).toBe(false);
		expect(validation.detail).toMatch(/original trajectory: not rejected/u);
	});
});
