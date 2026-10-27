import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { LIVE_REPLAY_TIMEOUT_MS } from "../src/compaction-offload-cases.ts";
import evalConfig from "../vitest.config.ts";

const testAuthorization = { id: "registration-test-only", provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", maxRepetitions: 3, maxRequests: 2000, maxInputTokens: 100_000_000 };
const registrations: { name: string; options: any }[] = [];
const registeredTests: unknown[][] = [];
const campaign = { harness: vi.fn((task, candidate, repetition) => ({ name: candidate ? "candidate" : "baseline", task: task.id, repetition })), summary: () => ({ validPairs: 0 }) };
const create = vi.fn((..._args: unknown[]) => campaign);
// The live module is replaced before the entry module can execute it. These
// registration tests cannot create a ModelRuntime or read a credential file.
vi.mock("../src/compaction-offload-live.ts", () => ({ createLiveReplayCampaign: (...args: unknown[]) => create(...args) }));
vi.mock("vitest-evals", () => ({
	describeEval: (name: string, options: any, define: Function) => {
		registrations.push({ name, options });
		define((...args: unknown[]) => registeredTests.push(args));
	},
	createJudge: (name: string, assess: Function) => ({ name, assess }),
}));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.unstubAllEnvs(); registrations.length = 0; registeredTests.length = 0; vi.doUnmock("../src/compaction-offload-cases.ts"); });
function liveEnv(authorization: (typeof testAuthorization & { tasks?: string[] }) | null = testAuthorization) {
	vi.doMock("../src/compaction-offload-cases.ts", async () => ({ ...await vi.importActual("../src/compaction-offload-cases.ts"), LIVE_AUTHORIZATION: authorization }));
	vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD", "1"); vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE", "1");
	vi.stubEnv("ROTOM_EVAL_PROVIDER", testAuthorization.provider); vi.stubEnv("ROTOM_EVAL_MODEL", testAuthorization.model);
	vi.stubEnv("ROTOM_EVAL_THINKING", testAuthorization.thinking); vi.stubEnv("ROTOM_EVAL_REPETITIONS", "3");
	vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS", undefined);
}
it("live entry shares exactly one campaign across all 18 alternating runs", async () => {
	liveEnv();
	await import("../cases/compaction-offload.eval.ts");
	expect(create).toHaveBeenCalledExactlyOnceWith(testAuthorization, { repetitions: 3 });
	expect(campaign.harness).toHaveBeenCalledTimes(18);
	expect(LIVE_REPLAY_TIMEOUT_MS).toBe(30 * 60_000);
	expect(registeredTests).toHaveLength(18);
	for (const [, options, body] of registeredTests) {
		expect(options).toEqual({ timeout: LIVE_REPLAY_TIMEOUT_MS });
		expect(typeof body).toBe("function");
	}
	for (let offset = 0; offset < 18; offset += 6) {
		expect(registrations.slice(offset, offset + 6).map((r) => [r.options.harness.name, r.options.harness.repetition])).toEqual([
			["baseline", 1], ["candidate", 1], ["candidate", 2], ["baseline", 2], ["baseline", 3], ["candidate", 3],
		]);
	}
	const judge = registrations[0]!.options.judges[0];
	expect(judge.assess({ output: { status: "not-run", metrics: null } }).score).toBe(0);
	expect(registrations[0]!.options.judgeThreshold).toBeNull();
	const body = registeredTests[0]![2] as Function;
	const skip = vi.fn(() => { throw new Error("invalid-skipped"); });
	const run = (status: string, correct: boolean, stopReason: string | null = null, reason: string | null = null) => async () => ({ output: { status, reason, metrics: { correct }, cumulative: { stopReason } } });
	await expect(body({ run: run("invalid", true), skip })).rejects.toThrow("invalid-skipped");
	await expect(body({ run: run("failed", false, null, "provider-error"), skip })).rejects.toThrow("invalid-skipped");
	await expect(body({ run: run("failed", false, "provider-error", "provider-error"), skip })).rejects.toThrow();
	await expect(body({ run: run("completed", false), skip })).rejects.toThrow();
	await expect(body({ run: run("failed", false, "run-error"), skip })).rejects.toThrow();
	await expect(body({ run: run("invalid", true, "threshold-not-reached"), skip })).rejects.toThrow();
	await expect(body({ run: run("completed", true), skip })).resolves.toBeUndefined();
	expect(skip).toHaveBeenCalledTimes(2);
});
it("faux registration keeps the global deadline and does not construct a live campaign", async () => {
	liveEnv(); vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE", "0");
	vi.stubEnv("ROTOM_EVAL_PROVIDER", "rotom-offload-faux"); vi.stubEnv("ROTOM_EVAL_MODEL", "replay");
	await import("../cases/compaction-offload.eval.ts");
	expect(create).not.toHaveBeenCalled();
	expect(registeredTests).toHaveLength(18);
	for (const args of registeredTests) {
		expect(args).toHaveLength(2); expect(typeof args[1]).toBe("function");
	}
	expect(evalConfig.test?.testTimeout).toBe(120_000);
	expect(evalConfig.test?.hookTimeout).toBe(30_000);
});
it("a smaller authorized N is passed to the campaign and only schedules that N", async () => {
	liveEnv(); vi.stubEnv("ROTOM_EVAL_REPETITIONS", "1");
	await import("../cases/compaction-offload.eval.ts");
	expect(create).toHaveBeenCalledExactlyOnceWith(testAuthorization, { repetitions: 1 });
	expect(registrations).toHaveLength(6);
});
it.each([{ tasks: ["multi-file-fix"] }, { tasks: ["multi-file-fix", "config-aggregate"] }])("selects only authorized tasks %j in the original task order", async ({ tasks }) => {
	liveEnv({ ...testAuthorization, tasks }); vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS", tasks.join(","));
	await import("../cases/compaction-offload.eval.ts");
	expect(registeredTests).toHaveLength(tasks.length * 6);
	expect(registrations.map(r => r.options.harness.task)).toEqual(tasks.includes("config-aggregate")
		? [...Array(6).fill("config-aggregate"), ...Array(6).fill("multi-file-fix")] : Array(6).fill("multi-file-fix"));
	for (let i = 0; i < tasks.length * 6; i += 6) expect(registrations.slice(i, i + 6).map(r => r.options.harness.name)).toEqual(["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
});
it.each([
	{ tasks: ["multi-file-fix"], env: undefined },
	{ tasks: undefined, env: "multi-file-fix" },
	{ tasks: ["multi-file-fix"], env: "config-aggregate" },
	{ tasks: ["multi-file-fix", "config-aggregate"], env: "config-aggregate,multi-file-fix" },
	{ tasks: ["unknown-task"], env: "unknown-task" },
])("rejects task-scope mismatch at entry: %j", async ({ tasks, env }) => {
	liveEnv({ ...testAuthorization, tasks }); vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_TASKS", env);
	await expect(import("../cases/compaction-offload.eval.ts")).rejects.toThrow(/task/iu);
	expect(create).not.toHaveBeenCalled();
});

it("missing authorization rejects the entry before any campaign is constructed", async () => {
	liveEnv(null);
	await expect(import("../cases/compaction-offload.eval.ts")).rejects.toThrow("no authorization");
	expect(create).not.toHaveBeenCalled();
});
it("a mismatched real model is rejected at entry, not just by a helper", async () => {
	liveEnv(); vi.stubEnv("ROTOM_EVAL_MODEL", "unauthorized");
	await expect(import("../cases/compaction-offload.eval.ts")).rejects.toThrow("exactly match");
	expect(create).not.toHaveBeenCalled();
});

it("the actual Vitest --bail=1 path skips provider errors and invalid samples but stops on the third unusable sample", async () => {
	const directory = await mkdtemp(join(tmpdir(), "offload-entry-bail-"));
	try {
		const report = join(directory, "result.json"), config = join(directory, "config.mjs");
		await writeFile(config, `export default ${JSON.stringify({ test: { include: ["test/fixtures/offload-entry-bail.fixture.ts"], reporters: ["default", "json"], outputFile: report, fileParallelism: false } })}`);
		const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../node_modules/vitest/vitest.mjs"), "run", "--config", config, "--bail=1"], {
			cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 60_000,
			env: { ...process.env, ROTOM_EVAL_COMPACTION_OFFLOAD: "1", ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE: "1",
				ROTOM_EVAL_PROVIDER: "entry-faux", ROTOM_EVAL_MODEL: "replay", ROTOM_EVAL_THINKING: "low", ROTOM_EVAL_REPETITIONS: "3" },
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stdout + result.stderr).toBe(1);
		const data = JSON.parse(await readFile(report, "utf8"));
		const assertions = data.testResults.flatMap((file: any) => file.assertionResults);
		expect(assertions.map((test: any) => test.status)).toEqual(["skipped", "passed", "skipped", "failed", ...Array(14).fill("pending")]);
		expect(result.stdout + result.stderr).toContain('"executedRuns":4');
		expect(result.stdout + result.stderr).toContain('"unusableRuns":3');
	} finally { await rm(directory, { recursive: true, force: true }); }
}, 90_000);
