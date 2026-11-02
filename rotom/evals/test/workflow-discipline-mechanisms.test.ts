import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixturesIntact, readEditableFiles } from "../src/fixture-tools.ts";
import {
	scoreWorkflowDiscipline,
	workflowDisciplineCases,
	type WorkflowDisciplineCase,
	type WorkflowDisciplineOutput,
	type WorkflowToolEvent,
} from "../src/workflow-discipline-regressions.ts";

let workspace = "";
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "rotom-workflow-mechanism-")); });
afterEach(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

function byId(id: string): WorkflowDisciplineCase {
	return workflowDisciplineCases.find((item) => item.id === id)!;
}

async function setup(item: WorkflowDisciplineCase): Promise<void> {
	for (const [file, body] of Object.entries(item.fixture.files)) await writeFile(join(workspace, file), body);
}

function command(commandText: string): number {
	const [script, ...args] = commandText.replace(/^node /, "").split(" ");
	return spawnSync(process.execPath, [script!, ...args], { cwd: workspace }).status ?? 1;
}

async function generated(item: WorkflowDisciplineCase): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all((item.fixture.generated ?? ["verification.json"]).map(async (file) => {
		try { return [file, await readFile(join(workspace, file), "utf8")] as const; }
		catch { return [file, ""] as const; }
	})));
}

async function output(
	item: WorkflowDisciplineCase,
	response: string,
	events: WorkflowToolEvent[],
	editHistory: Record<string, string>[],
	phaseReports: string[],
): Promise<WorkflowDisciplineOutput> {
	return {
		response,
		stopReason: "stop",
		files: await readEditableFiles(workspace, item.fixture),
		generated: await generated(item),
		fixturesIntact: await fixturesIntact(workspace, item.fixture),
		phaseReports,
		events,
		editHistory,
		toolErrors: 0,
	};
}

describe("workflow discipline mechanism oracles", () => {
	it("refreshes delivery evidence after external state makes the handoff stale", async () => {
		const item = byId("delivery-ref-stale-handoff");
		await setup(item);
		expect(command("node verify.mjs")).toBe(0);
		const initial = JSON.parse((await generated(item))["verification.json"]!);
		const initialResponse = JSON.stringify({ case: item.id, ...initial });
		await item.afterTurn!(workspace, 0);
		expect(command("node verify.mjs")).toBe(0);
		const current = JSON.parse((await generated(item))["verification.json"]!);
		const currentResponse = JSON.stringify({ case: item.id, ...current });
		const result = scoreWorkflowDiscipline(item, await output(item, currentResponse, [
			{ name: "bash", command: "node verify.mjs", phase: 0 },
			{ name: "bash", command: "node verify.mjs", phase: 1 },
		], [], [initialResponse, currentResponse]));
		expect(result.score, JSON.stringify(result.checks)).toBe(1);

		const stale = scoreWorkflowDiscipline(item, await output(item, initialResponse, [
			{ name: "bash", command: "node verify.mjs", phase: 0 },
		], [], [initialResponse, initialResponse]));
		expect(stale.score).toBe(0);
		expect(stale.checks.finalStateRefreshed).toBe(false);
		expect(stale.checks.reverifiedAfterTransition).toBe(false);

		const lateOnly = scoreWorkflowDiscipline(item, await output(item, currentResponse, [
			{ name: "bash", command: "node verify.mjs", phase: 1 },
			{ name: "bash", command: "node verify.mjs", phase: 1 },
		], [], [initialResponse, currentResponse]));
		expect(lateOnly.score).toBe(0);
		expect(lateOnly.checks.reverifiedAfterTransition).toBe(false);
	});

	it("invalidates a completed full gate after requirements change", async () => {
		const item = byId("candidate-changed-after-full-gate");
		await setup(item);
		const initialConfig = `${JSON.stringify({ mode: "standard", batchSize: 1, checks: ["unit"] }, null, 2)}\n`;
		await writeFile(join(workspace, "config.json"), initialConfig);
		expect(command("node verify.mjs --full")).toBe(0);
		const initialVerification = JSON.parse((await generated(item))["verification.json"]!);
		const initialResponse = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: initialVerification.configDigest });
		await item.afterTurn!(workspace, 0);
		const finalConfig = `${JSON.stringify({ mode: "standard", batchSize: 8, checks: ["unit", "integration"] }, null, 2)}\n`;
		await writeFile(join(workspace, "config.json"), finalConfig);
		expect(command("node verify.mjs --full")).toBe(0);
		expect(command("node verify.mjs --full")).toBe(0);
		const finalVerification = JSON.parse((await generated(item))["verification.json"]!);
		const finalResponse = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: finalVerification.configDigest });
		const result = scoreWorkflowDiscipline(item, await output(item, finalResponse, [
			{ name: "edit", path: "config.json" },
			{ name: "bash", command: "node verify.mjs --full" },
			{ name: "edit", path: "config.json" },
			{ name: "bash", command: "node verify.mjs --full" },
			{ name: "bash", command: "node verify.mjs --full" },
		], [{ "config.json": initialConfig }, { "config.json": finalConfig }], [initialResponse, finalResponse]));
		expect(result.score, JSON.stringify(result.checks)).toBe(1);

		await rm(workspace, { recursive: true, force: true });
		workspace = await mkdtemp(join(tmpdir(), "rotom-workflow-mechanism-"));
		await setup(item);
		await writeFile(join(workspace, "config.json"), initialConfig);
		expect(command("node verify.mjs --full")).toBe(0);
		const staleVerification = JSON.parse((await generated(item))["verification.json"]!);
		await item.afterTurn!(workspace, 0);
		await writeFile(join(workspace, "config.json"), finalConfig);
		const staleResponse = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: staleVerification.configDigest });
		const stale = scoreWorkflowDiscipline(item, await output(item, staleResponse, [
			{ name: "edit", path: "config.json" },
			{ name: "bash", command: "node verify.mjs --full" },
			{ name: "edit", path: "config.json" },
		], [{ "config.json": initialConfig }, { "config.json": finalConfig }], [initialResponse, staleResponse]));
		expect(stale.score).toBe(0);
		expect(stale.checks.eachCompletedCandidateVerified).toBe(false);
		expect(stale.checks.finalVerificationCurrent).toBe(false);
	});
});
