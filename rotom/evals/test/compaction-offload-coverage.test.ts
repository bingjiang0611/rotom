import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createReplayHarness, coverageNudgePrompt, REPLAY_TASKS } from "../src/compaction-offload-cases.ts";
import { createLiveReplayCampaign } from "../src/compaction-offload-live.ts";
import { createReplayMetrics, summarizeLiveReplay } from "../src/compaction-offload-metrics.ts";
import { FAUX_MODEL, replayFaux, type FauxObservation } from "../src/compaction-offload-faux.ts";
import type { LiveReplayRow } from "../src/compaction-offload-store.ts";
import { promptAgent } from "../src/pi-harness-lifecycle.ts";

const roots: string[] = [];
const observation = (): FauxObservation => ({ requests: [], config: null, agentDirMatches: false, summaryCalls: 0 });
const context = () => ({ artifacts: {}, setArtifact() {} });
const authorization = { id: "coverage-faux-only", provider: FAUX_MODEL.provider, model: FAUX_MODEL.id, thinking: "low" as const, maxRepetitions: 3, maxRequests: 3000, maxInputTokens: 140_000_000 };
const profile = { model: FAUX_MODEL, contextWindow: 272_000, reasoning: true };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Coverage tests forbid network/model requests"); })); });
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("both arms read the remaining 70 files after exactly the same single nudge", async () => {
	const task = REPLAY_TASKS[0]!, observations = [];
	for (const candidate of [false, true]) {
		const observed = observation(); observations.push(observed);
		const result = await createReplayHarness(task, candidate, { model: FAUX_MODEL,
			modelRuntimeFactory: replayFaux(task, observed, false, undefined, { batchSize: 10, phase1ReadLimit: 50, resumeAfterNudge: true }) }).run(task.scenario, context());
		expect(result.output).toMatchObject({ correct: true, coverageNudges: 1, phase1Coverage: { readFiles: 120, totalFiles: 120, partialReads: 0 } });
		expect(result.output.thresholdCompactions).toBeGreaterThan(0);
		if (candidate) expect(result.output.deferred).toBeGreaterThan(0);
		expect(result.output.phase1ReadCallsByTurn.reduce((sum, n) => sum + n, 0)).toBe(121);
		expect(observed.coveragePrompts).toEqual([coverageNudgePrompt(70)]);
		console.log(JSON.stringify({ coverageResume: candidate ? "candidate" : "baseline", requests: observed.requests.length, metrics: result.output }));
	}
	expect(Buffer.from(observations[0]!.coveragePrompts![0]!)).toEqual(Buffer.from(observations[1]!.coveragePrompts![0]!));
	expect(coverageNudgePrompt(70)).not.toMatch(/obs_recall|compaction|offload|modules\//u);
	expect(fetch).not.toHaveBeenCalled();
}, 120_000);

it.each([{ schedule: [true, true, true] }, { schedule: [true, false, true, true] }])("halts after three cumulative invalid samples ($schedule)", async ({ schedule }) => {
	const directory = await mkdtemp(join(tmpdir(), "offload-coverage-")); roots.push(directory);
	const task = REPLAY_TASKS[0]!, observed = observation(); let stubborn = true;
	const factory = vi.fn((ctx: Parameters<ReturnType<typeof replayFaux>>[0]) => replayFaux(task, observed, false, profile,
		{ batchSize: 20, ...(stubborn ? { phase1ReadLimit: 5 } : {}) })(ctx));
	const campaign = createLiveReplayCampaign(authorization, { directory, runtimeFactory: factory });
	const results: LiveReplayRow[] = [];
	for (const [index, lazy] of schedule.entries()) {
		stubborn = lazy;
		const result = await campaign.harness(task, index % 4 === 1 || index % 4 === 2, Math.floor(index / 2) + 1).run(task.scenario, context());
		results.push(result.output);
		expect(result.output.status).toBe(lazy ? "invalid" : "completed");
		expect(result.output.metrics?.coverageNudges).toBe(lazy ? 2 : 0);
		expect(result.output.metrics?.correct).toBe(true);
		if (index < schedule.length - 1) expect(result.output.cumulative.stopReason).toBeNull();
	}
	expect(results.at(-1)).toMatchObject({ status: "invalid", reason: "threshold-not-reached", cumulative: { stopReason: "threshold-not-reached" } });
	const count = observed.requests.length;
	const next = await campaign.harness(task, true, 3).run(task.scenario, context());
	expect(next.output).toMatchObject({ status: "not-run", metrics: null, cumulative: { requests: count } });
	expect(observed.requests).toHaveLength(count);
	expect(factory).toHaveBeenCalledTimes(schedule.length);
	const file = (await readdir(directory)).find(name => name.endsWith(".jsonl"))!;
	const saved = (await readFile(join(directory, file), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	expect(saved).toEqual([...results, next.output]);
	expect(campaign.summary()).toMatchObject({ invalidRuns: 3, executedRuns: schedule.length, validPairs: 0, baseline: null, candidate: null });
	expect(campaign.summary().rawRuns.map(row => row.status)).toEqual(results.map(row => row.status));
	expect(fetch).not.toHaveBeenCalled();
	console.log(JSON.stringify({ invalidSchedule: schedule, requests: count, statuses: saved.map(row => row.status) }));
}, 120_000);

it("compares only matched valid pairs, retaining incorrect valid answers in the success denominator", () => {
	const row = (arm: "baseline" | "candidate", repetition: number, status: LiveReplayRow["status"], wait: number, correct: boolean) => ({
		authorizationId: "summary-faux", task: "config-aggregate", arm, repetition, status,
		metrics: { ...createReplayMetrics().output([], correct, false), thresholdCompactions: status === "completed" ? 1 : 0, compactionWaitMs: wait },
	} as LiveReplayRow);
	const rows = [row("baseline", 1, "completed", 10, true), row("candidate", 1, "completed", 20, false), row("candidate", 2, "invalid", 999999, true)];
	const result = summarizeLiveReplay(rows);
	expect(result.rawRuns.map(row => row.metrics)).toEqual(rows.map(row => row.metrics));
	expect(result).toMatchObject({ executedRuns: 3, invalidRuns: 1, validPairs: 1,
		baseline: { runs: 1, correct: 1, compactionWaitMsMean: 10 }, candidate: { runs: 1, correct: 0, compactionWaitMsMean: 20 } });
	expect(summarizeLiveReplay([rows[0]!, rows[2]!])).toMatchObject({ validPairs: 0, baseline: null, candidate: null });
});

it("ordinary harness prompts stay single-shot; continuation runs only after successful responses", async () => {
	const entries: any[] = [], calls: string[] = [];
	const session = { sessionManager: { getBranch: () => entries }, waitForIdle: async () => {}, prompt: async (input: string) => {
		calls.push(input); entries.push({ type: "message", message: { role: "assistant", content: input, stopReason: "stop" } });
	} } as unknown as AgentSession;
	expect(await promptAgent(session, "ordinary", undefined)).toBe("ordinary");
	expect(calls).toEqual(["ordinary"]);
	const continuation = vi.fn().mockReturnValueOnce("follow-up").mockReturnValue(undefined);
	expect(await promptAgent(session, "initial", undefined, false, continuation)).toBe("follow-up");
	expect(calls).toEqual(["ordinary", "initial", "follow-up"]);
	expect(continuation).toHaveBeenCalledTimes(2);
	const rejected = vi.fn();
	session.prompt = async () => { throw new Error("provider failed"); };
	await expect(promptAgent(session, "fail", undefined, false, rejected)).rejects.toThrow("provider failed");
	expect(rejected).not.toHaveBeenCalled();
});
