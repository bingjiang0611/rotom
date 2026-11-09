import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue } from "vitest-evals/harness";
import { compactionContinuationCases } from "../src/compaction-continuation-cases.ts";
import { type ContinuationCase, type ContinuationOutput, continuationCases, scoreContinuationCase } from "../src/continuation-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";

// Oracle for plan P1-1: real product sessions, a real session.compact() and scripted
// faux responses. It proves the case is not vacuous (the first turn is gone from the
// model's context after compaction) and that the judge separates right from wrong
// continuations. It says nothing about how a live model behaves; that is the paid run.
afterEach(() => vi.unstubAllGlobals());

type Step = { call: [string, Record<string, unknown>] } | { text: string };
const SUMMARIZER = "context summarization assistant";

async function run(definition: ContinuationCase, turns: Step[][], summary: string) {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
	const productDir = defaultProductAgentDir();
	const piPackage = join(productDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
	const metadata = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
	const afterCompaction: { firstPromptVisible?: boolean; summaryVisible?: boolean } = {};
	const harness = createPiCodingAgentHarness<ContinuationOutput & JsonValue>({
		name: `compaction-oracle-${definition.id}`,
		model: { provider: "compaction-fixture", id: "fixture" },
		productAgentDir: productDir,
		piExecutable: join(piPackage, metadata.bin.pi),
		tools: definition.tools,
		noContextFiles: true,
		environment: { ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
		async setupWorkspace({ workspace, configDir }) {
			for (const [path, content] of Object.entries(definition.fixture)) await writeFile(join(workspace, path), content);
			await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ evidencePreservingReducer: false }));
			if (definition.settings) await writeFile(join(configDir, "settings.json"), JSON.stringify(definition.settings));
		},
		async continuePrompt({ session, stepIndex }) {
			await definition.afterTurn?.(session.sessionManager.getCwd(), stepIndex);
			if (definition.compactAfterTurns?.includes(stepIndex)) {
				await session.compact();
				const projected = JSON.stringify(session.sessionManager.buildSessionProjection().messages);
				afterCompaction.firstPromptVisible = projected.includes(JSON.stringify(definition.prompts[0]).slice(1, -1));
				afterCompaction.summaryVisible = projected.includes(JSON.stringify(summary).slice(1, -1));
			}
			return undefined;
		},
		async modelRuntimeFactory({ product, configDir }) {
			const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(join(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
			const faux = fauxProvider({ provider: "compaction-fixture", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1024 }] });
			const queue = turns.flat();
			const respond = (context: { messages: unknown[] }) => {
				if (JSON.stringify(context.messages).includes(SUMMARIZER)) return fauxAssistantMessage(summary);
				const step = queue.shift();
				if (!step) throw new Error("scripted responses exhausted");
				return "call" in step ? fauxAssistantMessage(fauxToolCall(step.call[0], step.call[1]), { stopReason: "toolUse" }) : fauxAssistantMessage(step.text);
			};
			faux.setResponses(Array.from({ length: 40 }, () => respond));
			const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		},
		async output({ workspace, response, session }) {
			const calls = session.messages.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "toolCall" ? [{ name: part.name, args: part.arguments as Record<string, unknown> }] : []) : []);
			const files = Object.fromEntries(await Promise.all(definition.observe.map(async (path) => [path, existsSync(join(workspace, path)) ? await readFile(join(workspace, path), "utf8") : ""])));
			const compactions = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
			return { caseId: definition.id, response, calls, files, compactions, toolCallCount: calls.length } as ContinuationOutput & JsonValue;
		},
	});
	const result = await harness.run({ id: definition.id, steps: definition.prompts.map((content) => ({ type: "prompt", content })) }, { artifacts: {}, setArtifact() {} });
	return { judged: scoreContinuationCase(definition.id, result.output), afterCompaction };
}

const directive = compactionContinuationCases.find((item) => item.id === "behavior-standing-directive-after-compaction")!;
const detail = compactionContinuationCases.find((item) => item.id === "behavior-exact-detail-after-compaction")!;
const bash = (command: string): Step => ({ call: ["bash", { command }] });

it("registers the compaction cases with the continuation suite", () => {
	expect(continuationCases.filter((item) => item.compactAfterTurns?.length).map((item) => item.id)).toEqual([directive.id, detail.id]);
});

const directiveFirstTurn = [bash("node pipeline.mjs alpha"), bash("node pipeline.mjs beta"), { text: "alpha、beta 完成；gamma 输入尚未到达。" }];
const directiveSummary = "User asked to process three batches without stopping for confirmation until all are done. alpha and beta are done; gamma input had not arrived.";

it("directive case: compaction removes the first turn and finishing the work passes", async () => {
	const { judged, afterCompaction } = await run(directive, [directiveFirstTurn, [{ call: ["read", { path: "gamma.txt" }] }, bash("node pipeline.mjs gamma"), { text: "三个批次已完成。" }]], directiveSummary);
	expect(afterCompaction).toEqual({ firstPromptVisible: false, summaryVisible: true });
	expect(judged.passed, JSON.stringify(judged.checks)).toBe(true);
}, 60_000);

it("directive case: asking again after compaction fails", async () => {
	const { judged } = await run(directive, [directiveFirstTurn, [{ text: "gamma 已到达，需要我继续处理吗？" }]], directiveSummary);
	expect(judged.passed).toBe(false);
	expect(judged.checks.availableWorkCompleted).toBe(false);
	expect(judged.checks.compactionHappened).toBe(true);
}, 60_000);

it("directive case: the same good trajectory without a compaction is not scored as a pass", async () => {
	const { judged } = await run({ ...directive, compactAfterTurns: [] }, [directiveFirstTurn, [bash("node pipeline.mjs gamma"), { text: "done" }]], directiveSummary);
	expect(judged.checks.compactionHappened).toBe(false);
	expect(judged.passed).toBe(false);
}, 60_000);

const flags = "--sep=semicolon --header=v2";
const detailFirstTurn = [bash(`node export.mjs alpha ${flags}`), { text: "alpha 已按要求导出。" }];
const detailSummary = "alpha was exported; beta input pending.";

it("detail case: applying the earlier parameters passes", async () => {
	const { judged, afterCompaction } = await run(detail, [detailFirstTurn, [bash(`node export.mjs beta ${flags}`), { text: "beta 已导出。" }]], detailSummary);
	expect(afterCompaction).toEqual({ firstPromptVisible: false, summaryVisible: true });
	expect(judged.passed, JSON.stringify(judged.checks)).toBe(true);
}, 60_000);

it("detail case: a forgotten parameter fails even when fixed afterwards", async () => {
	const forgot = await run(detail, [detailFirstTurn, [bash("node export.mjs beta"), { text: "beta 已导出。" }]], detailSummary);
	expect(forgot.judged.checks.bothExportsUseTheRequestedFormat).toBe(false);
	const fixedLater = await run(detail, [detailFirstTurn, [bash("node export.mjs beta"), bash(`node export.mjs beta ${flags}`), { text: "已修正。" }]], detailSummary);
	expect(fixedLater.judged.checks.bothExportsUseTheRequestedFormat).toBe(true);
	expect(fixedLater.judged.checks.noRunWithAForgottenParameter).toBe(false);
	expect(fixedLater.judged.passed).toBe(false);
}, 120_000);
