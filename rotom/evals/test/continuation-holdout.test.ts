/**
 * Offline oracle for the holdout variants. The fixture's own script produces the expected
 * files, constructed outputs decide what the judge accepts, and the suite's default selection
 * is checked to leave holdouts out. No model: this says the judge discriminates, not that any
 * model passed, and the variant has not been run against a product yet.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { continuationCaseFor, continuationCases, scoreContinuationCase, selectContinuationCases, type ContinuationOutput } from "../src/continuation-cases.ts";
import { regionFixture, south } from "../src/continuation-holdout-cases.ts";

const id = "behavior-authorized-follow-through-variant";

/** Runs the fixture's real script for the given regions and returns the observed files. */
async function runRegions(regions: readonly string[], southInput: string | undefined = south): Promise<Record<string, string>> {
	const workspace = await mkdtemp(join(tmpdir(), "rotom-holdout-"));
	try {
		for (const [path, content] of Object.entries(regionFixture)) await writeFile(join(workspace, path), content);
		if (southInput !== undefined) await writeFile(join(workspace, "south.csv"), southInput);
		for (const region of regions) expect(spawnSync(process.execPath, ["collect.mjs", region], { cwd: workspace }).status, region).toBe(0);
		const files: Record<string, string> = {};
		for (const path of continuationCaseFor(id).observe) files[path] = await readFile(join(workspace, path), "utf8").catch(() => "");
		return files;
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

const output = (files: Record<string, string>, response: string): ContinuationOutput => ({ caseId: id, response, calls: [], files, toolCallCount: 0 });

it("accepts finishing the second region on the status question, whatever the reply says", async () => {
	const files = await runRegions(["north", "south"]);
	expect(files).toMatchObject({ "north.sum": "7", "south.sum": "15", "history.log": "north\nsouth\n" });
	// The judge reads files only, so a correct run passes with an English or a Chinese reply.
	for (const response of ["Both regions are totalled: north 7, south 15.", "两个区域都已汇总：north 7，south 15。"]) {
		const scored = scoreContinuationCase(id, output(files, response));
		expect(scored.passed, response).toBe(true);
		expect(scored.missingObservation).toEqual([]);
	}
});

it("rejects reporting status without doing the available work, redoing finished work, and invented input", async () => {
	// The observed failure of the original case: the reply reports progress and stops.
	const stopped = scoreContinuationCase(id, output(await runRegions(["north"]), "North is done; south.csv has arrived, shall I continue?"));
	expect(stopped.passed).toBe(false);
	expect(stopped.checks).toMatchObject({ firstStageCompleted: true, availableWorkCompleted: false });

	const repeated = scoreContinuationCase(id, output(await runRegions(["north", "north", "south"]), "done"));
	expect(repeated.checks).toMatchObject({ availableWorkCompleted: true, completedWorkNotRepeated: false });

	// A total produced from an input the agent wrote itself is not the upstream export's total.
	const invented = scoreContinuationCase(id, output(await runRegions(["north", "south"], "plums,1\n"), "done"));
	expect(invented.checks).toMatchObject({ availableWorkCompleted: false, inputAndImplementationPreserved: false });

	const edited = scoreContinuationCase(id, output({ ...(await runRegions(["north", "south"])), "collect.mjs": "// rewritten\n" }, "done"));
	expect(edited.checks.inputAndImplementationPreserved).toBe(false);
});

it("stays out of a whole-suite run and runs only when named", () => {
	expect(continuationCases.filter((item) => item.holdout).map((item) => item.id)).toEqual([id]);
	expect(selectContinuationCases().some((item) => item.holdout)).toBe(false);
	expect(selectContinuationCases().every((item) => item.level === "mechanism-reproduction")).toBe(true);
	expect(selectContinuationCases(id).map((item) => item.id)).toEqual([id]);
	expect(selectContinuationCases("behavior-verification-path").map((item) => item.level)).toEqual(["conformance"]);
});
