import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const jsonReport = process.env.ROTOM_EVAL_JSON_REPORT?.trim();
const focusedCompactionTest = "test/compaction-offload-eval.test.ts";
const explicitCompactionTest = process.argv.some((arg) => resolve(arg) === resolve(focusedCompactionTest));

export default defineConfig({
	cacheDir: process.env.ROTOM_EVAL_CACHE_DIR?.trim() || undefined,
	test: {
		environment: "node",
		fileParallelism: false,
		// Honor the explicit focused command without adding unit runs to ordinary evals.
		include: explicitCompactionTest ? [focusedCompactionTest] : ["cases/**/*.eval.ts"],
		passWithNoTests: true,
		testTimeout: 120_000,
		hookTimeout: 30_000,
		setupFiles: ["./src/vitest-evals/setup.ts"],
		reporters: [
			"vitest-evals/reporter",
			"./src/vitest-evals/reporter.ts",
			...(jsonReport ? [["json", { outputFile: resolve(jsonReport) }] as ["json", { outputFile: string }]] : []),
		],
	},
});
