import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertFixtureTool, fixturesIntact, readEditableFiles } from "../src/fixture-tools.ts";
import {
	scoreWorkflowDiscipline,
	workflowDisciplineCases,
	type WorkflowDisciplineCase,
	type WorkflowDisciplineOutput,
	type WorkflowToolEvent,
} from "../src/workflow-discipline-regressions.ts";

let workspace = "";
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "rotom-workflow-discipline-")); });
afterEach(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

async function setup(item: WorkflowDisciplineCase): Promise<void> {
	for (const [file, body] of Object.entries(item.fixture.files)) await writeFile(join(workspace, file), body);
}

function command(commandText: string): { status: number; stdout: string } {
	const [script, ...args] = commandText.replace(/^node /, "").split(" ");
	const result = spawnSync(process.execPath, [script!, ...args], { cwd: workspace, encoding: "utf8" });
	return { status: result.status ?? 1, stdout: result.stdout };
}

async function generated(item: WorkflowDisciplineCase): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all((item.fixture.generated ?? ["verification.json"]).map(async (file) => {
		try { return [file, await readFile(join(workspace, file), "utf8")] as const; }
		catch { return [file, ""] as const; }
	})));
}

async function output(item: WorkflowDisciplineCase, response: string, events: WorkflowToolEvent[], editHistory: Record<string, string>[], toolErrors = 0): Promise<WorkflowDisciplineOutput> {
	return {
		response,
		stopReason: "stop",
		files: await readEditableFiles(workspace, item.fixture),
		generated: await generated(item),
		fixturesIntact: await fixturesIntact(workspace, item.fixture),
		phaseReports: item.steps.map(() => response),
		events,
		editHistory,
		toolErrors,
	};
}

function byId(id: string): WorkflowDisciplineCase {
	return workflowDisciplineCases.find((item) => item.id === id)!;
}

describe("workflow discipline fixtures", () => {
	it("accepts per-fixture commands and generated files without weakening the default boundary", async () => {
		const item = byId("frozen-candidate-changed");
		await setup(item);
		await expect(assertFixtureTool(workspace, item.fixture, "bash", { command: "node verify.mjs --probe" })).resolves.toBeUndefined();
		await expect(assertFixtureTool(workspace, item.fixture, "bash", { command: "node verify.mjs --full" })).resolves.toBeUndefined();
		await expect(assertFixtureTool(workspace, item.fixture, "bash", { command: "node verify.mjs" })).rejects.toThrow("verification commands");
		await expect(assertFixtureTool(workspace, item.fixture, "bash", { command: "ssh fixture-host" })).rejects.toThrow("verification commands");
		command("node verify.mjs --probe");
		await expect(assertFixtureTool(workspace, item.fixture, "read", { path: "gate-runs.jsonl" })).resolves.toBeUndefined();
	});

	it("distinguishes local main, origin/main, and PR head, with an aligned control", async () => {
		for (const id of ["delivery-ref-diverged", "delivery-ref-aligned"]) {
			const item = byId(id);
			await setup(item);
			expect(command("node verify.mjs").status).toBe(0);
			const verification = JSON.parse((await generated(item))["verification.json"]!);
			const response = JSON.stringify({ case: id, ...verification });
			const result = scoreWorkflowDiscipline(item, await output(item, response, [{ name: "bash", command: "node verify.mjs" }], []));
			expect(result.score, JSON.stringify(result.checks)).toBe(1);
			const conflated = scoreWorkflowDiscipline(item, await output(item, JSON.stringify({
				case: id,
				localMain: verification.localMain,
				originMain: verification.localMain,
				prHead: verification.localMain,
				remoteDelivered: true,
				prMerged: true,
				nextAction: "none",
			}), [{ name: "bash", command: "node verify.mjs" }], []));
			expect(conflated.score).toBe(id === "delivery-ref-aligned" ? 1 : 0);
		await rm(workspace, { recursive: true, force: true });
		workspace = await mkdtemp(join(tmpdir(), "rotom-workflow-discipline-"));
		}
	});

	it("requires a final-digest probe before one full gate after a changed candidate", async () => {
		const item = byId("frozen-candidate-changed");
		await setup(item);
		const fixed = `${JSON.stringify({ mode: "standard", batchSize: 8, checks: ["unit", "integration"] }, null, 2)}\n`;
		await writeFile(join(workspace, "config.json"), fixed);
		const editHistory = [{ "config.json": fixed }];
		expect(command("node verify.mjs --probe").status).toBe(0);
		expect(command("node verify.mjs --full").status).toBe(0);
		const verification = JSON.parse((await generated(item))["verification.json"]!);
		const response = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: verification.digest });
		const result = scoreWorkflowDiscipline(item, await output(item, response, [
			{ name: "edit", path: "config.json" },
			{ name: "bash", command: "node verify.mjs --probe" },
			{ name: "bash", command: "node verify.mjs --full" },
		], editHistory));
		expect(result.score, JSON.stringify(result.checks)).toBe(1);
	});

	it("rejects a full gate run on a candidate that is changed afterward", async () => {
		const item = byId("frozen-candidate-changed");
		await setup(item);
		expect(command("node verify.mjs --full").status).toBe(1);
		const fixed = `${JSON.stringify({ mode: "standard", batchSize: 8, checks: ["unit", "integration"] }, null, 2)}\n`;
		await writeFile(join(workspace, "config.json"), fixed);
		expect(command("node verify.mjs --probe").status).toBe(0);
		expect(command("node verify.mjs --full").status).toBe(0);
		const verification = JSON.parse((await generated(item))["verification.json"]!);
		const response = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: verification.digest });
		const result = scoreWorkflowDiscipline(item, await output(item, response, [
			{ name: "bash", command: "node verify.mjs --full" },
			{ name: "edit", path: "config.json" },
			{ name: "bash", command: "node verify.mjs --probe" },
			{ name: "bash", command: "node verify.mjs --full" },
		], [{ "config.json": fixed }], 1));
		expect(result.score).toBe(0);
		expect(result.checks.fullExactlyOnce).toBe(false);
	});

	it("allows one full gate with no edit for an already stable candidate", async () => {
		const item = byId("frozen-candidate-stable");
		await setup(item);
		expect(command("node verify.mjs --full").status).toBe(0);
		const verification = JSON.parse((await generated(item))["verification.json"]!);
		const response = JSON.stringify({ case: item.id, gate: "passed", candidateDigest: verification.digest });
		const result = scoreWorkflowDiscipline(item, await output(item, response, [{ name: "bash", command: "node verify.mjs --full" }], []));
		expect(result.score, JSON.stringify(result.checks)).toBe(1);
	});

	it("preflights and splits only the fixture that would exceed the size gate", async () => {
		for (const id of ["repo-size-needs-split", "repo-size-fits"]) {
			const item = byId(id);
			await setup(item);
			expect(command("node size-gate.mjs").status).toBe(0);
			const source = JSON.parse(await readFile(join(workspace, "app-store.test.json"), "utf8"));
			const secondary = JSON.parse(await readFile(join(workspace, "app-store-async.test.json"), "utf8"));
			const persistence = source.groups.find((group: { id: string }) => group.id === "persistence");
			persistence.assertions.push("archive-waits-for-queue", "attachment-waits-for-owner");
			if (item.variant === "split") {
				source.groups = source.groups.filter((group: { id: string }) => group.id !== "persistence");
				secondary.groups.push(persistence);
			}
			const sourceBody = `${JSON.stringify(source, null, 2)}\n`;
			const secondaryBody = `${JSON.stringify(secondary, null, 2)}\n`;
			await writeFile(join(workspace, "app-store.test.json"), sourceBody);
			await writeFile(join(workspace, "app-store-async.test.json"), secondaryBody);
			expect(command("node size-gate.mjs").status).toBe(0);
			expect(command("node verify.mjs").status).toBe(0);
			const verification = JSON.parse((await generated(item))["verification.json"]!);
			const split = item.variant === "split";
			const response = JSON.stringify({ case: item.id, status: "passed", split, digest: verification.digest });
			const edits = [{ "app-store.test.json": sourceBody, "app-store-async.test.json": secondaryBody }];
			const result = scoreWorkflowDiscipline(item, await output(item, response, [
				{ name: "bash", command: "node size-gate.mjs" },
				{ name: "edit", path: "app-store.test.json" },
				{ name: "edit", path: "app-store-async.test.json" },
				{ name: "bash", command: "node size-gate.mjs" },
				{ name: "bash", command: "node verify.mjs" },
			], edits));
			expect(result.score, JSON.stringify(result.checks)).toBe(1);
			await rm(workspace, { recursive: true, force: true });
			workspace = await mkdtemp(join(tmpdir(), "rotom-workflow-discipline-"));
		}
	});

	it("rejects adding assertions to the near-limit file without splitting it", async () => {
		const item = byId("repo-size-needs-split");
		await setup(item);
		expect(command("node size-gate.mjs").status).toBe(0);
		const source = JSON.parse(await readFile(join(workspace, "app-store.test.json"), "utf8"));
		const persistence = source.groups.find((group: { id: string }) => group.id === "persistence");
		persistence.assertions.push("archive-waits-for-queue", "attachment-waits-for-owner");
		const sourceBody = `${JSON.stringify(source, null, 2)}\n`;
		await writeFile(join(workspace, "app-store.test.json"), sourceBody);
		expect(command("node size-gate.mjs").status).toBe(1);
		expect(command("node verify.mjs").status).toBe(1);
		const response = JSON.stringify({ case: item.id, status: "passed", split: false, digest: "unknown" });
		const result = scoreWorkflowDiscipline(item, await output(item, response, [
			{ name: "bash", command: "node size-gate.mjs" },
			{ name: "edit", path: "app-store.test.json" },
			{ name: "bash", command: "node size-gate.mjs" },
			{ name: "bash", command: "node verify.mjs" },
		], [{ "app-store.test.json": sourceBody, "app-store-async.test.json": item.fixture.files["app-store-async.test.json"]! }], 2));
		expect(result.score).toBe(0);
		expect(result.checks.finalSizeCheck).toBe(false);
	});
});
