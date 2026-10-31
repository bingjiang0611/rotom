import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { assertClosureTool, closureCases, closureFixtureFiles, closureFixturesIntact, closureOutputInstruction, scoreClosure, type ClosureCase, type ClosureOutput } from "../src/task-closure-regressions.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";
import { fixtureExecutionPolicy } from "../src/fixture-tools.ts";
import { createStoppingShadow } from "../src/end-review-shadow.ts";

const enabled = process.env.ROTOM_EVAL_TASK_CLOSURE === "1";
if (!enabled) {
	describe.skip("task closure requires explicit model-eval authorization", () => {});
} else {
	const baseline = process.env.ROTOM_EVAL_BASELINE_PRODUCT;
	const candidate = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
	const provider = process.env.ROTOM_EVAL_PROVIDER;
	const model = process.env.ROTOM_EVAL_MODEL;
	const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "2");
	const selected = process.env.ROTOM_EVAL_CLOSURE_CASE;
	if (!baseline || !candidate || !isAbsolute(baseline) || !isAbsolute(candidate) || !provider || !model) {
		throw new Error("Task closure requires absolute baseline/candidate products and an explicit provider/model.");
	}
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be 1..5.");
	if (selected && !closureCases.some((item) => item.id === selected)) throw new Error("Unknown ROTOM_EVAL_CLOSURE_CASE.");
	const executables = new Map<string, string>();
	for (const product of new Set([baseline, candidate])) {
		const { resolveInstalledPi } = await import(pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href);
		executables.set(product, await resolveInstalledPi(product));
	}
	function harness(name: string, product: string, item: ClosureCase) {
		let verifications: string[] = [];
		const shadow = name === "candidate" && process.env.ROTOM_EVAL_STOPPING_SHADOW === "1" ? createStoppingShadow({
			product, tasks: [`${item.task}\n\n${closureOutputInstruction}`],
			files: [...Object.keys(closureFixtureFiles(item)), "verification.json"],
			fixturesIntact: workspace => closureFixturesIntact(workspace, item), latestVerification: () => verifications.at(-1),
		}) : undefined;
		return createPiCodingAgentHarness<ClosureOutput>({
			name, productAgentDir: product, piExecutable: executables.get(product),
			model: { provider: provider!, id: model! }, thinkingLevel: "high", tools: ["read", "edit", "bash"],
			environment: { ROTOM_OBSERVABILITY: "0" },
			environmentProfile: shadow ? "stopping-shadow-v1" : undefined,
			continuePrompt: shadow?.continuePrompt,
			inlineExtensions: [...(shadow ? [shadow.extension] : []), (pi) => {
				verifications = [];
				let turns = 0;
				const admittedVerifications = new Set<string>();
				pi.on("before_agent_start", (event) => {
					if (pi.getActiveTools().slice().sort().join(",") !== "bash,edit,read") throw new Error("Unexpected active tool surface.");
					return { systemPrompt: `${event.systemPrompt}\n\n${fixtureExecutionPolicy}` };
				});
				pi.on("turn_start", (_event, ctx) => { if (++turns > 12) ctx.abort(); });
				pi.on("tool_call", async (event, ctx) => {
					await assertClosureTool(ctx.cwd, item, event.toolName, event.input);
					if (event.toolName === "bash") admittedVerifications.add(event.toolCallId);
				});
				pi.on("tool_result", async (event, ctx) => {
					if (admittedVerifications.delete(event.toolCallId) && !event.isError) {
						verifications.push(await readFile(join(ctx.cwd, "verification.json"), "utf8"));
					}
				});
			}],
			async setupWorkspace({ workspace, configDir }) {
				for (const [file, body] of Object.entries(closureFixtureFiles(item))) {
					await writeFile(join(workspace, file), body, { flag: "wx", mode: file.endsWith(".json") ? 0o600 : 0o400 });
				}
				await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }), { flag: "wx", mode: 0o600 });
			},
			async output({ workspace, response, session }) {
				const files: Record<string, string> = {};
				for (const file of ["layout.json", "package-config.json", "smoke.json"]) files[file] = await readFile(join(workspace, file), "utf8");
				return {
					response, files, verifications,
					stopReason: session.messages.filter((message) => message.role === "assistant").at(-1)?.stopReason ?? "unknown",
					fixturesIntact: await closureFixturesIntact(workspace, item),
					toolErrors: session.messages.filter((message) => message.role === "toolResult" && message.isError).length,
				};
			},
		});
	}
	for (const item of closureCases.filter((entry) => !selected || selected === entry.id)) {
		const judge = createJudge<PiCodingAgentInput, ClosureOutput>(`closure-${item.id}`, ({ output }) => {
			const result = scoreClosure(item, output);
			return { score: result.score, metadata: { output: { ...result.checks, toolErrors: output.toolErrors } } };
		});
		const planned = evalHarnessTable(`task-closure-${item.id}`, { baseline: harness("baseline", baseline, item), candidate: harness("candidate", candidate, item), repetitions });
		for (let repetition = 1; repetition <= repetitions; repetition++) {
			const rows = planned.filter((row) => row.repetition === repetition);
			if (repetition % 2 === 0) rows.reverse();
			for (const row of rows) describeEval(`${item.id}: ${row.name} repetition ${repetition}`, {
				harness: row.harness, judges: [judge], judgeThreshold: row.name === "candidate" ? 1 : null,
			}, (it) => {
				it("finish local repairs without weakening acceptance; hand off only the device blocker", async ({ run }) => {
					await run({ id: item.id, steps: [{ type: "prompt", content: `${item.task}\n\n${closureOutputInstruction}` }] });
				});
			});
		}
	}
}
