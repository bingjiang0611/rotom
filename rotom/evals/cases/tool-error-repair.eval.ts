import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentOutputContext, type PiCodingAgentScenario, type PiEvalWorkspaceContext } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

/**
 * Paired A/B for the product's read/edit failure evidence (coding-policy
 * repair hints). Both variants get the identical prompt, workspace and tool
 * allowlist; only the loaded product differs, so the measured delta is the
 * hint content itself.
 *
 * The tasks are recoverable without the hint on purpose: `bash` stays in the
 * allowlist so the baseline can locate the real path or the unique context the
 * documented way. The comparison is therefore steps-to-correct-outcome and
 * blind-retry behaviour, not "candidate can, baseline cannot".
 */

const enabled = process.env.ROTOM_EVAL_TOOL_ERROR_REPAIR === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const baselineProduct = process.env.ROTOM_EVAL_BASELINE_PRODUCT?.trim();
const candidateProduct = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error("ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS must be an integer from 1 to 5.");

const MARKER = "RECORDER_MARKER_7F3A9C";

type TaskId = "missing-path-recovery" | "ambiguous-edit-target";
type Output = {
	taskId: TaskId;
	response: string;
	toolNames: string[];
	toolCallCount: number;
	repeatedFailingReadPaths: number;
	files: Record<string, string>;
};

type TaskDefinition = {
	id: TaskId;
	label: string;
	/**
	 * Per-task allowlist. `missing-path-recovery` deliberately omits bash so the
	 * first read must fail; recovery stays possible for both variants because
	 * src/index.ts re-exports the real module path.
	 */
	tools: string[];
	prompt: string;
	setup: (workspace: string) => Promise<void>;
	checks: (output: Output) => Record<string, boolean>;
};

async function writeFixture(workspace: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(workspace, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
}

async function readFixture(workspace: string, relativePaths: string[]): Promise<Record<string, string>> {
	const entries = await Promise.all(relativePaths.map(async (relativePath) => {
		try {
			return [relativePath, await readFile(join(workspace, relativePath), "utf8")] as const;
		} catch {
			return [relativePath, ""] as const;
		}
	}));
	return Object.fromEntries(entries);
}

const tasks: TaskDefinition[] = [
	{
		id: "missing-path-recovery",
		label: "missing read path recovery",
		tools: ["read", "edit"],
		prompt: `Report the exact string value assigned to RECORDER_MARKER in src/turn-recorde.ts. Answer with that value on the last line, prefixed by "value: ". Do not modify any file.`,
		async setup(workspace) {
			await writeFixture(workspace, {
				"src/turn-recorder.ts": `export const RECORDER_MARKER = "${MARKER}";\nexport const RECORDER_VERSION = 3;\n`,
				"src/turn-reducer.ts": "export const REDUCER_MARKER = \"unrelated-reducer\";\n",
				"src/index.ts": "export * from \"./turn-recorder.ts\";\n",
				"README.md": "Fixture workspace.\n",
			});
		},
		checks: (output) => ({
			reportsMarker: output.response.includes(MARKER),
			noBlindRetryOfMissingPath: output.repeatedFailingReadPaths === 0,
			leftFilesIntact: output.files["src/turn-recorder.ts"].includes(`RECORDER_MARKER = "${MARKER}"`),
		}),
	},
	{
		id: "ambiguous-edit-target",
		label: "ambiguous edit target",
		tools: ["read", "edit", "bash"],
		prompt: `In src/render.ts, only the call inside renderFooter must become flushLayout("footer");. The identical calls inside renderHeader and renderBody must stay exactly as they are. Apply the change.`,
		async setup(workspace) {
			await writeFixture(workspace, {
				"src/render.ts": [
					"export function renderHeader() {",
					"\tflushLayout();",
					"}",
					"",
					"export function renderBody() {",
					"\tflushLayout();",
					"}",
					"",
					"export function renderFooter() {",
					"\tflushLayout();",
					"}",
					"",
					"function flushLayout(_scope?: string) {}",
					"",
				].join("\n"),
			});
		},
		checks: (output) => {
			const content = output.files["src/render.ts"];
			const footer = /export function renderFooter\(\) \{\n\tflushLayout\("footer"\);\n\}/u.test(content);
			const header = /export function renderHeader\(\) \{\n\tflushLayout\(\);\n\}/u.test(content);
			const body = /export function renderBody\(\) \{\n\tflushLayout\(\);\n\}/u.test(content);
			return {
				footerChanged: footer,
				headerUntouched: header,
				bodyUntouched: body,
				onlyOneScopedCall: (content.match(/flushLayout\("footer"\)/gu) ?? []).length === 1,
			};
		},
	},
];

function taskForInput(input: PiCodingAgentInput): TaskDefinition {
	const id = !Array.isArray(input) && typeof input === "object" ? input.id : undefined;
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown tool-error-repair task: ${String(id)}`);
	return task;
}

function collectToolNames(messages: PiCodingAgentOutputContext["session"]["messages"]): string[] {
	const names: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			names.push(part.name);
		}
	}
	return names;
}

/** Counts read calls that repeat a path an earlier read already failed on. */
function repeatedFailingReadPaths(messages: PiCodingAgentOutputContext["session"]["messages"], workspace: string): number {
	const failed = new Set<string>();
	const repeats = new Set<string>();
	const byCallId = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall" || part.name !== "read") continue;
				const path = (part.arguments as { path?: unknown } | undefined)?.path;
				if (typeof path !== "string") continue;
				const key = resolve(workspace, path);
				byCallId.set(part.id, key);
				if (failed.has(key)) repeats.add(`${part.id}:${key}`);
			}
			continue;
		}
		if (message.role !== "toolResult" || !message.isError) continue;
		const key = byCallId.get(message.toolCallId);
		if (key) failed.add(key);
	}
	return repeats.size;
}

async function setupWorkspace({ input, workspace }: PiEvalWorkspaceContext): Promise<void> {
	await taskForInput(input).setup(workspace);
	const initialized = spawnSync("git", ["init", "--quiet"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
	if (initialized.status !== 0) throw new Error(`Failed to initialize eval Git repository: ${initialized.stderr}`);
}

function harness(name: string, productAgentDir: string, tools: string[]) {
	return createPiCodingAgentHarness<Output>({
		name,
		model: { provider: provider!, id: model! },
		thinkingLevel: "low",
		tools,
		productAgentDir,
		setupWorkspace,
		async output({ input, workspace, response, session }) {
			const task = taskForInput(input);
			const names = collectToolNames(session.messages);
			return {
				taskId: task.id,
				response: response.length > 4_000 ? `${response.slice(0, 4_000)}…` : response,
				toolNames: names,
				toolCallCount: names.length,
				repeatedFailingReadPaths: repeatedFailingReadPaths(session.messages, workspace),
				files: await readFixture(workspace, task.id === "missing-path-recovery" ? ["src/turn-recorder.ts"] : ["src/render.ts"]),
			};
		},
	});
}

function judgeFor(task: TaskDefinition) {
	return createJudge<PiCodingAgentInput, Output>(`ToolErrorRepair-${task.id}`, ({ output }) => {
		const checks = { taskIdentity: output.taskId === task.id, ...task.checks(output) };
		const passed = Object.values(checks).every(Boolean);
		return {
			score: passed ? 1 : 0,
			metadata: {
				rationale: JSON.stringify(checks),
				output: {
					checks,
					toolCallCount: output.toolCallCount,
					repeatedFailingReadPaths: output.repeatedFailingReadPaths,
					toolNames: output.toolNames,
				} as JsonValue,
			},
		};
	});
}

if (!enabled || !provider || !model || !baselineProduct) {
	describe.skip("tool-error repair A/B requires ROTOM_EVAL_TOOL_ERROR_REPAIR=1, provider, model, and ROTOM_EVAL_BASELINE_PRODUCT", () => {});
} else {
	const baselineProductPath = baselineProduct;
	for (const task of tasks) {
		const scenario = { id: task.id, steps: [{ type: "prompt", content: task.prompt }] } satisfies PiCodingAgentScenario;
		const planned = evalHarnessTable(`Tool error repair: ${task.label}`, {
			baseline: harness("baseline", baselineProductPath, task.tools),
			candidate: harness("candidate", candidateProduct, task.tools),
			repetitions,
		});
		const rows = Array.from({ length: repetitions }, (_, index) => {
			const repeated = planned.filter(({ repetition }) => repetition === index + 1);
			return index % 2 === 0 ? repeated : [...repeated].reverse();
		}).flat();
		for (const row of rows) {
			describeEval(`${task.label}: ${row.name} repetition ${String(row.repetition)}`, {
				harness: row.harness,
				judges: [judgeFor(task)],
				judgeThreshold: 1,
			}, (it) => {
				it(task.label, async ({ run }) => { await run(scenario); });
			});
		}
	}
}
