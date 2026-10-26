import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessContext } from "vitest-evals/harness";
import { createReplayHarness, gradeReplay, EXACT_CODE, REPLAY_CONFIG, REPLAY_KEEP_RECENT, REPLAY_TASKS, REPLAY_THRESHOLD, writeReplayFixture } from "../src/compaction-offload-cases.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import { createReplayMetrics, readOffloadDecisions, summarizeReplay, type ReplayMetrics } from "../src/compaction-offload-metrics.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const freshObservation = (): FauxObservation => ({ requests: [], config: null, agentDirMatches: false, summaryCalls: 0 });
const context = (): HarnessContext => ({ artifacts: {}, setArtifact() {} });
const rows: Record<string, ReplayMetrics[]> = { baseline: [], candidate: [] };
// Frozen task-08 provider request counts, including native summaries.
const normalRequests: Record<string, Record<number, [number, number]>> = {
	"config-aggregate": { 1: [126, 125], 10: [18, 17], 20: [12, 11] },
	"deferred-exact": { 1: [125, 124], 10: [17, 16], 20: [11, 10] },
	"multi-file-fix": { 1: [129, 128], 10: [21, 20], 20: [15, 14] },
};

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
		expect(output.coverageNudges).toBe(0);
		expect(output.phase1ReadCallsByTurn).toEqual([1, ...Array(task.reading.length).fill(1), 0]);
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
	expect(observations.map(o => o.requests.length)).toEqual(normalRequests[task.id]![1]);
	expect(results[0]!.offloadedResults).toBe(0);
	expect(results[0]!.nativeCompactions).toBeGreaterThan(0);
	expect(results[1]!.offloadedResults).toBeGreaterThan(0);
	expect(results[1]!.deferred).toBeGreaterThan(0);
	expect(results[1]!.thresholdAtTurns[0]).toBe(results[0]!.thresholdAtTurns[0]);
	expect(results[0]!.thresholdAtTurns[0]).toBeLessThan(observations[0]!.requests.filter(r => !r.summary && r.phase1).length);
	expect(results[0]!.offloadDecisions).toEqual([]);
	expect(results[1]!.offloadDecisions).toHaveLength(results[1]!.thresholdCompactions);
	expect(results[1]!.offloadDecisions.some(d => d.decision === "defer" && d.after <= 0.6 * d.T! && d.originalBytes > 0)).toBe(true);
	expect(observations[0]!.workspace).not.toBe(observations[1]!.workspace);
	expect(fetch).not.toHaveBeenCalled();
	const tools = JSON.parse(regular[0]![0]!.tools);
	expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["edit", "obs_recall", "read", "write"]);
	for (const tool of tools) expect(tool.parameters.properties).not.toHaveProperty("then_run");
	for (const [i, result] of results.entries()) expect(observations[i]!.requests.length).toBe(result.turns + observations[i]!.summaryCalls);
	console.log(JSON.stringify({ syntheticReplay: task.id, threshold: REPLAY_THRESHOLD, requests: observations.map((o) => o.requests.length), baseline: results[0], candidate: results[1] }));
}, 90_000);

it("faux trajectory has deferral, native fallback and both kinds of recall", async () => {
	const task = REPLAY_TASKS[1]!;
	const observed = freshObservation();
	const scenario = { ...task.scenario, steps: [...task.scenario.steps, { type: "prompt" as const, content: "Now give the final exact answer only." }] };
	const result = await createReplayHarness(task, true, { model: FAUX_MODEL, modelRuntimeFactory: replayFaux(task, observed, true) }).run(scenario, context());
	const output = result.output as ReplayMetrics;
	expect(output).toMatchObject({ correct: true, nativeCompactions: 1, obsRecallCalls: 2, recalledOffloaded: 1, usageComplete: true });
	expect(output.deferred).toBeGreaterThan(0);
	expect(output.thresholdCompactions).toBe(output.nativeCompactions + output.deferred);
	// A split-turn native compaction performs history + turn-prefix summaries.
	expect(observed.summaryCalls).toBe(2);
}, 90_000);

it.each(REPLAY_TASKS.flatMap(task => [10, 20].map(batchSize => ({ id: task.id, task, batchSize }))))("$id: $batchSize reads per turn cross the threshold in phase one", async ({ task, batchSize }) => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("05 forbids model/network requests"); }));
	const firstThresholds: number[] = [];
	for (const candidate of [false, true]) {
		const observed = freshObservation();
		const { output } = await createReplayHarness(task, candidate, { model: FAUX_MODEL,
			modelRuntimeFactory: replayFaux(task, observed, false, undefined, { batchSize }) }).run(task.scenario, context());
		// Keep decision metadata available even if the core defer assertion fails.
		console.log(JSON.stringify({ syntheticBatchedReplay: task.id, candidate, batchSize, requests: observed.requests.length, metrics: output }));
		firstThresholds.push(output.thresholdAtTurns[0]!);
		expect(output.coverageNudges).toBe(0);
		expect(observed.requests).toHaveLength(normalRequests[task.id]![batchSize]![candidate ? 1 : 0]);
		expect(output.phase1ReadCallsByTurn).toEqual([1, ...Array.from({ length: Math.ceil(task.reading.length / batchSize) }, (_, i) => Math.min(batchSize, task.reading.length - i * batchSize)), 0]);
		expect(output.correct).toBe(true);
		expect(output.thresholdCompactions).toBeGreaterThan(0);
		expect(observed.settings!.compaction.keepRecentTokens).toBe(REPLAY_KEEP_RECENT);
		const regular = observed.requests.filter(r => !r.summary);
		const reads = regular.map(r => r.reads);
		const phase1Turns = regular.filter(r => r.phase1).length;
		const materialTokens = task.reading.reduce((n, path) => n + Math.ceil(task.files[path]!.length / 4), 0);
		expect(materialTokens).toBeGreaterThanOrEqual(83_000);
		expect(reads.filter((n, i) => i > 0 && n > reads[i - 1]!)).toEqual(Array.from({ length: Math.ceil(task.reading.length / batchSize) }, (_, i) => Math.min((i + 1) * batchSize, task.reading.length)));
		expect(output.thresholdAtTurns[0]).toBeLessThan(phase1Turns);
		expect(output.phase1Coverage).toEqual({ readFiles: task.reading.length, totalFiles: task.reading.length, partialReads: 0 });
		expect(output.toolNames).toEqual({ read: task.reading.length + 2 - output.obsRecallCalls,
			...(Object.keys(task.solution).length ? { write: Object.keys(task.solution).length } : {}),
			...(output.obsRecallCalls ? { obs_recall: output.obsRecallCalls } : {}) });
		expect(output.contextByTurn).toHaveLength(output.turns);
		expect(output.contextPeak).toBe(Math.max(...output.contextByTurn));
		console.log(JSON.stringify({ phase1Pressure: task.id, candidate, batchSize, materialTokens, phase1Context: output.contextByTurn.slice(0, phase1Turns) }));
		if (candidate) {
			expect(output.offloadDecisions).toHaveLength(output.thresholdCompactions);
			expect(output.deferred).toBeGreaterThan(0);
			expect(output.offloadDecisions.some(d => d.decision === "defer" && d.after <= 0.6 * d.T!)).toBe(true);
		} else expect(output.nativeCompactions).toBeGreaterThan(0);
	}
	expect(firstThresholds[1]).toBe(firstThresholds[0]);
	expect(fetch).not.toHaveBeenCalled();
}, 90_000);

it.each(["no_candidates", "insufficient_savings"] as const)("collects %s from a real product faux session before cleanup", async (reason) => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("05 forbids model/network requests"); }));
	const task = REPLAY_TASKS[0]!, observed = freshObservation();
	const { output } = await createReplayHarness(task, true, { model: FAUX_MODEL,
		modelRuntimeFactory: replayFaux(task, observed, false, undefined, { pressure: reason }) }).run(task.scenario, context());
	expect(output.correct).toBe(true);
	const decision = output.offloadDecisions.find(d => d.decision === "native" && d.reason === reason);
	expect(decision).toBeDefined();
	expect(decision!.T).toBe(REPLAY_THRESHOLD);
	expect(decision!.before).toBeGreaterThan(REPLAY_THRESHOLD);
	if (reason === "no_candidates") expect(decision).toMatchObject({ candidates: 0, originalBytes: 0 });
	else { expect(decision!.candidates).toBeGreaterThan(0); expect(decision!.after).toBeGreaterThan(0.6 * REPLAY_THRESHOLD); }
	expect(output.offloadDecisions).toHaveLength(output.thresholdCompactions);
	expect(fetch).not.toHaveBeenCalled();
}, 90_000);

it("captures only threshold decision metadata before session files disappear", async () => {
	const dir = await mkdtemp(join(tmpdir(), "offload-ledger-")); roots.push(dir);
	const path = join(dir, "sol-pi/session/observation-pack");
	await mkdir(path, { recursive: true });
	const common = { before: 65000, after: 30000, T: 64000, candidates: 25, originalBytes: 150000 };
	const rows = [
		{ event: "offload_defer", ...common },
		{ event: "offload_defer_stale", ...common, candidates: 0, originalBytes: 0 },
		{ event: "offload_native", reason: "insufficient_savings", ...common, after: 62000 },
		{ event: "offload_native", reason: "no_candidates", ...common, after: 65000, candidates: 0, originalBytes: 0 },
	];
	await writeFile(join(path, "ledger.jsonl"), rows.map(r => JSON.stringify({ ...r, content: "NEVER EXPORT BODY" })).join("\n"));
	const decisions = await readOffloadDecisions(dir, "session");
	expect(decisions).toEqual(rows.map(({ event, ...row }) => ({ decision: event.slice(8), ...row })));
	await rm(path, { recursive: true });
	expect(createReplayMetrics().output([], true, false, decisions).offloadDecisions).toEqual(decisions);
	expect(JSON.stringify(decisions)).not.toContain("NEVER EXPORT BODY");
	expect(await readOffloadDecisions(dir, "missing")).toEqual([]);
});

it("metrics sum summary usage once, attribute recall temporally, and time cancellations", () => {
	const handlers = new Map<string, Function>();
	let time = 10;
	const metrics = createReplayMetrics(() => time);
	(metrics.extension as Function)({ on: (name: string, fn: Function) => handlers.set(name, fn) });
	const event = (name: string, fields = {}) => handlers.get(name)!({ reason: "threshold", ...fields }, { cwd: "/synthetic", sessionManager: { getBranch: () => [] } });
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
		inputTokens: 300, outputTokens: 30, cacheRead: 60, cacheWrite: 15, estimatedCostUsd: 0.75, usageComplete: true,
		toolNames: { obs_recall: 2 }, phase1Coverage: { readFiles: 0, totalFiles: 0, partialReads: 0 }, contextByTurn: [125, 125], contextPeak: 125 });
	expect(summarizeReplay([output, { ...output, correct: false, compactionWaitMs: 10 }])).toMatchObject({ correct: 1, runs: 2, compactionWaitMsMean: 21, compactionWaitMsMedian: 21 });
	expect(metrics.output([...entries, { type: "compaction" }] as any, true, true).estimatedCostUsd).toBeNull();
	event("session_start");
	expect(metrics.output([], false, false).thresholdCompactions).toBe(0);
});

it("frozen fixtures are medium text results, and prompts do not coach retrieval", () => {
	for (let i = 0; i < 20; i++) expect(REPLAY_TASKS[0]!.files[`modules/module-${i}.mjs`]).toContain(`export const VALUE = ${(i + 1) * 17};`);
	const logLines = REPLAY_TASKS[1]!.files["logs/log-0.txt"]!.trimEnd().split("\n");
	expect(logLines.indexOf(`EXACT_CODE=${EXACT_CODE}`)).toBe(Math.floor((logLines.length - 1) / 2));
	for (const task of REPLAY_TASKS) {
		expect(task.reading).toHaveLength(task.id === "multi-file-fix" ? 121 : 120);
		expect(JSON.stringify(task.scenario)).not.toMatch(/run (node|the tests)/iu);
		for (const path of task.reading) expect(task.files[path]).not.toMatch(/^\/\/ [a-f0-9]{64}$/mu);
		for (const path of task.reading) expect(Buffer.byteLength(task.files[path]!)).toBeGreaterThan(1536);
		const sizes = task.reading.map(path => Buffer.byteLength(task.files[path]!));
		const proxies = task.reading.map(path => Math.ceil(task.files[path]!.length / 4));
		const largestBatch = [...proxies].sort((a, b) => b - a).slice(0, 20).reduce((sum, n) => sum + n, 0);
		const materialTokens = proxies.reduce((sum, n) => sum + n, 0);
		expect(largestBatch).toBeLessThanOrEqual(0.25 * REPLAY_THRESHOLD);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(3072);
		expect(materialTokens).toBeGreaterThanOrEqual(83_000);
		console.log(JSON.stringify({ fixtureShare: task.id, files: sizes.length, minBytes: Math.min(...sizes), maxBytes: Math.max(...sizes), minTokens: Math.min(...proxies), largestBatch, materialTokens }));
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
