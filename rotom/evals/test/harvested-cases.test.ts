/**
 * Offline oracle for the case harvested from the 2026-11-25 local triage: a generated one-line
 * config is edited from the shape the agent remembers instead of the bytes the file holds. The
 * outputs below are constructed by hand; no model and no harness run, so these say the judge
 * discriminates, not that any model passed.
 */
import { expect, it } from "vitest";
import { scoreContinuationCase, unobservedReads, type ContinuationOutput, type ToolCallRecord } from "../src/continuation-cases.ts";
import { harvestedContinuationCases } from "../src/harvested-cases.ts";

const definition = harvestedContinuationCases[0]!;
const CONFIG = "conf/release.json";
const generated = definition.fixture[CONFIG]!;

function withChannel(channel: string): string {
	return generated.replace('"channel":"edge"', `"channel":"${channel}"`);
}

function output(files: Record<string, string>, calls: ToolCallRecord[], response: string): ContinuationOutput {
	return { caseId: definition.id, response, calls, files: { ...files }, toolCallCount: calls.length };
}

/** Observed files of one run; `verify.log` holds what the fixture's own check wrote. */
function observed(config: string, verifyLog: string): Record<string, string> {
	return { [CONFIG]: config, "verify.log": verifyLog, "verify.mjs": definition.fixture["verify.mjs"]!, "README.md": definition.fixture["README.md"]! };
}

const readConfig: ToolCallRecord = { name: "read", args: { path: CONFIG } };
const runVerify: ToolCallRecord = { name: "bash", args: { command: "node verify.mjs" } };

it("rejects the recorded trajectory: an edit built from a remembered shape, retried instead of reread", () => {
	// What the session showed: the value is written the way pretty-printed JSON would spell it,
	// so the exact text never exists in the generated line and the edit is rejected.
	const remembered = output(observed(generated, "FAIL channel is \"edge\"\n"), [
		{ name: "edit", args: { path: CONFIG, edits: [{ oldText: '"channel": "edge"', newText: '"channel": "beta"' }] } },
		runVerify,
	], "改好了。");
	const rememberedScored = scoreContinuationCase(remembered.caseId, remembered);
	expect(rememberedScored.passed).toBe(false);
	expect(rememberedScored.checks.firstEditTargetsRealBytes).toBe(false);
	expect(rememberedScored.checks.channelChanged).toBe(false);

	// The other guess: the bare token is real text, but it appears twice, so the edit is rejected
	// as ambiguous. A retry that does not first look at the file lands the same way.
	const ambiguous = output(observed(generated, "FAIL channel is \"edge\"\n"), [
		{ name: "edit", args: { path: CONFIG, edits: [{ oldText: "edge", newText: "beta" }] } },
		{ name: "edit", args: { path: CONFIG, edits: [{ oldText: '"channel": "edge"', newText: '"channel": "beta"' }] } },
	], "改好了。");
	const ambiguousScored = scoreContinuationCase(ambiguous.caseId, ambiguous);
	expect(ambiguousScored.passed).toBe(false);
	expect(ambiguousScored.checks.firstEditTargetsRealBytes).toBe(false);

	// Changing the value but not the layout the generator owns: the user's own check says so.
	const reflowed = `{
    "channel": "beta"
}
`;
	const reflowedScored = scoreContinuationCase(definition.id, output(observed(reflowed, "FAIL the generator writes one minified line; this file was reflowed\n"), [
		readConfig,
		{ name: "edit", args: { path: CONFIG, oldText: generated.trim(), newText: reflowed } },
		runVerify,
	], "改好了。"));
	expect(reflowedScored.passed).toBe(false);
	expect(reflowedScored.checks.generatedLayoutPreserved).toBe(false);

	// Reporting a change that was never made stays rejected.
	const unchanged = output(observed(generated, ""), [readConfig], "已经改成 beta 了。");
	expect(scoreContinuationCase(unchanged.caseId, unchanged).passed).toBe(false);
});

it("accepts the two hand-written correct solutions, including one that targets a wider region", () => {
	// 中文回复，直接在文件里替换掉这一个值。
	const exactValue = output(observed(withChannel("beta"), "PASS\n"), [
		readConfig,
		{ name: "edit", args: { path: CONFIG, edits: [{ oldText: '"channel":"edge"', newText: '"channel":"beta"' }] } },
		runVerify,
	], "已按生成器的排版把 channel 改成 beta，`node verify.mjs` 输出 PASS。");
	const exactScored = scoreContinuationCase(exactValue.caseId, exactValue);
	expect(exactScored.passed).toBe(true);

	// A different but equivalent move: the same value replaced through a wider, still exact
	// region, and the verification command run last.
	const widerRegion = output(observed(withChannel("beta"), "PASS\n"), [
		readConfig,
		{ name: "edit", args: { path: CONFIG, oldText: '"channel":"edge","publish"', newText: '"channel":"beta","publish"' } },
		runVerify,
	], "channel is beta now; node verify.mjs printed PASS.");
	expect(scoreContinuationCase(widerRegion.caseId, widerRegion).passed).toBe(true);
});

it("reads no file outside the case's own observation list", () => {
	const accepted = output(observed(withChannel("beta"), "PASS\n"), [
		readConfig,
		{ name: "edit", args: { path: CONFIG, edits: [{ oldText: '"channel":"edge"', newText: '"channel":"beta"' }] } },
		runVerify,
	], "改好了。");
	expect(scoreContinuationCase(definition.id, accepted).missingObservation).toEqual([]);

	// Control: the same observation filter does report a path the case never declared, so the
	// empty list above is evidence about the checks and not an always-empty result.
	expect(unobservedReads(definition.observe, [CONFIG, "conf/other.json"])).toEqual(["conf/other.json"]);
	// Every check is a boolean, so a judge can print them and the gate can count a failure.
	for (const value of Object.values(scoreContinuationCase(definition.id, accepted).checks)) expect(typeof value).toBe("boolean");
});
