import { afterEach, expect, it, vi } from "vitest";
import { LIVE_AUTHORIZATION, LIVE_REPLAY_TIMEOUT_MS } from "../src/compaction-offload-cases.ts";
import evalConfig from "../vitest.config.ts";

const testAuthorization = { id: "registration-test-only", provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low", maxRepetitions: 3, maxRequests: 2000, maxInputTokens: 100_000_000 };
const registrations: { name: string; options: any }[] = [];
const registeredTests: unknown[][] = [];
const campaign = { harness: vi.fn((task, candidate, repetition) => ({ name: candidate ? "candidate" : "baseline", task: task.id, repetition })) };
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
function liveEnv() {
	vi.doMock("../src/compaction-offload-cases.ts", async () => ({ ...await vi.importActual("../src/compaction-offload-cases.ts"), LIVE_AUTHORIZATION: testAuthorization }));
	vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD", "1"); vi.stubEnv("ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE", "1");
	vi.stubEnv("ROTOM_EVAL_PROVIDER", testAuthorization.provider); vi.stubEnv("ROTOM_EVAL_MODEL", testAuthorization.model);
	vi.stubEnv("ROTOM_EVAL_THINKING", testAuthorization.thinking); vi.stubEnv("ROTOM_EVAL_REPETITIONS", "3");
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
it("spent 04b authorization rejects the entry before any campaign is constructed", async () => {
	expect(LIVE_AUTHORIZATION).toBeNull();
	liveEnv();
	vi.doMock("../src/compaction-offload-cases.ts", async () => ({ ...await vi.importActual("../src/compaction-offload-cases.ts"), LIVE_AUTHORIZATION: null }));
	await expect(import("../cases/compaction-offload.eval.ts")).rejects.toThrow("no authorization");
	expect(create).not.toHaveBeenCalled();
});
it("a mismatched real model is rejected at entry, not just by a helper", async () => {
	liveEnv(); vi.stubEnv("ROTOM_EVAL_MODEL", "unauthorized");
	await expect(import("../cases/compaction-offload.eval.ts")).rejects.toThrow("exactly match");
	expect(create).not.toHaveBeenCalled();
});
