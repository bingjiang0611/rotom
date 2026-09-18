import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput, type PiCodingAgentOutputContext } from "../src/pi-harness.ts";
import { evalHarnessTable } from "../src/vitest-evals/harness-table.ts";

// Explicitly authorized experiment only. This text is NOT a shipped policy.
const EXPERIMENTAL_POLICY = `Tool output efficiency: scope searches to the target repository and directory, locate files before reading windows, and inspect a large diff by changed file rather than repeatedly dumping the full diff. Preserve complete required evidence: exact-text requests need the entire requested region. Do not replace evidence with a summary, assume an unchanged command means unchanged data, or combine dependent writes and verification. Batch only independent queries.`;
const enabled = process.env.ROTOM_EVAL_CONTEXT_EFFICIENCY === "1";
const provider = process.env.ROTOM_EVAL_PROVIDER?.trim();
const model = process.env.ROTOM_EVAL_MODEL?.trim();
const productAgentDir = process.env.ROTOM_EVAL_CANDIDATE_PRODUCT?.trim() || resolve(import.meta.dirname, "../..");
const exact = [
	"export function renderCounter(value: number): string {",
	"  // Keep the literal punctuation and whitespace.",
	"  const suffix = 'items — total';",
	"  if (value === 0) {",
	"    return `0 ${suffix}`;",
	"  }",
	"  return `${value}: ${suffix}`;",
	"}",
].join("\n");
const selected = [1, 4, 7, 10, 13, 16];
const fixtures: Record<string, string> = {
	"app/manifest.json": JSON.stringify(selected.map((id) => `module-${id}.ts`)),
	"legacy/decoy.ts": "export const AMOUNT = 999999;\n".repeat(3000),
};
for (let id = 0; id < 24; id++) {
	const filler = Array.from({ length: 1200 }, (_, row) => `// module ${id} inert row ${row}: ${"padding ".repeat(9)}`);
	filler.splice(734, 0, `export const AMOUNT = ${(id + 1) * 7};`, ...(id === 7 ? [exact] : []));
	fixtures[`app/module-${id}.ts`] = `${filler.join("\n")}\n`;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const tasks = [
	{ id: "scoped-aggregate", prompt: "Only modules listed in app/manifest.json are active. Sum their exported AMOUNT values and report SUM=<integer>. Ignore inactive modules and legacy/. Do not change files.", accepts: (s: string) => s.includes(`SUM=${selected.reduce((n, id) => n + (id + 1) * 7, 0)}`) },
	{ id: "exact-source", prompt: "Return the complete renderCounter function from app/module-7.ts verbatim, including its comment, whitespace and punctuation. Do not summarize or omit lines. Do not change files.", accepts: (s: string) => s.includes(exact) },
];
type Output = { correct: boolean; filesIntact: boolean; toolCalls: number; resultBytes: number; toolNames: string[] };
function metrics(session: PiCodingAgentOutputContext["session"]) {
	const toolNames: string[] = [];
	let resultBytes = 0;
	for (const message of session.messages) {
		if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") toolNames.push(part.name);
		if (message.role === "toolResult") for (const part of message.content) if (part.type === "text") resultBytes += Buffer.byteLength(part.text);
	}
	return { toolCalls: toolNames.length, resultBytes, toolNames };
}
if (!enabled || !provider || !model) {
	describe.skip("context efficiency requires explicit enablement, provider and model", () => {});
} else for (const task of tasks) {
	const harness = (candidate: boolean) => createPiCodingAgentHarness<Output>({
		name: candidate ? "candidate" : "baseline", model: { provider, id: model }, thinkingLevel: "low",
		productAgentDir, tools: ["read", "bash"],
		inlineExtensions: candidate ? [(pi) => { pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${EXPERIMENTAL_POLICY}` })); }] : [],
		async setupWorkspace({ workspace, configDir }) {
			for (const [name, content] of Object.entries(fixtures)) {
				await mkdir(join(workspace, name.split("/")[0]), { recursive: true });
				await writeFile(join(workspace, name), content);
			}
			await writeFile(join(configDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
			const result = spawnSync("git", ["init", "--quiet"], { cwd: workspace, timeout: 30_000 });
			if (result.status !== 0) throw new Error("fixture git init failed");
		},
		async output({ session, response, workspace }) {
			const intact = await Promise.all(Object.entries(fixtures).map(async ([name, content]) => digest(await readFile(join(workspace, name), "utf8")) === digest(content)));
			return { correct: task.accepts(response), filesIntact: intact.every(Boolean), ...metrics(session) };
		},
	});
	const rows = evalHarnessTable(`Context efficiency: ${task.id}`, { baseline: harness(false), candidate: harness(true), repetitions: 2 });
	const ordered = [rows.filter((r) => r.repetition === 1), rows.filter((r) => r.repetition === 2).reverse()].flat();
	for (const row of ordered) describeEval(`${task.id}: ${row.name} repetition ${row.repetition}`, {
		harness: row.harness,
		judges: [createJudge<PiCodingAgentInput, Output>(task.id, ({ output }) => ({ score: output.correct && output.filesIntact ? 1 : 0, metadata: { output } }))],
		judgeThreshold: 1,
	}, (it) => { it(task.id, async ({ run }) => { await run(task.prompt); }); });
}
