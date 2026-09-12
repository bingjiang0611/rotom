import { afterEach } from "vitest";
import type {} from "vitest-evals";
import { recordEvalRunArtifacts } from "./artifacts.ts";

afterEach(async ({ task }) => {
	const run = task.meta.harness?.run;
	if (run) await recordEvalRunArtifacts(task, run);
});
