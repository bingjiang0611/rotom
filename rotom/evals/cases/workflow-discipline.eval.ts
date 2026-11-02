import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "../src/pi-harness.ts";
import { assertFixtureTool, fixtureExecutionPolicyFor, fixturesIntact, readEditableFiles } from "../src/fixture-tools.ts";
import {
	scoreWorkflowDiscipline,
	workflowDisciplineCases,
	type WorkflowDisciplineCase,
	type WorkflowDisciplineOutput,
	type WorkflowToolEvent,
} from "../src/workflow-discipline-regressions.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const enabled = process.env.ROTOM_EVAL_WORKFLOW_DISCIPLINE === "1";
if (!enabled) {
	describe.skip("workflow discipline requires explicit model-eval authorization", () => {});
} else {
	const baseline = process.env.ROTOM_EVAL_BASELINE_PRODUCT;
	const candidate = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT;
	const provider = process.env.ROTOM_EVAL_PROVIDER;
	const model = process.env.ROTOM_EVAL_MODEL;
	const repetitions = Number(process.env.ROTOM_EVAL_REPEATS ?? "2");
	const selected = process.env.ROTOM_EVAL_WORKFLOW_DISCIPLINE_CASE;
	if (!baseline || !candidate || !isAbsolute(baseline) || !isAbsolute(candidate) || !provider || !model) {
		throw new Error("Workflow discipline requires absolute baseline/candidate products and an explicit provider/model.");
	}
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_REPEATS must be 1..5.");
	if (selected && !workflowDisciplineCases.some((item) => item.id === selected)) throw new Error("Unknown ROTOM_EVAL_WORKFLOW_DISCIPLINE_CASE.");
	const executables = new Map<string, string>();
	for (const product of new Set([baseline, candidate])) {
		const { resolveInstalledPi } = await import(pathToFileURL(join(product, "runtime/resolve-installed-pi.mjs")).href);
		executables.set(product, await resolveInstalledPi(product));
	}

	function harness(name: string, product: string, item: WorkflowDisciplineCase) {
		const fixture = item.fixture;
		let events: WorkflowToolEvent[] = [];
		let editHistory: Record<string, string>[] = [];
		return createPiCodingAgentHarness<WorkflowDisciplineOutput>({
			name,
			productAgentDir: product,
			piExecutable: executables.get(product),
			model: { provider: provider!, id: model! },
			thinkingLevel: "high",
			tools: ["read", "edit", "bash"],
			environment: { ROTOM_OBSERVABILITY: "0" },
			inlineExtensions: [(pi) => {
				events = [];
				editHistory = [];
				let turns = 0;
				const admitted = new Map<string, string>();
				pi.on("before_agent_start", (event) => {
					if (pi.getActiveTools().slice().sort().join(",") !== "bash,edit,read") throw new Error("Unexpected active tool surface.");
					return { systemPrompt: `${event.systemPrompt}\n\n${fixtureExecutionPolicyFor(fixture)}` };
				});
				pi.on("turn_start", (_event, ctx) => { if (++turns > 16) ctx.abort(); });
				pi.on("tool_call", async (event, ctx) => {
					await assertFixtureTool(ctx.cwd, fixture, event.toolName, event.input);
					admitted.set(event.toolCallId, event.toolName);
					const input = event.input as Record<string, unknown>;
					events.push({
						name: event.toolName,
						command: typeof input.command === "string" ? input.command : undefined,
						path: typeof input.path === "string" ? input.path : undefined,
					});
				});
				pi.on("tool_result", async (event, ctx) => {
					const tool = admitted.get(event.toolCallId);
					admitted.delete(event.toolCallId);
					if (!event.isError && tool === "edit") editHistory.push(await readEditableFiles(ctx.cwd, fixture));
				});
			}],
			async setupWorkspace({ workspace, configDir }) {
				for (const [file, body] of Object.entries(fixture.files)) {
					await writeFile(join(workspace, file), body, { flag: "wx", mode: fixture.editable.includes(file) ? 0o600 : 0o400 });
				}
				await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }), { flag: "wx", mode: 0o600 });
			},
			async output({ workspace, response, session }) {
				const messages = session.messages.filter((message) => message.role === "assistant");
				const phaseReports = messages.filter((message) => message.stopReason === "stop").map((message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
				const generated = Object.fromEntries(await Promise.all((fixture.generated ?? ["verification.json"]).map(async (file) => {
					try { return [file, await readFile(join(workspace, file), "utf8")] as const; }
					catch { return [file, ""] as const; }
				})));
				return {
					response,
					stopReason: messages.at(-1)?.stopReason ?? "unknown",
					files: await readEditableFiles(workspace, fixture),
					generated,
					fixturesIntact: await fixturesIntact(workspace, fixture),
					phaseReports,
					events,
					editHistory,
					toolErrors: session.messages.filter((message) => message.role === "toolResult" && message.isError).length,
				};
			},
		});
	}

	for (const item of workflowDisciplineCases.filter((entry) => !selected || selected === entry.id)) {
		const judge = createJudge<PiCodingAgentInput, WorkflowDisciplineOutput>(`workflow-discipline-${item.id}`, ({ output }) => {
			const result = scoreWorkflowDiscipline(item, output);
			return { score: result.score, metadata: { output: { ...result.checks, toolErrors: output.toolErrors, completedPrompts: output.phaseReports.length } } };
		});
		const planned = evalHarnessTable(`workflow-discipline-${item.id}`, {
			baseline: harness("baseline", baseline, item),
			candidate: harness("candidate", candidate, item),
			repetitions,
		});
		for (let repetition = 1; repetition <= repetitions; repetition++) {
			const rows = planned.filter((row) => row.repetition === repetition);
			if (repetition % 2 === 0) rows.reverse();
			for (const row of rows) describeEval(`${item.id}: ${row.name} repetition ${repetition}`, {
				harness: row.harness,
				judges: [judge],
				judgeThreshold: row.name === "candidate" ? 1 : null,
			}, (it) => {
				it(item.label, async ({ run }) => {
					await run({ id: item.id, steps: item.steps.map((content) => ({ type: "prompt" as const, content })) });
				});
			});
		}
	}
}
