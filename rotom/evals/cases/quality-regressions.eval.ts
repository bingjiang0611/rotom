import { spawnSync } from "node:child_process";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { inspectQualityTask, qualityRegressionTasks, setupQualityTask } from "../src/quality-regressions.ts";

const enabled = process.env.ROTOM_EVAL_QUALITY_REGRESSIONS === "1";
const product = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
const provider = process.env.ROTOM_EVAL_PROVIDER;
const model = process.env.ROTOM_EVAL_MODEL;
const piExecutable = process.env.ROTOM_PI;
const selected = process.env.ROTOM_EVAL_QUALITY_CASE;
type Output = Awaited<ReturnType<typeof inspectQualityTask>>;

if (!enabled) {
	describe.skip("quality regressions require explicit paid-model opt-in", () => {});
} else {
	if (!product || !provider || !model || !piExecutable) throw new Error("Quality regressions require candidate product, provider, model and ROTOM_PI");
	if (selected && !qualityRegressionTasks.some(task => task.id === selected)) throw new Error(`Unknown quality case: ${selected}`);
	for (const task of qualityRegressionTasks.filter(task => !selected || task.id === selected)) {
		const harness = createPiCodingAgentHarness<Output>({
			name: `quality-${task.id}`,
			model: { provider, id: model },
			thinkingLevel: "medium",
			tools: ["read", "bash", "edit", "write"],
			productAgentDir: product,
			piExecutable,
			noContextFiles: true,
			async setupWorkspace({ workspace }) {
				await setupQualityTask(task, workspace);
				for (const args of [["init", "--quiet"], ["add", "-A"], ["commit", "--quiet", "-m", "synthetic fixture"]]) {
					const result = spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
					if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
				}
			},
			output: ({ workspace }) => inspectQualityTask(task, workspace),
		});
		const judge = createJudge<PiCodingAgentInput, Output>(`Quality-${task.id}`, ({ output }) => ({
			score: Number(output.acceptancePassed && output.scopePreserved),
			metadata: { rationale: JSON.stringify(output), output },
		}));
		describeEval(`Quality regression: ${task.id}`, { harness, judges: [judge], judgeThreshold: 1 }, it => {
			it(task.id, async ({ run }) => {
				await run({ id: task.id, steps: [{ type: "prompt", content: `${task.prompt}\n只修改 ${task.editable}，不要修改其余 fixture 文件或验收脚本。运行测试后交付结果，不提交、不推送。` }] });
			});
		});
	}
}
