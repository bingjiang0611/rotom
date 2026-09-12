import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const jsonReport = process.env.ROTOM_EVAL_JSON_REPORT?.trim();

export default defineConfig({
	cacheDir: process.env.ROTOM_EVAL_CACHE_DIR?.trim() || undefined,
	test: {
		environment: "node",
		fileParallelism: false,
		include: ["cases/**/*.eval.ts"],
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
