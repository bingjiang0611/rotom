import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBenchmarkProfileV1 } from "../src/benchmark-profile.ts";
import {
	AMD64_APPLE_CONTAINER_ENVIRONMENT,
	DEV_AGENT_HARBOR_AGENT,
	SWE_BENCH_MULTILINGUAL_DATASET,
	SWE_BENCH_MULTILINGUAL_REGISTRY,
	TERMINAL_BENCH_2_DATASET,
	TERMINAL_BENCH_21_DATASET,
	TERMINAL_BENCH_21_REGISTRY,
	TERMINAL_BENCH_21_REVISION,
	NATIVE_PI_HARBOR_AGENT,
	buildHarborBenchmarkArgs,
	parseBenchmarkRunnerArgs,
} from "../src/benchmark-runner.ts";

const defaults = {
	productAgentDir: "/repo/rotom",
	jobsDir: "/repo/rotom/evals/.eval/benchmarks",
};

describe("benchmark runner", () => {
	it("keeps the release plan non-executable and records the requested limits", () => {
		const plan = JSON.parse(readFileSync(new URL("../profiles/release-preparation.json", import.meta.url), "utf8"));
		expect(plan.status).toBe("preparation-only");
		expect(plan.liveExecutionAuthorized).toBe(false);
		expect(plan.publicName).toBe("rotom");
		expect(plan.repositoryName).toBe("rotom");
		expect(plan.internalProductId).toBe("dev-agent");
		expect(plan.resolvedProvider).toBe("openai-codex");
		expect(plan.resolvedModelId).toBe("gpt-5.6-luna");
		expect(plan.thinking).toBe("high");
		expect(plan.futureRunLimits.maxUsd).toBe(20);
		expect(plan.futureRunLimits.maxWallClockSeconds).toBe(7200);
		expect(plan.comparison.benchmarkRevision).toBe(TERMINAL_BENCH_21_REVISION);
		expect(plan.comparison.arms).toEqual(["native-pi", "dev-agent"]);
	});

	it("freezes all 89 TB 2.1 task refs and ten explicit preparation tasks", () => {
		const registry = JSON.parse(readFileSync(TERMINAL_BENCH_21_REGISTRY, "utf8"));
		expect(registry).toHaveLength(1);
		expect(registry[0].name).toBe("terminal-bench");
		expect(registry[0].version).toBe("2.1");
		expect(registry[0].tasks).toHaveLength(89);
		const names = new Set(registry[0].tasks.map((task: { name: string }) => task.name));
		expect(names.size).toBe(89);
		for (const task of registry[0].tasks) {
			expect(task.git_url).toBe("https://github.com/harbor-framework/terminal-bench-2-1.git");
			expect(task.git_commit_id).toBe(TERMINAL_BENCH_21_REVISION);
			expect(task.path).toBe(`tasks/${task.name}`);
		}
		const profile = parseBenchmarkProfileV1(readFileSync(new URL("../profiles/release-smoke.txt", import.meta.url), "utf8"));
		expect(profile).toHaveLength(10);
		for (const entry of profile) {
			expect(entry.benchmark).toBe("terminal-bench-2.1");
			expect(names.has(entry.taskId)).toBe(true);
		}
	});

	it.each(["native-pi", "dev-agent"])("prepares %s with the same explicit Pi/model/thinking contract", (arm) => {
		const options = parseBenchmarkRunnerArgs(["terminal-bench-2.1", `--arm=${arm}`, "--pi-version=0.85.1", "--provider=unresolved", "--model=luna", "--thinking=high", "--task=build-cython-ext", "--dry-run"], defaults, {});
		const args = buildHarborBenchmarkArgs(options, "preparation-only");
		expect(options.dryRun).toBe(true);
		expect(args).toEqual(expect.arrayContaining(["--dataset", TERMINAL_BENCH_21_DATASET, "--registry-path", TERMINAL_BENCH_21_REGISTRY, "version=0.85.1", "thinking=high", "unresolved/luna"]));
		expect(args).toContain(arm === "native-pi" ? NATIVE_PI_HARBOR_AGENT : DEV_AGENT_HARBOR_AGENT);
		expect(args.includes("product_agent_dir=/repo/rotom")).toBe(arm === "dev-agent");
	});

	it.each(["--arm=oracle", "--pi-version=latest", "--pi-version=^0.85.1", "--pi-version=0.85.1;touch /tmp/bad", "--thinking=max"])("rejects an unfrozen/unsupported release option %s", (argument) => {
		expect(() => parseBenchmarkRunnerArgs(["terminal-bench-2.1", "--provider=unresolved", "--model=luna", argument], defaults, {})).toThrow();
	});

	it("builds a pinned SWE-bench Multilingual Harbor run", () => {
		const options = parseBenchmarkRunnerArgs(
			["swe-bench-multilingual", "--provider=openai", "--model=gpt-5.6-sol", "--task=apache__druid-13704"],
			defaults,
			{},
		);
		const args = buildHarborBenchmarkArgs(options, "fixture-run");

		expect(args).toContain(DEV_AGENT_HARBOR_AGENT);
		expect(args).toContain(AMD64_APPLE_CONTAINER_ENVIRONMENT);
		expect(args).toContain(SWE_BENCH_MULTILINGUAL_DATASET);
		expect(args).toContain(SWE_BENCH_MULTILINGUAL_REGISTRY);
		expect(args).toContain("openai/gpt-5.6-sol");
		expect(args).toContain("product_agent_dir=/repo/rotom");
		expect(args).toContain("apache__druid-13704");
		expect(args).toContain("--agent-setup-timeout-multiplier");
		expect(args).toContain("5");
	});

	it("runs every repeated explicit task instead of retaining the default one-task cap", () => {
		const options = parseBenchmarkRunnerArgs(
			["terminal-bench-2", "--provider=openai", "--model=gpt", "--task=terminal-bench/task-a", "--task=terminal-bench/task-b"],
			defaults,
			{},
		);
		const args = buildHarborBenchmarkArgs(options, "fixture-run");
		expect(options.nTasks).toBe(2);
		expect(args).toEqual(expect.arrayContaining(["--n-tasks", "2", "--include-task-name", "terminal-bench/task-a", "--include-task-name", "terminal-bench/task-b"]));
		expect(() => parseBenchmarkRunnerArgs(
			["terminal-bench-2", "--provider=openai", "--model=gpt", "--n-tasks=1", "--task=terminal-bench/task-a", "--task=terminal-bench/task-b"],
			defaults,
			{},
		)).toThrow("cannot be smaller");
		expect(() => parseBenchmarkRunnerArgs(
			["terminal-bench-2", "--provider=openai", "--model=gpt", "--all", "--task=terminal-bench/task-a"],
			defaults,
			{},
		)).toThrow("cannot be combined");
	});

	it("builds a Terminal-Bench 2 run and supports an explicit full suite", () => {
		const options = parseBenchmarkRunnerArgs(
			["terminal-bench-2", "--provider", "anthropic", "--model", "claude-opus-4-6", "--all", "--environment=docker"],
			defaults,
			{},
		);
		const args = buildHarborBenchmarkArgs(options, "fixture-run");

		expect(args).toContain(TERMINAL_BENCH_2_DATASET);
		expect(args).toContain("docker");
		expect(args).not.toContain("--n-tasks");
	});

	it("uses eval model environment defaults and preserves non-owned Harbor controls", () => {
		const options = parseBenchmarkRunnerArgs(
			["terminal", "--", "--timeout-multiplier=2", "--debug"],
			defaults,
			{ ROTOM_EVAL_PROVIDER: "openai", ROTOM_EVAL_MODEL: "gpt-5.6-sol" },
		);
		expect(options.passthrough).toEqual(["--timeout-multiplier=2", "--debug"]);
	});

	it("rejects incomplete model selection, relative products, and owned passthrough options", () => {
		expect(() => parseBenchmarkRunnerArgs(["terminal-bench-2", "--provider=openai"], defaults, {})).toThrow(
			"Model",
		);
		expect(() =>
			parseBenchmarkRunnerArgs(
				["terminal-bench-2", "--provider=openai", "--model=gpt", "--product=relative"],
				defaults,
				{},
			),
		).toThrow("absolute");
		expect(() =>
			parseBenchmarkRunnerArgs(
				["terminal-bench-2", "--provider=openai", "--model=gpt", "--", "--agent=oracle"],
				defaults,
				{},
			),
		).toThrow("controlled");
		expect(() =>
			parseBenchmarkRunnerArgs(
				["terminal-bench-2", "--provider=openai", "--model=gpt", "--", "--disable-verification"],
				defaults,
				{},
			),
		).toThrow("controlled");
		expect(() =>
			parseBenchmarkRunnerArgs(
				["terminal-bench-2", "--provider=openai", "--model=gpt", "--setup-timeout-multiplier=0"],
				defaults,
				{},
			),
		).toThrow("positive number");
	});
});
