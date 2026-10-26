import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chmod } from "node:fs/promises";
import { describe } from "vitest";
import { describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import {
	behavioralCases,
	behavioralJudge,
	type BehavioralCase,
	type BehavioralOutput,
	type ToolCallRecord,
} from "../src/behavioral-regression-cases.ts";
import {
	createPiCodingAgentHarness,
	type PiCodingAgentInput,
	type PiCodingAgentOutputContext,
	type PiCodingAgentScenario,
	type PiEvalWorkspaceContext,
} from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

/**
 * Behavioural A/B: the same workspace and tool allowlist, only the loaded
 * product differs. Each case gives the agent real work and judges the tool
 * calls, published files and final reply, so a passing score means the run
 * actually behaved, not that it knew the rule.
 *
 * Gated like the other behavioural suites: `ROTOM_EVAL_BEHAVIORAL_REGRESSION=1`
 * plus provider, model and a baseline product. Nothing here touches real
 * sessions.
 */
const enabled = process.env.ROTOM_EVAL_BEHAVIORAL_REGRESSION === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baselineProduct = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_BEHAVIORAL_REGRESSION_REPEATS ?? "1");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_BEHAVIORAL_REGRESSION_REPEATS must be an integer from 1 to 5.");

function toolCalls(messages: PiCodingAgentOutputContext["session"]["messages"]): ToolCallRecord[] {
	const calls: ToolCallRecord[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			calls.push({ name: part.name, args: (part.arguments ?? {}) as Record<string, unknown> });
		}
	}
	return calls;
}

async function readObserved(workspace: string, paths: string[]): Promise<Record<string, string>> {
	const entries = await Promise.all(paths.map(async (relativePath) => {
		try { return [relativePath, await readFile(join(workspace, relativePath), "utf8")] as const; }
		catch { return [relativePath, ""] as const; }
	}));
	return Object.fromEntries(entries);
}

async function writeFixture(caseDefinition: BehavioralCase, workspace: string): Promise<void> {
	for (const [relativePath, content] of Object.entries(caseDefinition.fixture)) {
		const path = join(workspace, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	for (const relativePath of caseDefinition.executables ?? []) await chmod(join(workspace, relativePath), 0o755);
}

async function setupWorkspace({ input, workspace }: PiEvalWorkspaceContext): Promise<void> {
	const id = !Array.isArray(input) && typeof input === "object" ? input.id : undefined;
	const caseDefinition = behavioralCases.find((item) => item.id === id);
	if (!caseDefinition) throw new Error(`Unknown behavioural case: ${String(id)}`);
	await writeFixture(caseDefinition, workspace);
	// Cases run inside a Git worktree so the product's own hygiene rules see a
	// normal repository instead of an unversioned directory.
	const initialized = spawnSync("git", ["init", "--quiet"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
	if (initialized.status !== 0) throw new Error(`Failed to initialize eval Git repository: ${initialized.stderr}`);
}

function harness(name: string, productAgentDir: string, caseDefinition: BehavioralCase) {
	return createPiCodingAgentHarness<BehavioralOutput & JsonValue>({
		name,
		model: { provider: provider!, id: model! },
		thinkingLevel: "low",
		tools: caseDefinition.tools,
		productAgentDir,
		setupWorkspace,
		async output({ input, workspace, response, session }) {
			const id = !Array.isArray(input) && typeof input === "object" ? input.id : undefined;
			const resolved = behavioralCases.find((item) => item.id === id) ?? caseDefinition;
			const calls = toolCalls(session.messages);
			return {
				caseId: resolved.id,
				response: response.length > 6_000 ? `${response.slice(0, 6_000)}…` : response,
				calls: calls as unknown as JsonValue,
				files: (await readObserved(workspace, resolved.observe)) as unknown as JsonValue,
				toolCallCount: calls.length,
			} as BehavioralOutput & JsonValue;
		},
	});
}

if (!enabled || !provider || !model || !baselineProduct) {
	describe.skip("behavioural regression requires ROTOM_EVAL_BEHAVIORAL_REGRESSION=1, provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const baselineProductPath = baselineProduct;
	for (const caseDefinition of behavioralCases) {
		const scenario = { id: caseDefinition.id, steps: [{ type: "prompt", content: caseDefinition.prompt }] } satisfies PiCodingAgentScenario;
		const planned = evalHarnessTable(`Behavioural regression: ${caseDefinition.label}`, {
			baseline: harness("baseline", baselineProductPath, caseDefinition),
			candidate: harness("candidate", candidateProduct, caseDefinition),
			repetitions,
		});
		const rows = Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
		for (const row of rows) {
			describeEval(`${caseDefinition.label}: ${row.name} repetition ${String(row.repetition)}`, {
				harness: row.harness,
				judges: [behavioralJudge(caseDefinition)],
				judgeThreshold: 1,
			}, (it) => {
				it(caseDefinition.label, async ({ run }) => { await run(scenario); });
			});
		}
	}
}
