import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBenchmarkProfileV1 } from "../src/benchmark-profile.ts";

describe("fixed benchmark profiles", () => {
	it("loads the versioned canary with one explicit task per supported benchmark", async () => {
		const content = await readFile(resolve(import.meta.dirname, "../profiles/canary.txt"), "utf8");
		expect(parseBenchmarkProfileV1(content)).toEqual([
			{ benchmark: "swe-bench-multilingual", taskId: "apache__druid-13704" },
			{ benchmark: "terminal-bench-2", taskId: "terminal-bench/make-mips-interpreter" },
		]);
	});

	it("requires the version marker and ignores later comments and blank lines", () => {
		expect(parseBenchmarkProfileV1("# dev-agent-benchmark-profile/v1\n# profile\n\nterminal-bench-2 terminal-bench/task-1\n")).toEqual([
			{ benchmark: "terminal-bench-2", taskId: "terminal-bench/task-1" },
		]);
	});

	it.each([
		["", /must declare/u],
		["# dev-agent-benchmark-profile/v2\nterminal-bench-2 terminal-bench/task-1\n", /must declare/u],
		["# dev-agent-benchmark-profile/v1\n", /at least one task/u],
		["# dev-agent-benchmark-profile/v1\nunknown task-1\n", /unsupported benchmark/u],
		["# dev-agent-benchmark-profile/v1\nterminal-bench-2 task id\n", /must be/u],
		["# dev-agent-benchmark-profile/v1\nterminal-bench-2 --all\n", /invalid task id/u],
		["# dev-agent-benchmark-profile/v1\nterminal-bench-2 terminal-bench/task-1\nterminal-bench-2 terminal-bench/task-1\n", /duplicates/u],
	])("rejects an invalid profile", (content, pattern) => {
		expect(() => parseBenchmarkProfileV1(content)).toThrow(pattern);
	});
});
