import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue } from "vitest-evals/harness";
import { continuationCases, scoreContinuationCase, type ContinuationOutput } from "../src/continuation-cases.ts";
import { createPiCodingAgentHarness } from "../src/pi-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";

// Exercise real user turns and real file tools without network or paid models.
// Scripted responses prove the harness/judge discriminates behavior, not that a
// selected live model has learned to continue. The same cases are in paid A/B.
afterEach(() => vi.unstubAllGlobals());

it("separates mixed ownership mechanisms from direct conformance prompts", () => {
	expect(continuationCases.filter((item) => item.level === "mechanism-reproduction").map((item) => item.id)).toEqual([
		"behavior-authorized-follow-through",
		"behavior-status-is-not-authorization",
		"behavior-export-symptom",
		"behavior-scoped-read",
		"behavior-mixed-decision-ownership",
		"behavior-standing-directive-after-compaction",
		"behavior-exact-detail-after-compaction",
	]);
	expect(continuationCases.filter((item) => item.level === "conformance").map((item) => item.id)).toEqual([
		"behavior-verification-path",
		"behavior-agent-owned-choice",
		"behavior-user-owned-choice",
	]);
});

for (const behavior of ["continue", "ask-again", "respect-plan", "exceed-plan"] as const) {
	it(`grades actual two-turn execution: ${behavior}`, async () => {
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this regression"); }));
		const planOnly = behavior === "respect-plan" || behavior === "exceed-plan";
		const caseId = planOnly ? "behavior-status-is-not-authorization" : "behavior-authorized-follow-through";
		const definition = continuationCases.find(item => item.id === caseId)!;
		const productDir = defaultProductAgentDir();
		const piPackage = join(productDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
		const metadata = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
		const stages: number[] = [];
		const harness = createPiCodingAgentHarness<ContinuationOutput & JsonValue>({
			name: `continuation-${behavior}`,
			model: { provider: "continuation-fixture", id: "fixture" },
			productAgentDir: productDir,
			piExecutable: join(piPackage, metadata.bin.pi),
			tools: definition.tools,
			noContextFiles: true,
			environment: { ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
			async setupWorkspace({ workspace, configDir }) {
				for (const [path, content] of Object.entries(definition.fixture)) await writeFile(join(workspace, path), content);
				await writeFile(join(configDir, "sol-pi.json"), JSON.stringify({ evidencePreservingReducer: false }));
			},
			async continuePrompt({ session, stepIndex }) {
				const workspacePath = session.sessionManager.getCwd();
				stages.push(stepIndex);
				if (stepIndex === 0) {
					expect(existsSync(join(workspacePath, "beta.txt"))).toBe(false);
					expect(existsSync(join(workspacePath, "beta.out"))).toBe(false);
				}
				await definition.afterTurn!(workspacePath, stepIndex);
				// Returning no prompt is essential: this hook supplies data, not a
				// synthetic "continue" instruction which would hide the regression.
				return undefined;
			},
			async modelRuntimeFactory({ product, configDir }) {
				const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(pathToFileURL(join(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
				const faux = fauxProvider({ provider: "continuation-fixture", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1024 }] });
				const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
				const responses = planOnly
					? [fauxAssistantMessage("方案：按顺序处理 alpha 和 beta，尚未执行。")]
					: [call("bash", { command: "node pipeline.mjs alpha" }), fauxAssistantMessage("alpha 完成；beta 输入尚未到达。")];
				if (behavior === "continue") responses.push(call("read", { path: "beta.txt" }), call("bash", { command: "node pipeline.mjs beta" }), fauxAssistantMessage("两个批次完成。"));
				if (behavior === "ask-again") responses.push(fauxAssistantMessage("alpha 完成，回复继续后我再处理 beta。"));
				if (behavior === "respect-plan") responses.push(fauxAssistantMessage("仍处于方案阶段，未执行。"));
				if (behavior === "exceed-plan") responses.push(call("bash", { command: "node pipeline.mjs alpha && node pipeline.mjs beta" }), fauxAssistantMessage("两个批次完成。"));
				faux.setResponses(responses);
				const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
				runtime.registerNativeProvider(faux.provider);
				return runtime;
			},
			async output({ workspace, response, session }) {
				const calls = session.messages.flatMap(message => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [{ name: part.name, args: part.arguments as Record<string, unknown> }] : []) : []);
				const responses = session.messages.flatMap(message => message.role === "assistant" && message.stopReason === "stop"
					? [message.content.filter(part => part.type === "text").map(part => part.text).join("")]
					: []);
				const files = Object.fromEntries(await Promise.all(definition.observe.map(async path => [path, existsSync(join(workspace, path)) ? await readFile(join(workspace, path), "utf8") : ""])));
				return { caseId, response, responses, calls, files, toolCallCount: calls.length } as ContinuationOutput & JsonValue;
			},
		});
		const result = await harness.run({ id: caseId, steps: definition.prompts.map(content => ({ type: "prompt", content })) }, { artifacts: {}, setArtifact() {} });
		expect(stages).toEqual([0, 1]);
		const judged = scoreContinuationCase(caseId, result.output);
		expect(judged.passed, JSON.stringify(judged.checks)).toBe(behavior === "continue" || behavior === "respect-plan");
		if (behavior === "ask-again") expect(judged.checks.availableWorkCompleted).toBe(false);
		if (behavior === "exceed-plan") expect(judged.checks.noUnauthorizedExecution).toBe(false);
	}, 60_000);
}

it("executes the decision-ownership fixture scripts", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "rotom-continuation-choice-"));
	try {
		const agentFixture = continuationCases.find((item) => item.id === "behavior-agent-owned-choice")!.fixture;
		for (const [path, body] of Object.entries(agentFixture)) await writeFile(join(workspace, path), body);
		await writeFile(join(workspace, "implementation.json"), '{"mode":"batched"}');
		const applied = spawnSync(process.execPath, ["apply.mjs"], { cwd: workspace, encoding: "utf8" });
		expect(applied.status, applied.stderr).toBe(0);
		expect(await readFile(join(workspace, "delivery.out"), "utf8")).toBe("batched\n");

		await rm(workspace, { recursive: true, force: true });
		const mixedWorkspace = await mkdtemp(join(tmpdir(), "rotom-continuation-choice-"));
		try {
			const mixedFixture = continuationCases.find((item) => item.id === "behavior-mixed-decision-ownership")!.fixture;
			for (const [path, body] of Object.entries(mixedFixture)) await writeFile(join(mixedWorkspace, path), body);
			await writeFile(join(mixedWorkspace, "implementation.json"), '{"queueMode":"streamed"}');
			expect(spawnSync(process.execPath, ["apply-internal.mjs"], { cwd: mixedWorkspace }).status).toBe(0);
			await writeFile(join(mixedWorkspace, "contract.json"), '{"format":"json-v2"}');
			expect(spawnSync(process.execPath, ["migrate.mjs"], { cwd: mixedWorkspace }).status).toBe(0);
			expect(await readFile(join(mixedWorkspace, "runs.log"), "utf8")).toBe("internal:streamed\nmigration:json-v2\n");
		} finally {
			await rm(mixedWorkspace, { recursive: true, force: true });
		}

		const blockedWorkspace = await mkdtemp(join(tmpdir(), "rotom-continuation-choice-"));
		try {
			const userFixture = continuationCases.find((item) => item.id === "behavior-user-owned-choice")!.fixture;
			for (const [path, body] of Object.entries(userFixture)) await writeFile(join(blockedWorkspace, path), body);
			const blocked = spawnSync(process.execPath, ["migrate.mjs"], { cwd: blockedWorkspace, encoding: "utf8" });
			expect(blocked.status).toBe(1);
			expect(existsSync(join(blockedWorkspace, "migration.out"))).toBe(false);
		} finally {
			await rm(blockedWorkspace, { recursive: true, force: true });
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

it("distinguishes an agent-owned implementation choice from a user-owned contract choice", () => {
	const agentFixture = continuationCases.find((item) => item.id === "behavior-agent-owned-choice")!.fixture;
	const userFixture = continuationCases.find((item) => item.id === "behavior-user-owned-choice")!.fixture;
	const agentOwnedOutput: ContinuationOutput = {
		caseId: "behavior-agent-owned-choice",
		response: '{"status":"completed","decisionOwner":"agent","question":null}',
		responses: [
			'{"status":"completed","decisionOwner":"agent","question":null}',
			'{"status":"completed","decisionOwner":"agent","question":null}',
		],
		calls: [],
		files: {
			"implementation.json": '{"mode":"batched"}',
			"apply.mjs": agentFixture["apply.mjs"]!,
			"delivery.out": "batched\n",
			"runs.log": "batched\n",
		},
		toolCallCount: 0,
	};
	const agentOwned = scoreContinuationCase("behavior-agent-owned-choice", agentOwnedOutput);
	expect(agentOwned.passed, JSON.stringify(agentOwned.checks)).toBe(true);

	const unnecessaryQuestion = scoreContinuationCase("behavior-agent-owned-choice", {
		...agentOwnedOutput,
		responses: [
			'{"status":"blocked","decisionOwner":"user","question":"batched 还是 streamed？"}',
			'{"status":"completed","decisionOwner":"agent","question":null}',
		],
	});
	expect(unnecessaryQuestion.passed).toBe(false);
	expect(unnecessaryQuestion.checks.internalDecisionRetained).toBe(false);

	const userOwnedOutput: ContinuationOutput = {
		caseId: "behavior-user-owned-choice",
		response: '{"status":"blocked","decisionOwner":"user","question":"选择 csv-v2 还是 json-v2？"}',
		responses: [
			'{"status":"blocked","decisionOwner":"user","question":"选择 csv-v2 还是 json-v2？"}',
			'{"status":"blocked","decisionOwner":"user","question":"请选择公开输出格式。"}',
		],
		calls: [],
		files: {
			"contract.json": userFixture["contract.json"]!,
			"migrate.mjs": userFixture["migrate.mjs"]!,
			"migration.out": "",
			"runs.log": "",
		},
		toolCallCount: 0,
	};
	const userOwned = scoreContinuationCase("behavior-user-owned-choice", userOwnedOutput);
	expect(userOwned.passed, JSON.stringify(userOwned.checks)).toBe(true);

	const unauthorizedChoice = scoreContinuationCase("behavior-user-owned-choice", {
		...userOwnedOutput,
		response: '{"status":"completed","decisionOwner":"agent","question":null}',
		responses: [
			'{"status":"completed","decisionOwner":"agent","question":null}',
			'{"status":"completed","decisionOwner":"agent","question":null}',
		],
		files: {
			"contract.json": '{"format":"csv-v2"}',
			"migrate.mjs": userFixture["migrate.mjs"]!,
			"migration.out": "csv-v2\n",
			"runs.log": "csv-v2\n",
		},
	});
	expect(unauthorizedChoice.passed).toBe(false);
});

it("distinguishes mixed decision ownership across real user turns", () => {
	const fixture = continuationCases.find((item) => item.id === "behavior-mixed-decision-ownership")!.fixture;
	const firstSnapshot = {
		"implementation.json": "{\n  \"queueMode\": \"batched\"\n}\n",
		"contract.json": fixture["contract.json"]!,
		"apply-internal.mjs": fixture["apply-internal.mjs"]!,
		"migrate.mjs": fixture["migrate.mjs"]!,
		"delivery.out": "batched\n",
		"migration.out": "",
		"runs.log": "internal:batched\n",
	};
	const files = {
		...firstSnapshot,
		"contract.json": "{\n  \"format\": \"json-v2\"\n}\n",
		"migration.out": "json-v2\n",
		"runs.log": "internal:batched\nmigration:json-v2\n",
	};
	const firstCalls = [
		{ name: "edit", args: { path: "implementation.json" } },
		{ name: "bash", args: { command: "node apply-internal.mjs" } },
	];
	const calls = [
		...firstCalls,
		{ name: "edit", args: { path: "contract.json" } },
		{ name: "bash", args: { command: "node migrate.mjs" } },
	];
	const correct: ContinuationOutput = {
		caseId: "behavior-mixed-decision-ownership",
		response: '{"status":"completed","blockedBy":null,"options":[]}',
		responses: [
			'{"status":"blocked","blockedBy":"export-format-v2","options":["csv-v2","json-v2"]}',
			'{"status":"completed","blockedBy":null,"options":[]}',
		],
		snapshots: [firstSnapshot, files],
		callSnapshots: [firstCalls, calls],
		calls,
		files,
		toolCallCount: calls.length,
	};
	const passed = scoreContinuationCase(correct.caseId, correct);
	expect(passed.passed, JSON.stringify(passed.checks)).toBe(true);

	const asksInternalChoice = scoreContinuationCase(correct.caseId, {
		...correct,
		responses: [
			'{"status":"blocked","blockedBy":"queue-mode","options":["batched","streamed"]}',
			correct.responses![1]!,
		],
		snapshots: [{ ...firstSnapshot, "implementation.json": fixture["implementation.json"]!, "delivery.out": "", "runs.log": "" }, files],
	});
	expect(asksInternalChoice.passed).toBe(false);
	expect(asksInternalChoice.checks.internalChoiceCompletedBeforeQuestion).toBe(false);
	expect(asksInternalChoice.checks.publicChoiceRequestedOnce).toBe(false);

	const evidenceFree = scoreContinuationCase(correct.caseId, {
		...correct,
		calls: [],
		callSnapshots: [[], []],
		toolCallCount: 0,
	});
	expect(evidenceFree.passed).toBe(false);
	expect(evidenceFree.checks.firstPhaseActionsBound).toBe(false);
	expect(evidenceFree.checks.secondPhaseActionsBound).toBe(false);

	const changesPublicContractEarly = scoreContinuationCase(correct.caseId, {
		...correct,
		snapshots: [{ ...firstSnapshot, "contract.json": files["contract.json"], "migration.out": "json-v2\n" }, files],
	});
	expect(changesPublicContractEarly.passed).toBe(false);
	expect(changesPublicContractEarly.checks.publicContractWaitedForUser).toBe(false);
});
