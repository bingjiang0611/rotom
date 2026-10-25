import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createReplayHarness, gradeReplay, REPLAY_CONFIG, REPLAY_TASKS, REPLAY_THRESHOLD, writeReplayFixture } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import { createReplayMetrics, summarizeReplay, type ReplayMetrics } from "../src/compaction-offload-metrics.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const freshObservation = (): FauxObservation => ({ requests: [], config: null, agentDirMatches: false, summaryCalls: 0 });
const context = (): HarnessContext => ({ artifacts: {}, setArtifact() {} });
const rows: Record<string, ReplayMetrics[]> = { baseline: [], candidate: [] };

it.each(REPLAY_TASKS)("$id grading rejects wrong output and protected-file changes", async (task) => {
	const workspace = await mkdtemp(join(tmpdir(), "offload-grading-")); roots.push(workspace);
	await writeReplayFixture(workspace, task);
	for (const [path, content] of Object.entries(task.solution)) await writeFile(join(workspace, path), content);
	expect(await gradeReplay(task, workspace, task.answer)).toBe(true);
	expect(await gradeReplay(task, workspace, "WRONG")).toBe(false);
	if (task.id === "multi-file-fix") {
		const fixed = task.solution["src/add.mjs"]!;
		await writeFile(join(workspace, "src/add.mjs"), fixed.replace("export const add = (a, b) => a + b;", "export function add(a, b) { return a + b; }"));
		expect(await gradeReplay(task, workspace, task.answer)).toBe(true);
		await writeFile(join(workspace, "src/add.mjs"), fixed.replace("a + b", "a - b"));
		expect(await gradeReplay(task, workspace, task.answer)).toBe(false);
		await writeFile(join(workspace, "src/add.mjs"), fixed);
	}
	const protectedPath = Object.keys(task.files).find((path) => !(path in task.solution))!;
	await writeFile(join(workspace, protectedPath), "tampered");
	expect(await gradeReplay(task, workspace, task.answer)).toBe(false);
});

it.each(REPLAY_TASKS)("$id: real product faux arms share prompt/schema and cross the same threshold", async (task) => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("04a forbids network requests"); }));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalSwitch = process.env.ROTOM_COMPACTION_OFFLOAD;
	const observations = [freshObservation(), freshObservation()];
	const results: ReplayMetrics[] = [];
	for (const [index, candidate] of [false, true].entries()) {
		const result = await createReplayHarness(task, candidate, { model: FAUX_MODEL, modelRuntimeFactory: replayFaux(task, observations[index]!) }).run(task.scenario, context());
		const output = result.output as ReplayMetrics;
		results.push(output); rows[candidate ? "candidate" : "baseline"]!.push(output);
		expect(output.correct).toBe(true);
		expect(output.usageComplete).toBe(true);
		expect(output.estimatedCostUsd).toBeNull(); // faux zero price is not a real provider quote
		expect(observations[index]!.config).toEqual(REPLAY_CONFIG);
		expect(observations[index]!.agentDirMatches).toBe(true);
		expect(observations[index]!.requests.filter((r) => r.summary).every((r) => r.maxTokens === null)).toBe(true);
	}
	expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
	expect(process.env.ROTOM_COMPACTION_OFFLOAD).toBe(originalSwitch);
	const regular = observations.map((o) => o.requests.filter((r) => !r.summary));
	expect(regular[0]![0]!.system.length).toBeGreaterThan(100);
	expect(regular[0]![0]!.tools).not.toBe("[]");
	expect(regular[0]![0]!.system).toBe(regular[1]![0]!.system);
	expect(regular[0]![0]!.tools).toBe(regular[1]![0]!.tools);
	for (const requests of regular) for (const request of requests) {
		expect(request.system).toBe(regular[0]![0]!.system);
		expect(request.tools).toBe(regular[0]![0]!.tools);
	}
	expect(results[0]!.offloadedResults).toBe(0);
	expect(results[0]!.nativeCompactions).toBeGreaterThan(0);
	expect(results[1]!.offloadedResults).toBeGreaterThan(0);
	expect(results[1]!.deferred).toBeGreaterThan(0);
	expect(results[1]!.thresholdAtTurns[0]).toBe(results[0]!.thresholdAtTurns[0]);
	expect(results[0]!.thresholdAtTurns[0]).toBe(40);
	expect(observations[0]!.workspace).not.toBe(observations[1]!.workspace);
	expect(fetch).not.toHaveBeenCalled();
	expect(JSON.parse(regular[0]![0]!.tools).map((tool: { name: string }) => tool.name).sort()).toEqual(["bash", "edit", "obs_recall", "read", "write"]);
	for (const [i, result] of results.entries()) expect(observations[i]!.requests.length).toBe(result.turns + observations[i]!.summaryCalls);
	console.log(JSON.stringify({ syntheticReplay: task.id, threshold: REPLAY_THRESHOLD, requests: observations.map((o) => o.requests.length), baseline: results[0], candidate: results[1] }));
}, 90_000);

it("faux trajectory has one defer, one native compaction and both kinds of recall", async () => {
	const task = REPLAY_TASKS[1]!;
	const observed = freshObservation();
	const scenario = { ...task.scenario, steps: [...task.scenario.steps, { type: "prompt" as const, content: "Now give the final exact answer only." }] };
	const result = await createReplayHarness(task, true, { model: FAUX_MODEL, modelRuntimeFactory: replayFaux(task, observed, true) }).run(scenario, context());
	const output = result.output as ReplayMetrics;
	expect(output).toMatchObject({ correct: true, nativeCompactions: 1, deferred: 1, obsRecallCalls: 2, recalledOffloaded: 1, usageComplete: true });
	expect(output.thresholdCompactions).toBe(2);
	// A split-turn native compaction performs history + turn-prefix summaries.
	expect(observed.summaryCalls).toBe(2);
}, 90_000);

it("metrics sum summary usage once, attribute recall temporally, and time cancellations", () => {
	const handlers = new Map<string, Function>();
	let time = 10;
	const metrics = createReplayMetrics(() => time);
	(metrics.extension as Function)({ on: (name: string, fn: Function) => handlers.set(name, fn) });
	const event = (name: string, fields = {}) => handlers.get(name)!({ reason: "threshold", ...fields }, { sessionManager: { getBranch: () => [] } });
	event("session_start");
	event("session_before_compact"); time = 12; event("session_compact_failed", { aborted: true });
	event("session_before_compact"); time = 42; event("session_compact", { fromExtension: false });
	const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, cost: { total: 0.25 } };
	const assistant = (id: string) => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", usage, content: [{ type: "toolCall", name: "obs_recall", arguments: { id } }] } });
	const entries = [
		assistant("ordinary"),
		{ type: "custom", customType: "sol-pi-compaction-offload", data: { toolCallIds: ["a", "b"], observationIds: ["offloaded", "ordinary"] } },
		assistant("offloaded"), { type: "compaction", usage },
	];
	const output = metrics.output(entries as any, true, true);
	expect(output).toMatchObject({ thresholdCompactions: 2, nativeCompactions: 1, deferred: 1, compactionWaitMs: 32, wallMs: 32,
		turns: 2, toolCalls: 2, obsRecallCalls: 2, recalledOffloaded: 1, offloadedResults: 2,
		inputTokens: 300, outputTokens: 30, cacheRead: 60, cacheWrite: 15, estimatedCostUsd: 0.75, usageComplete: true });
	expect(summarizeReplay([output, { ...output, correct: false, compactionWaitMs: 10 }])).toMatchObject({ correct: 1, runs: 2, compactionWaitMsMean: 21, compactionWaitMsMedian: 21 });
	expect(metrics.output([...entries, { type: "compaction" }] as any, true, true).estimatedCostUsd).toBeNull();
	event("session_start");
	expect(metrics.output([], false, false).thresholdCompactions).toBe(0);
});

it("frozen fixtures are medium text results, and prompts do not coach retrieval", () => {
	for (const task of REPLAY_TASKS) {
		for (const path of task.reading) expect(Buffer.byteLength(task.files[path]!)).toBeGreaterThan(1536);
		for (const path of task.reading) expect(Buffer.byteLength(task.files[path]!)).toBeLessThan(10 * 1024);
		expect(JSON.stringify(task.scenario)).not.toMatch(/obs_recall|compaction|offload|压缩|卸载/u);
	}
});

it("unset opt-in skips the case, including with an invalid real-provider selection", async () => {
	const env: NodeJS.ProcessEnv = { ...process.env, ROTOM_EVAL_PROVIDER: "forbidden-real-provider" };
	delete env.ROTOM_EVAL_COMPACTION_OFFLOAD;
	const child = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "cases/compaction-offload.eval.ts", "--reporter=json"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
	expect(child.status, child.stderr || child.stdout).toBe(0);
	const report = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
	expect(report.numPendingTests).toBe(1);
	expect(report.numPassedTests).toBe(0);
});

it("explicit opt-in still refuses a real provider during 04a", () => {
	const child = spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "cases/compaction-offload.eval.ts", "--reporter=json"], {
		cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
		env: { ...process.env, ROTOM_EVAL_COMPACTION_OFFLOAD: "1", ROTOM_EVAL_PROVIDER: "forbidden-real-provider", ROTOM_EVAL_MODEL: "forbidden-model" },
	});
	expect(child.status).toBe(1);
	expect(child.stdout + child.stderr).toContain("04a is faux-only");
});

it("prints only aggregate synthetic planning observations", () => {
	if (rows.baseline!.length) console.log(JSON.stringify({ syntheticSummary: { baseline: summarizeReplay(rows.baseline!), candidate: summarizeReplay(rows.candidate!) } }));
});
