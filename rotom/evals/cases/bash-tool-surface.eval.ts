import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import type { JsonValue } from "vitest-evals/harness";
import {
	createPiCodingAgentHarness,
	type PiCodingAgentInput,
	type PiCodingAgentOutputContext,
	type PiCodingAgentScenario,
	type PiEvalWorkspaceContext,
} from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

const enabled = process.env.ROTOM_EVAL_BASH_TOOL_SURFACE === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const productAgentDir = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const repetitions = Number(process.env.ROTOM_EVAL_BASH_TOOL_SURFACE_REPEATS ?? "2");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 5) {
	throw new Error("ROTOM_EVAL_BASH_TOOL_SURFACE_REPEATS must be an integer from 1 to 5.");
}

type TaskId = "multi-file-api-rename" | "focused-bug-fix";
type Verification = { status: number | null; stdout: string; stderr: string };
type Output = {
	taskId: TaskId;
	response: string;
	verification: Verification;
	hiddenVerification: Verification;
	sourceChecks: Record<string, boolean>;
	toolCallsByName: Record<string, number>;
};

type TaskDefinition = {
	id: TaskId;
	label: string;
	prompt: string;
	setup: (workspace: string) => Promise<void>;
	verify: (workspace: string) => Promise<Pick<Output, "verification" | "hiddenVerification" | "sourceChecks">>;
};

function clipped(value: string, maximum = 2_000): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum)}\n...[truncated ${String(value.length - maximum)} chars]`;
}

function run(workspace: string, command: string, args: string[]): Verification {
	const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024 });
	return {
		status: result.status,
		stdout: clipped(result.stdout ?? ""),
		stderr: clipped(result.stderr ?? result.error?.message ?? ""),
	};
}

async function writeFixture(workspace: string, files: Record<string, string>): Promise<void> {
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(workspace, relativePath);
		await mkdir(resolve(path, ".."), { recursive: true });
		await writeFile(path, content);
	}
}

async function readFixture(workspace: string, relativePaths: string[]): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
		try {
			return [relativePath, await readFile(join(workspace, relativePath), "utf8")] as const;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [relativePath, ""] as const;
			throw error;
		}
	})));
}

const tasks: readonly TaskDefinition[] = [
	{
		id: "multi-file-api-rename",
		label: "multi-file API rename",
		prompt: "Work directly in this repository. Rename the chargeCustomer object API field and the order field from customerId to accountId across the implementation, caller, and tests. Preserve behavior, do not leave compatibility aliases, and run the repository test script. Do not only explain the change: inspect and modify the files, verify the result, then summarize briefly.",
		async setup(workspace) {
			await writeFixture(workspace, {
				"package.json": `${JSON.stringify({ private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
				"src/billing.mjs": `export function chargeCustomer({ customerId, amountCents }) {\n\treturn { account: customerId, receipt: \`${"${customerId}:${amountCents}"}\` };\n}\n`,
				"src/checkout.mjs": `import { chargeCustomer } from "./billing.mjs";\n\nexport function checkout(order) {\n\treturn chargeCustomer({ customerId: order.customerId, amountCents: order.totalCents });\n}\n`,
				"test/billing.test.mjs": `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { checkout } from "../src/checkout.mjs";\n\ntest("checkout returns an account receipt", () => {\n\tassert.deepEqual(checkout({ customerId: "acct-7", totalCents: 1200 }), { account: "acct-7", receipt: "acct-7:1200" });\n});\n`,
			});
		},
		async verify(workspace) {
			const paths = ["src/billing.mjs", "src/checkout.mjs", "test/billing.test.mjs"];
			const files = await readFixture(workspace, paths);
			const combined = paths.map((path) => files[path]).join("\n");
			const testSource = files["test/billing.test.mjs"];
			const verification = run(workspace, "npm", ["test", "--", "--test-reporter=tap"]);
			return {
				verification,
				hiddenVerification: run(workspace, process.execPath, ["--input-type=module", "--eval", "import { checkout } from './src/checkout.mjs'; const actual = checkout({ accountId: 'acct-hidden', totalCents: 73 }); if (JSON.stringify(actual) !== JSON.stringify({ account: 'acct-hidden', receipt: 'acct-hidden:73' })) process.exit(1);"]),
				sourceChecks: {
					removedOldName: !combined.includes("customerId"),
					implementationUsesNewName: files["src/billing.mjs"].includes("accountId"),
					callerUsesNewName: files["src/checkout.mjs"].includes("accountId"),
					testStillAssertsRenamedApi: testSource.includes("assert.deepEqual(checkout({ accountId:") && testSource.includes("receipt: \"acct-7:1200\""),
					testCaseStillRuns: /# tests 1(?:\D|$)/u.test(verification.stdout) && /# pass 1(?:\D|$)/u.test(verification.stdout),
				},
			};
		},
	},
	{
		id: "focused-bug-fix",
		label: "focused single-file bug fix",
		prompt: "Work directly in this repository. The clamp implementation is failing its tests. Diagnose and fix the implementation without weakening or deleting tests, run the repository test script, and then summarize briefly. Do not only describe commands: inspect and modify the repository and verify the result.",
		async setup(workspace) {
			await writeFixture(workspace, {
				"package.json": `${JSON.stringify({ private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
				"src/range.mjs": `export function clamp(value, min, max) {\n\tif (min > max) throw new RangeError("min must not exceed max");\n\treturn Math.min(min, Math.max(max, value));\n}\n`,
				"test/range.test.mjs": `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { clamp } from "../src/range.mjs";\n\ntest("clamp keeps values within the inclusive range", () => {\n\tassert.equal(clamp(-3, 0, 10), 0);\n\tassert.equal(clamp(5, 0, 10), 5);\n\tassert.equal(clamp(12, 0, 10), 10);\n});\n`,
			});
		},
		async verify(workspace) {
			const files = await readFixture(workspace, ["src/range.mjs", "test/range.test.mjs"]);
			const expectedTest = `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { clamp } from "../src/range.mjs";\n\ntest("clamp keeps values within the inclusive range", () => {\n\tassert.equal(clamp(-3, 0, 10), 0);\n\tassert.equal(clamp(5, 0, 10), 5);\n\tassert.equal(clamp(12, 0, 10), 10);\n});\n`;
			return {
				verification: run(workspace, "npm", ["test", "--", "--test-reporter=tap"]),
				hiddenVerification: run(workspace, process.execPath, ["--input-type=module", "--eval", "import { clamp } from './src/range.mjs'; const cases = [[-9, 0], [0, 0], [4, 4], [10, 10], [99, 10]]; if (cases.some(([value, expected]) => clamp(value, 0, 10) !== expected)) process.exit(1); let guard = false; try { clamp(1, 10, 0); } catch (error) { guard = error instanceof RangeError; } if (!guard) process.exit(1);"]),
				sourceChecks: {
					originalBugRemoved: !files["src/range.mjs"].includes("Math.min(min, Math.max(max, value))"),
					testsUnchanged: files["test/range.test.mjs"] === expectedTest,
				},
			};
		},
	},
];

function taskForInput(input: PiCodingAgentInput): TaskDefinition {
	const id = !Array.isArray(input) && typeof input === "object" ? input.id : undefined;
	const task = tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown Bash tool-surface task: ${String(id)}`);
	return task;
}

function countToolCalls(messages: PiCodingAgentOutputContext["session"]["messages"]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			counts[part.name] = (counts[part.name] ?? 0) + 1;
		}
	}
	return counts;
}

async function setupWorkspace({ input, workspace }: PiEvalWorkspaceContext): Promise<void> {
	await taskForInput(input).setup(workspace);
	const initialized = run(workspace, "git", ["init", "--quiet"]);
	if (initialized.status !== 0) throw new Error(`Failed to initialize eval Git repository: ${initialized.stderr}`);
}

function harness(name: string, tools: string[]) {
	return createPiCodingAgentHarness<Output>({
		name,
		model: { provider: provider!, id: model! },
		thinkingLevel: "low",
		tools,
		productAgentDir,
		setupWorkspace,
		async output({ input, workspace, response, session }) {
			const task = taskForInput(input);
			return {
				taskId: task.id,
				response: clipped(response),
				...(await task.verify(workspace)),
				toolCallsByName: countToolCalls(session.messages),
			};
		},
	});
}

function judgeFor(task: TaskDefinition) {
	return createJudge<PiCodingAgentInput, Output>(`BashToolSurface-${task.id}`, ({ output }) => {
		const checks: Record<string, boolean> = {
			taskIdentity: output.taskId === task.id,
			repositoryTestsPass: output.verification.status === 0,
			hiddenVerificationPasses: output.hiddenVerification.status === 0,
			...output.sourceChecks,
		};
		return {
			score: Object.values(checks).every(Boolean) ? 1 : 0,
			metadata: { rationale: JSON.stringify(checks), output: { checks } as JsonValue },
		};
	});
}

if (!enabled || !provider || !model) {
	describe.skip("Bash tool-surface A/B requires ROTOM_EVAL_BASH_TOOL_SURFACE=1, provider, and model", () => {});
} else {
	const hybrid = harness("hybrid-core", ["bash", "read", "edit", "write"]);
	const bashOnly = harness("bash-only", ["bash"]);
	for (const task of tasks) {
		const scenario = { id: task.id, steps: [{ type: "prompt", content: task.prompt }] } satisfies PiCodingAgentScenario;
		const planned = evalHarnessTable(`Bash tool surface: ${task.label}`, { baseline: hybrid, candidate: bashOnly, repetitions });
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
