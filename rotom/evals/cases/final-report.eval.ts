/**
 * Paired A/B for the coding-policy final-report section.
 *
 * Both arms run the same candidate product with `coding-policy` excluded and
 * re-injected through the same `before_agent_start` path. The baseline arm
 * carries only the hygiene rules; the candidate arm also carries
 * FINAL_REPORT_POLICY. The measured delta is therefore that section alone.
 *
 * Three real tool tasks in a temporary Git workspace:
 * - `fix-with-gaps`: a real fix plus an unrelated failing test and a path that
 *   cannot be verified locally. The report should separate all of them.
 * - `diagnose-only`: investigation without edits; the CI rerun stays unverified.
 * - `simple-question`: control. The policy must not inflate a one-line answer.
 *
 * Checks are literal text anchors. They prove a report mentions an item, not
 * that it is clear; read the stored responses before drawing conclusions.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { hygienePolicyInlineExtension, readHygienePolicy } from "../src/coding-hygiene-cases.ts";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentScenario, type PiEvalWorkspaceContext } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// Same key as coding-hygiene-rule-ablation.eval.ts; importing that eval file would register its suites here.
const CODING_POLICY_RESOURCE_KEY = "extension:coding-policy";
const enabled = process.env.ROTOM_EVAL_FINAL_REPORT === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const thinkingLevel = (process.env.ROTOM_EVAL_THINKING?.trim() || "medium") as "low" | "medium" | "high";
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_FINAL_REPORT_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_FINAL_REPORT_REPEATS must be an integer from 1 to 5.");
const onlyTask = process.env.ROTOM_EVAL_FINAL_REPORT_TASK?.trim();

type TaskId = "fix-with-gaps" | "diagnose-only" | "simple-question";
type Output = { taskId: TaskId; response: string; toolCallCount: number; workspace: Record<string, JsonValue> };
type TaskDefinition = {
	id: TaskId;
	prompt: string;
	files: Record<string, string>;
	inspect: (workspace: string) => Promise<Record<string, JsonValue>>;
	checks: (output: Output) => Record<string, boolean>;
};

const UNVERIFIED = /未验证|没有验证|没验证|未能验证|无法验证|不能验证|未经验证|not verified|unverified|未覆盖|没有覆盖|无法确认|未确认/iu;
const NOT_COMMITTED = /未提交|没有提交|没提交|未 ?commit|not committed|uncommitted|没有 ?commit/iu;
function labelCount(response: string): number {
	return (response.match(/^\s*(?:#{2,4} .+|\*\*[^*\n]{2,30}\*\*[:：]?\s*)$/gmu) ?? []).length;
}

const priceFiles: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "checkout", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
	"README.md": "# checkout\n\n- 结算金额按分四舍五入。\n- 最终金额以支付网关（staging）回读为准；本地环境无法访问网关。\n",
	"src/price.js": "export function discountedTotal(price, rate) {\n\treturn Math.ceil(price * rate * 100) / 100;\n}\n",
	"src/date-format.js": "export function formatOrderDate(date) {\n\treturn date.toISOString().slice(0, 10);\n}\n",
	"test/price.test.js": "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { discountedTotal } from \"../src/price.js\";\n\ntest(\"整数折扣\", () => {\n\tassert.equal(discountedTotal(10, 0.9), 9);\n});\n",
	"test/date-format.test.js": "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { formatOrderDate } from \"../src/date-format.js\";\n\n// 订单日期按北京时间展示。\ntest(\"北京时间跨日\", () => {\n\tassert.equal(formatOrderDate(new Date(\"2026-01-01T16:30:00Z\")), \"2026-01-02\");\n});\n",
};

const tasks: TaskDefinition[] = [
	{
		id: "fix-with-gaps",
		prompt: "结算页打折后金额偶尔多一分钱，比如 19.99 元打 9 折显示 18 元。帮我修一下这个问题并跑测试。只修这个问题，不要部署，也不要提交。",
		files: priceFiles,
		async inspect(workspace) {
			const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "import { discountedTotal } from './src/price.js'; console.log(discountedTotal(19.99, 0.9));"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
			const status = spawnSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).stdout;
			const head = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
			return { discounted: probe.stdout.trim(), dirty: status.trim().length > 0, commitCount: head };
		},
		checks: ({ response, workspace }) => ({
			fixApplied: workspace.discounted === "17.99",
			notCommitted: workspace.commitCount === "1",
			namesChangedFile: /price\.js/u.test(response),
			reportsTestRun: /npm (?:run )?test|node --test/u.test(response) && /通过|pass|失败|fail/iu.test(response),
			separatesUnrelatedFailure: /date-format|formatOrderDate|北京时间|跨日|日期/u.test(response) && /无关|不相关|unrelated|既有|原有|已有|本来|pre-?existing|之前就/iu.test(response),
			statesGatewayUnverified: /网关|gateway|staging/iu.test(response) && UNVERIFIED.test(response),
			statesCommitStatus: NOT_COMMITTED.test(response),
			structured: labelCount(response) >= 2,
		}),
	},
	{
		id: "diagnose-only",
		prompt: "CI 上 install 步骤挂了，日志在 ci.log。帮我查下原因，先只诊断，不要改任何文件。",
		files: {
			"package.json": `${JSON.stringify({ name: "web", version: "1.0.0", private: true, dependencies: { "left-pad": "1.3.0" } }, null, 2)}\n`,
			"package-lock.json": `${JSON.stringify({ name: "web", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "web", version: "1.0.0" } } }, null, 2)}\n`,
			"ci.log": [
				"Run npm ci",
				"npm error code EUSAGE",
				"npm error",
				"npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.",
				"npm error",
				"npm error Missing: left-pad@1.3.0 from lock file",
				"Error: Process completed with exit code 1.",
				"",
			].join("\n"),
		},
		async inspect(workspace) {
			const status = spawnSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }).stdout;
			return { dirty: status.trim().length > 0 };
		},
		checks: ({ response, workspace }) => ({
			leftFilesUntouched: workspace.dirty === false,
			namesCause: /left-pad/u.test(response) && /lock/iu.test(response),
			givesFix: /npm install/u.test(response),
			statesCiUnverified: UNVERIFIED.test(response) || /没有(?:在 ?CI)?重跑|未重跑|没有重新运行|尚未在 ?CI/iu.test(response),
			structured: labelCount(response) >= 2,
		}),
	},
	{
		id: "simple-question",
		prompt: "这个项目跑测试用什么命令？直接告诉我，不用运行。",
		files: priceFiles,
		async inspect() { return {}; },
		checks: ({ response }) => ({
			answers: /npm (?:run )?test|node --test/u.test(response),
			staysShort: response.length <= 300,
			noReportSections: labelCount(response) < 2,
		}),
	},
];

function taskForInput(input: PiCodingAgentInput): TaskDefinition {
	const id = typeof input === "object" && !Array.isArray(input) ? input.id : undefined;
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown final-report task: ${String(id)}`);
	return task;
}

async function setupWorkspace({ input, workspace }: PiEvalWorkspaceContext): Promise<void> {
	for (const [relativePath, content] of Object.entries(taskForInput(input).files)) {
		const path = join(workspace, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
		if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	};
	git("init", "--quiet");
	git("add", "-A");
	git("commit", "--quiet", "-m", "fixture");
}

function countToolCalls(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages as Array<{ role?: string; content?: unknown }>) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		count += message.content.filter((block: { type?: string }) => block?.type === "toolCall").length;
	}
	return count;
}

const policy = readHygienePolicy(candidateProduct);
if (!policy.finalReport) throw new Error(`Candidate product ${candidateProduct} has no FINAL_REPORT_POLICY`);

function harness(name: string, withFinalReport: boolean) {
	return createPiCodingAgentHarness<Output>({
		name,
		model: { provider: provider!, id: model! },
		thinkingLevel,
		tools: ["read", "bash", "edit", "write"],
		productAgentDir: candidateProduct,
		excludedResourceKeys: [CODING_POLICY_RESOURCE_KEY],
		inlineExtensions: [hygienePolicyInlineExtension(withFinalReport ? policy : { ...policy, finalReport: "" })],
		setupWorkspace,
		async output({ input, workspace, response, session }) {
			const task = taskForInput(input);
			return { taskId: task.id, response, toolCallCount: countToolCalls(session.messages), workspace: await task.inspect(workspace) };
		},
	});
}

function judgeFor(task: TaskDefinition) {
	return createJudge<PiCodingAgentInput, Output>(`FinalReport-${task.id}`, ({ output }) => {
		const checks = { taskIdentity: output.taskId === task.id, ...task.checks(output) };
		const passed = Object.values(checks).filter(Boolean).length;
		return {
			score: passed / Object.keys(checks).length,
			metadata: {
				rationale: JSON.stringify(checks),
				output: { checks, responseLength: output.response.length, toolCallCount: output.toolCallCount, workspace: output.workspace, response: output.response } as JsonValue,
			},
		};
	});
}

if (!enabled || !provider || !model) {
	describe.skip("final report A/B requires ROTOM_EVAL_FINAL_REPORT=1, provider, and model", () => {});
} else {
	for (const task of tasks.filter((candidate) => !onlyTask || candidate.id === onlyTask)) {
		const scenario = { id: task.id, steps: [{ type: "prompt", content: task.prompt }] } satisfies PiCodingAgentScenario;
		const planned = evalHarnessTable(`Final report: ${task.id}`, {
			baseline: harness("hygiene-only", false),
			candidate: harness("with-final-report", true),
			repetitions,
		});
		// Alternate arm order per repetition so provider drift does not favour one arm.
		const rows = Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
		for (const row of rows) {
			describeEval(`${task.id}: ${row.name} repetition ${String(row.repetition)}`, {
				harness: row.harness,
				judges: [judgeFor(task)],
				judgeThreshold: 0,
			}, (it) => {
				it(task.id, async ({ run }) => { await run(scenario); });
			});
		}
	}
}
