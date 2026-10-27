import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ASK_CONTINUATION_GUIDELINE, ASK_CONTINUATION_RESULT, createAskContinuationController, enforceAskContinuationResult, selectedOptionsRequireContinuation, stripAskContinuationMetadata } from "./ask/continuation.ts";
import { COMPUTER_USE_CONDITION_GUIDELINE, COMPUTER_USE_EFFECT_EVIDENCE_GUIDELINE, COMPUTER_USE_FOCUS_SCOPE_GUIDELINE, COMPUTER_USE_FRESH_STATE_REQUIRED, COMPUTER_USE_OBSERVE_FIRST_GUIDELINE, COMPUTER_USE_REOBSERVE_REQUIRED, COMPUTER_USE_STALE_RECOVERY_GUIDELINE, COMPUTER_USE_STRUCTURED_FIRST_GUIDELINE, COMPUTER_USE_UNTRUSTED_SCREEN_GUIDELINE, computerUseContractRepairHint, isRecoverableComputerUseStateError } from "../../../packages/rotom-computer-use/src/recovery.ts";
import { constrainSubagentParameters, prepareProductSubagentArguments, PRODUCT_SUBAGENT_ALLOWED_ACTIONS, PRODUCT_SUBAGENT_BLOCKED_FIELDS, PRODUCT_SUBAGENT_DESCRIPTION, PRODUCT_SUBAGENT_POLICY_GUIDELINE } from "../../../packages/rotom-subagents/src/extension/ephemeral-surface.ts";
import { PRODUCT_SUBAGENT_ALLOWED_COMMANDS } from "./subagent/policy.ts";

function findPiDist(): string {
	const candidates = [process.env.ROTOM_VERIFIED_PI_EXECUTABLE, process.env.ROTOM_PI];
	for (const directory of (process.env.PATH ?? "").split(":")) candidates.push(join(directory, "pi"));
	for (const candidate of candidates) {
		if (!candidate || !existsSync(candidate)) continue;
		let directory = dirname(realpathSync(candidate));
		for (;;) {
			if (existsSync(join(directory, "core/extensions/loader.js"))) return directory;
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	throw new Error("测试环境无法从 ROTOM_PI 或 PATH 中解析 Pi dist");
}

test("owned components define native contracts without product interception", async () => {
	const { loadExtensions } = await import(pathToFileURL(join(findPiDist(), "core/extensions/loader.js")).href);
	const native = await loadExtensions([
		join(import.meta.dirname, "node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts"),
		join(import.meta.dirname, "node_modules/pi-subagents/index.ts"),
	], process.cwd());
	assert.deepEqual(native.errors, []);
	const act = native.extensions[0].tools.get("act_ui").definition;
	assert.ok(act.promptGuidelines.includes(COMPUTER_USE_FOCUS_SCOPE_GUIDELINE));
	assert.ok(act.promptGuidelines.includes(COMPUTER_USE_EFFECT_EVIDENCE_GUIDELINE));
	for (const action of act.parameters.properties.actions.items.anyOf.filter((action: any) => ["typeText", "keypress"].includes(action.properties.action.const))) {
		assert.match(action.properties.ref.description, /same-batch ref-bound editable focus/u);
	}
	const standalone = native.extensions[1].tools.get("subagent").definition;
	assert.ok(standalone.parameters.properties.mission, "standalone surface remains broad unless explicitly selected");
	assert.notEqual(standalone.description, PRODUCT_SUBAGENT_DESCRIPTION);
});

test("product registration uses native deferred defaults only with the launcher handshake", async () => {
	const { loadExtensions } = await import(pathToFileURL(join(findPiDist(), "core/extensions/loader.js")).href);
	const savedDefault = process.env.ROTOM_DEFERRED_DEFAULT_SURFACE;
	const savedEnabled = process.env.ROTOM_DEFERRED_TOOLS;
	try {
		for (const [handshake, enabled, deferred] of [["1", "1", true], ["0", "1", false], ["1", "0", false]] as const) {
			process.env.ROTOM_DEFERRED_DEFAULT_SURFACE = handshake;
			process.env.ROTOM_DEFERRED_TOOLS = enabled;
			const loaded = await loadExtensions([import.meta.dirname], process.cwd());
			assert.deepEqual(loaded.errors, []);
			for (const name of ["subagent", "subagent_wait"]) assert.equal(loaded.extensions[0].tools.get(name)?.definition.defaultActive === false, deferred, name);
			assert.equal(loaded.extensions[0].tools.get("codemode")?.definition.defaultActive, true);
		}
	} finally {
		if (savedDefault === undefined) delete process.env.ROTOM_DEFERRED_DEFAULT_SURFACE;
		else process.env.ROTOM_DEFERRED_DEFAULT_SURFACE = savedDefault;
		if (savedEnabled === undefined) delete process.env.ROTOM_DEFERRED_TOOLS;
		else process.env.ROTOM_DEFERRED_TOOLS = savedEnabled;
	}
});

test("真实 Pi loader 注册保留的第三方运行时并排除 MCP、Background/Fusion 与 LSP", async () => {
	const piDist = findPiDist();
	const { loadExtensions } = await import(pathToFileURL(join(piDist, "core/extensions/loader.js")).href);
	const loaded = await loadExtensions([import.meta.dirname], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const tools = [...loaded.extensions[0].tools.keys()];
	assert.equal(loaded.extensions[0].tools.get("codemode")?.definition.defaultActive, true);
	for (const name of ["goal_continue", "goal_complete", "goal_wait", "goal_blocked", "ask_user_question", "subagent", "act_ui"]) {
		assert.equal(loaded.extensions[0].tools.get(name)?.definition.exposure, "model-only", `${name} must not run inside codemode`);
	}
	for (const tool of ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser", "subagent", "goal_complete", "goal_blocked", "goal_wait", "goal_continue", "ask_user_question"]) {
		assert.ok(tools.includes(tool), `missing third-party tool ${tool}`);
	}
	for (const tool of ["mcp", "mcpScript", "bg_delegate", "bg_result", "bg_run", "bg_run_pi_attested", "bg_status", "bg_logs", "bg_kill", "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate", "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "lsp_document_symbols", "lsp_workspace_symbols", "lsp_more"]) assert.equal(tools.includes(tool), false, `removed tool ${tool} must not be registered`);
	for (const command of ["computer-use", "goal", ...PRODUCT_SUBAGENT_ALLOWED_COMMANDS]) assert.ok(loaded.extensions[0].commands.has(command), `missing /${command}`);
	for (const command of ["mcp", "bg", "lsp"]) assert.equal(loaded.extensions[0].commands.has(command), false, `removed command /${command} must not be registered`);
	for (const command of ["subagents", "run", "subagents-fleet", "prompt-workflow", "subagents-refine", "subagents-watchdog", "subagents-profiles", "subagents-load-profile", "subagents-refresh-provider-models", "subagents-generate-profiles", "subagents-check-profile", "subagents-inspect-rpc"]) {
		assert.equal(loaded.extensions[0].commands.has(command), false, `blocked command /${command} must not be registered`);
	}
	assert.equal(loaded.extensions[0].shortcuts.has("ctrl+alt+f"), false, "fleet shortcut must not bypass the blocked /subagents-fleet command");
	const stopNotices: string[] = [];
	let stopSelectorOpened = false;
	await loaded.extensions[0].commands.get("subagents-stop")?.handler("", {
		hasUI: true,
		ui: { notify(message: string) { stopNotices.push(message); }, custom() { stopSelectorOpened = true; throw new Error("selector must not open"); } },
	} as any);
	assert.equal(stopSelectorOpened, false);
	assert.match(stopNotices.at(-1) ?? "", /explicit current-session run id/u);
	assert.equal(loaded.extensions[0].tools.get("ask_user_question")?.definition.executionMode, "sequential");
	const launch = loaded.extensions[0].tools.get("launch_browser")?.definition;
	assert.match(launch?.description ?? "", /Fallback only.*Relay.*without existing Chrome login/u);
	assert.match(launch?.promptGuidelines?.join("\n") ?? "", /browser_inspect\/browser_interact first.*pre-dispatch Relay-unavailable.*no existing Chrome cookies\/login.*Never replay writes.*fresh CDP stateId/u);
	const actUi = loaded.extensions[0].tools.get("act_ui")?.definition;
	assert.ok(actUi?.promptGuidelines?.includes(COMPUTER_USE_STALE_RECOVERY_GUIDELINE), "stale UI state 后必须先重新 observe，不能连续复用旧 ref");
	assert.equal(actUi?.promptGuidelines?.some((line: string) => line.startsWith("After clicking an editable region")), false, "replace the ambiguous upstream shortcut, do not stack competing rules");
	const actions = (actUi?.parameters as any).properties.actions.items.anyOf;
	for (const name of ["typeText", "keypress"]) {
		const action = actions.find((candidate: any) => candidate.properties.action.const === name);
		assert.match(action.properties.ref.description, /same-batch ref-bound editable focus/u);
		assert.equal(action.required.includes("ref"), false, "description-only: focused input remains optional");
	}
	assert.ok(actUi?.promptGuidelines?.includes(COMPUTER_USE_FOCUS_SCOPE_GUIDELINE));
	const ask = loaded.extensions[0].tools.get("ask_user_question")?.definition;
	assert.ok(ask?.promptGuidelines?.includes(ASK_CONTINUATION_GUIDELINE), "ask answer 后必须在同一 agent run 继续执行，不能只回复承诺");
	assert.equal((ask?.parameters as any)?.properties?.questions?.items?.properties?.options?.items?.properties?.continueExecution?.type, "boolean", "每个选项必须显式声明是否需要后续工具执行，不能靠答案文本猜测");
	const subagent = loaded.extensions[0].tools.get("subagent")?.definition;
	assert.ok(subagent);
	assert.deepEqual((subagent.parameters as any)?.properties?.action?.enum, [...PRODUCT_SUBAGENT_ALLOWED_ACTIONS]);
	for (const field of PRODUCT_SUBAGENT_BLOCKED_FIELDS) assert.equal((subagent.parameters as any)?.properties?.[field], undefined, `blocked subagent field ${field} must not remain model-visible`);
	assert.ok(subagent.promptGuidelines?.includes(PRODUCT_SUBAGENT_POLICY_GUIDELINE));
	assert.match(subagent.promptSnippet ?? "", /one task with agent\/task and async:true/u);
	for (const field of ["agent", "task", "async", "context", "cwd", "output", "workflowScript"]) assert.ok((subagent.parameters as any).properties[field], `delegation field ${field} must remain model-visible`);
	assert.equal(subagent.description, PRODUCT_SUBAGENT_DESCRIPTION);
	assert.match(PRODUCT_SUBAGENT_POLICY_GUIDELINE, /steer its live child or resume its latest run with a compact handoff/u, "同一 lane 必须复用 worker，而不是重复 fork 全量历史");
	assert.throws(
		() => subagent.execute("blocked-refine", { action: "refine" } as any, undefined, undefined, { cwd: process.cwd() } as any),
		/outside the dev-agent product boundary/u,
	);
	const guide = await subagent.execute("allowed-guide", { action: "guide" } as any, undefined, undefined, {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: { getSessionFile: () => null, getSessionId: () => "policy-test" },
	} as any);
	assert.notEqual(guide.isError, true, "一个允许 action 必须通过真实 package 执行路径");
	const workflowRoot = mkdtempSync(join(tmpdir(), "pi-subagent-ephemeral-policy-"));
	try {
		const workflow = await subagent.execute("ephemeral-workflow", { workflowScript: "return [];", async: false } as any, new AbortController().signal, undefined, {
			cwd: workflowRoot,
			hasUI: false,
			mode: "print",
			sessionManager: { getSessionFile: () => null, getSessionId: () => "ephemeral-policy", getLeafEntry: () => undefined },
			ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_color: string, value: string) => value } },
		} as any);
		assert.notEqual(workflow.isError, true, "actionless workflow 必须通过真实 package 执行路径");
		assert.equal(existsSync(join(workflowRoot, ".pi/subagents/missions")), false, "actionless workflow 不得创建自动 mission");
	} finally {
		rmSync(workflowRoot, { recursive: true, force: true });
	}
});

function findPiDependency(piDist: string, relativePath: string): string {
	let directory = piDist;
	for (;;) {
		const candidate = join(directory, "node_modules", relativePath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`无法从 Pi dist 解析依赖：${relativePath}`);
		directory = parent;
	}
}

test("SoL-Pi defaults, trusted config and ROTOM_COMPACTION_OFFLOAD override", async (t) => {
	const originalOverride = process.env.ROTOM_COMPACTION_OFFLOAD;
	t.after(() => {
		if (originalOverride === undefined) delete process.env.ROTOM_COMPACTION_OFFLOAD;
		else process.env.ROTOM_COMPACTION_OFFLOAD = originalOverride;
	});
	delete process.env.ROTOM_COMPACTION_OFFLOAD;
	const workspace = mkdtempSync(join(tmpdir(), "rotom-sol-pi-config-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": join(piDist, "index.js") } });
	const { loadRotomSolPiConfig } = await jiti.import(join(import.meta.dirname, "sol-pi.ts")) as any;
	const agentDir = join(workspace, "agent");
	const cwd = join(workspace, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	const ctx = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted });
	const features = (config: any) => [config.actionFusion, config.observationPack, config.evidencePreservingReducer, config.onlineContextCompact, config.compactionOffload];

	assert.deepEqual(features(loadRotomSolPiConfig(ctx(true), agentDir)), [true, true, true, false, true], "rotom offload defaults on");
	writeFileSync(join(cwd, ".pi", "sol-pi.json"), JSON.stringify({ version: 1, observationPack: true }));
	assert.deepEqual(features(loadRotomSolPiConfig(ctx(false), agentDir)), [true, true, true, false, true], "untrusted project config must be ignored");
	assert.deepEqual(features(loadRotomSolPiConfig(ctx(true), agentDir)), [false, true, false, false, false]);
	writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify({ version: 1 }));
	assert.deepEqual(features(loadRotomSolPiConfig(ctx(false), agentDir)), [false, false, false, false, false]);

	const enabled = { version: 1, observationPack: true, compactionOffload: true };
	const warnings: string[] = [];
	t.mock.method(console, "error", (message: string) => warnings.push(message));
	const cases = [
		{ name: "unset preserves user true", env: undefined, config: enabled, expected: true, warning: false },
		{ name: "empty preserves user true", env: "", config: enabled, expected: true, warning: false },
		{ name: "1 preserves rotom default", env: "1", config: undefined, expected: true, warning: false },
		{ name: "unset preserves omitted user field as false", env: undefined, config: { version: 1, observationPack: true }, expected: false, warning: false },
		{ name: "1 overrides user false with Observation Pack", env: "1", config: { version: 1, observationPack: true, compactionOffload: false }, expected: true, warning: false },
		{ name: "0 disables rotom default", env: "0", config: undefined, expected: false, warning: false },
		{ name: "1 with Observation Pack disabled stays off", env: "1", config: { version: 1, observationPack: false }, expected: false, warning: true },
		{ name: "0 overrides user true", env: "0", config: enabled, expected: false, warning: false },
		{ name: "invalid value preserves user true", env: "true", config: enabled, expected: true, warning: true },
		{ name: "invalid value preserves rotom default true", env: "2", config: undefined, expected: true, warning: true },
	];
	for (const scenario of cases) await t.test(scenario.name, () => {
		if (scenario.env === undefined) delete process.env.ROTOM_COMPACTION_OFFLOAD;
		else process.env.ROTOM_COMPACTION_OFFLOAD = scenario.env;
		if (scenario.config) writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify(scenario.config));
		else rmSync(join(agentDir, "sol-pi.json"), { force: true });
		warnings.length = 0;
		assert.equal(loadRotomSolPiConfig(ctx(false), agentDir).compactionOffload, scenario.expected);
		assert.equal(warnings.length, scenario.warning ? 1 : 0);
		if (scenario.env === "1" && scenario.warning) assert.match(warnings[0]!, /requires Observation Pack; compaction offload remains disabled$/u);
	});
});

test("Subagent 产品策略拒绝持久管理能力并强制普通执行保持 ephemeral", () => {
	const schema = constrainSubagentParameters({ properties: { action: { type: "string" }, mission: { type: "object" }, workflowScript: { type: "string" } } });
	assert.deepEqual((schema as any).properties.action.enum, [...PRODUCT_SUBAGENT_ALLOWED_ACTIONS]);
	assert.equal((schema as any).properties.mission, undefined);
	assert.equal((schema as any).properties.workflowScript.type, "string");
	assert.deepEqual(prepareProductSubagentArguments({ workflowScript: "return 1" }), { workflowScript: "return 1", mission: false });
	assert.deepEqual(prepareProductSubagentArguments({ action: "status", id: "run-1" }), { action: "status", id: "run-1" });
	assert.throws(() => prepareProductSubagentArguments({ action: "refine" }), /outside the dev-agent product boundary/u);
	assert.throws(() => prepareProductSubagentArguments({ workflowScript: "return 1", missionId: "mission-1" }), /field 'missionId'/u);
	assert.deepEqual(
		prepareProductSubagentArguments({ workflowScript: "return 1", cwd: "/tmp/x", mission: false }),
		{ workflowScript: "return 1", cwd: "/tmp/x", mission: false },
		"产品强制的 mission:false 必须幂等接受，而不是让整次调用失败",
	);
	assert.deepEqual(prepareProductSubagentArguments({ action: "status", id: "run-1", mission: false }), { action: "status", id: "run-1" }, "action 调用不得把 mission 透传给锁定 package");
	assert.throws(() => prepareProductSubagentArguments({ workflowScript: "return 1", mission: true }), /omit it or pass mission:false/u);
	assert.throws(() => prepareProductSubagentArguments({ workflowScript: "return 1", mission: { title: "m" } }), /omit it or pass mission:false/u);
	assert.match(PRODUCT_SUBAGENT_DESCRIPTION, /Work is ephemeral/u, "工具只描述保留能力；raw mission:false 的幂等兼容由上面的执行测试证明");
});

test("ask_user_question 非取消答案追加确定性继续执行要求", () => {
	const answered = enforceAskContinuationResult({ content: [{ type: "text", text: "answered" }], details: { answers: [{ questionIndex: 0 }], cancelled: false } });
	assert.match(answered.content[0].text, new RegExp(ASK_CONTINUATION_RESULT.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
	const cancelled = { content: [{ type: "text", text: "cancelled" }], details: { answers: [], cancelled: true } };
	assert.equal(enforceAskContinuationResult(cancelled), cancelled, "取消问答不能强制继续原路径");
});

test("ask answer 仅按所选 option 的 continueExecution 触发一次自动继续", () => {
	const params = { questions: [{ question: "怎么继续？", header: "方式", options: [
		{ label: "继续网页逐表查看", description: "继续工具工作", continueExecution: true },
		{ label: "停止", description: "不再继续", continueExecution: false },
		{ label: "偏好运行测试", description: "仅记录偏好" },
	] }] };
	const multiAnswer = { content: [{ type: "text", text: "answered" }], details: { answers: [{ questionIndex: 0, kind: "multi", answer: null, selected: ["继续网页逐表查看"] }], cancelled: false } };
	const stopAnswer = { content: [{ type: "text", text: "answered" }], details: { answers: [{ questionIndex: 0, kind: "option", answer: "停止" }], cancelled: false } };
	const cancelled = { content: [{ type: "text", text: "cancelled" }], details: { answers: [], cancelled: true } };
	assert.equal(selectedOptionsRequireContinuation(multiAnswer, params), true, "multi-select 必须读取 selected labels");
	assert.equal(selectedOptionsRequireContinuation(stopAnswer, params), false, "拒绝/停止 option 不得因问题中的动作词误触发");
	assert.deepEqual(stripAskContinuationMetadata(params), { questions: [{ question: "怎么继续？", header: "方式", options: [
		{ label: "继续网页逐表查看", description: "继续工具工作" },
		{ label: "停止", description: "不再继续" },
		{ label: "偏好运行测试", description: "仅记录偏好" },
	] }] }, "组合层 metadata 不得泄漏给锁定 package validator");
	const controller = createAskContinuationController();
	const stopped = [{ role: "assistant", stopReason: "stop" }];
	controller.afterAskResult(multiAnswer, selectedOptionsRequireContinuation(multiAnswer, params), controller.beginAsk());
	assert.equal(controller.onAgentEnd(stopped), true);
	assert.equal(controller.onAgentEnd(stopped), false, "同一 ask answer 最多自动续跑一次，禁止循环");
	controller.afterAskResult(multiAnswer, true, controller.beginAsk());
	controller.onToolCall("browser_inspect");
	assert.equal(controller.onAgentEnd(stopped), false, "模型已经调用下一工具时不得额外续跑");
	assert.equal(controller.afterAskResult(stopAnswer, false, controller.beginAsk()), stopAnswer, "停止或偏好答案不得向模型追加继续执行指令");
	assert.equal(controller.onAgentEnd(stopped), false);
	controller.afterAskResult(cancelled, true, controller.beginAsk());
	assert.equal(controller.onAgentEnd(stopped), false, "取消问答不得续跑");
});

test("Ask 续跑不得把 Goal 上限、取消、错误或未知结束变成新运行", () => {
	const controller = createAskContinuationController();
	const answer = { content: [{ type: "text", text: "answered" }], details: { answers: [{ questionIndex: 0 }], cancelled: false } };
	const stopped = { role: "assistant", stopReason: "stop" };
	for (const stopReason of ["error", "aborted", "toolUse", "length", "pending", undefined]) {
		controller.afterAskResult(answer, true, controller.beginAsk());
		assert.equal(controller.onAgentEnd([stopped, { role: "toolResult" }, { role: "assistant", stopReason }]), false, String(stopReason));
		assert.equal(controller.onAgentEnd([stopped]), false, "被中止的续跑意图必须消费，不能在之后恢复时复活");
	}
	for (const messages of [[], [{ role: "toolResult" }]]) {
		controller.afterAskResult(answer, true, controller.beginAsk());
		assert.equal(controller.onAgentEnd(messages), false, "缺少正常结束证据不补发");
	}
	controller.afterAskResult(answer, true, controller.beginAsk());
	assert.equal(controller.onAgentEnd([stopped], AbortSignal.abort()), false, "即便 stop 已生成，取消仍优先");
});

test("Ask 取消及 session 生命周期失效后，迟到答案不能重新武装续跑", () => {
	const controller = createAskContinuationController();
	const answer = { content: [{ type: "text", text: "answered" }], details: { answers: [{ questionIndex: 0 }], cancelled: false } };
	const stopped = [{ role: "assistant", stopReason: "stop" }];
	const cancelledGeneration = controller.beginAsk();
	assert.equal(controller.afterAskResult(answer, true, cancelledGeneration, AbortSignal.abort()), answer);
	assert.equal(controller.onAgentEnd(stopped), false);
	const oldGeneration = controller.beginAsk();
	controller.reset();
	assert.equal(controller.afterAskResult(answer, true, oldGeneration), answer);
	assert.equal(controller.onAgentEnd(stopped), false);
	const staleGeneration = controller.beginAsk();
	const freshGeneration = controller.beginAsk();
	controller.afterAskResult(answer, true, freshGeneration);
	controller.afterAskResult(answer, false, staleGeneration);
	assert.equal(controller.onAgentEnd(stopped), true, "迟到结果也不能覆盖新问答的意图");
	controller.afterAskResult(answer, true, controller.beginAsk());
	controller.reset();
	assert.equal(controller.onAgentEnd(stopped), false);
});

test("真实第三方 loader 的 Ask 只补发正常结束；Goal 中止事件不补发", async () => {
	const { loadExtensions } = await import(pathToFileURL(join(findPiDist(), "core/extensions/loader.js")).href);
	const loaded = await loadExtensions([import.meta.dirname], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const sent: unknown[] = [];
	loaded.runtime.sendMessage = (message: unknown, options: unknown) => sent.push({ message, options });
	const ask = extension.tools.get("ask_user_question").definition;
	const end = extension.handlers.get("agent_end").at(-1);
	const ctx = { mode: "rpc", hasUI: true, ui: { select: async (_title: string, options: string[]) => options[0], input: async () => "" } };
	const params = { questions: [{ header: "执行", question: "继续执行？", options: [
		{ label: "继续", description: "执行下一工具", continueExecution: true },
		{ label: "停止", description: "结束任务" },
	] }] };
	const arm = () => ask.execute("ask-regression", params, undefined, undefined, ctx);
	const stopCtx = { ...ctx, ui: { ...ctx.ui, select: async (_title: string, options: string[]) => options[1] } };
	const stopResult = await ask.execute("stop-choice", params, undefined, undefined, stopCtx);
	assert.doesNotMatch(JSON.stringify(stopResult.content), /Continuation requirement/u);
	await end({ messages: [{ role: "assistant", stopReason: "stop" }] }, stopCtx);
	assert.equal(sent.length, 0);
	for (const stopReason of ["error", "aborted", "toolUse"]) {
		const answer = await arm();
		assert.equal(answer.details.cancelled, false);
		// Same boundary as the reported 25/25 pause: answered Ask, synthetic
		// terminal error, agent_end. No private Goal state or error-text matching.
		await end({ type: "agent_end", messages: [{ role: "assistant", stopReason }] }, ctx);
		assert.equal(sent.length, 0);
	}
	await arm();
	await end({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, { ...ctx, signal: AbortSignal.abort() });
	assert.equal(sent.length, 0, "组合层必须传递取消信号");
	for (const lifecycle of ["session_start", "session_shutdown", "session_tree"]) {
		await arm();
		await extension.handlers.get(lifecycle).at(-1)({}, ctx);
		await end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		assert.equal(sent.length, 0, lifecycle);
		let release: (() => void) | undefined;
		const pendingCtx = { ...ctx, ui: { ...ctx.ui, select: (_title: string, options: string[]) => new Promise<string>((resolve) => { release = () => resolve(options[0]); }) } };
		const pending = ask.execute(`late-${lifecycle}`, params, undefined, undefined, pendingCtx);
		await Promise.resolve();
		assert.ok(release, "dialog must be open before invalidating its generation");
		await extension.handlers.get(lifecycle).at(-1)({}, ctx);
		release();
		const late = await pending;
		assert.doesNotMatch(JSON.stringify(late.content), /Continuation requirement/u);
		await end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		assert.equal(sent.length, 0, `late result after ${lifecycle}`);
	}
	await arm();
	await end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	await end({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
	assert.equal(sent.length, 1);
	assert.deepEqual((sent[0] as any).options, { deliverAs: "followUp", triggerTurn: true });
	assert.equal((sent[0] as any).message.customType, "ask-user-continuation");
});

test("unsupported Ask schema keeps native Ask and all later components in a real session", async (t) => {
	const workspace = mkdtempSync(join(tmpdir(), "rotom-ask-schema-drift-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const fixture = join(workspace, "ask.ts");
	writeFileSync(fixture, `export default function(pi) { pi.registerTool({
		name: "ask_user_question", label: "Ask", description: "upstream fixture",
		parameters: { type: "object", properties: { changed: { type: "string" } } },
		execute: async () => ({ content: [{ type: "text", text: "native result" }], details: { native: true } })
	}); }`);
	const piDist = findPiDist();
	const pi = await import(pathToFileURL(join(piDist, "index.js")).href);
	// Only replace the upstream Ask module. Load the real composition and all
	// other components through the host's normal SDK loader/resolution path.
	const runtime = join(workspace, "runtime");
	mkdirSync(runtime);
	for (const name of readdirSync(import.meta.dirname)) {
		if (name !== "index.ts" && name !== "node_modules") symlinkSync(join(import.meta.dirname, name), join(runtime, name));
	}
	writeFileSync(join(runtime, "index.ts"), readFileSync(join(import.meta.dirname, "index.ts")));
	mkdirSync(join(runtime, "node_modules/@juicesharp/rpiv-ask-user-question"), { recursive: true });
	symlinkSync(fixture, join(runtime, "node_modules/@juicesharp/rpiv-ask-user-question/index.ts"));
	for (const name of readdirSync(join(import.meta.dirname, "node_modules"))) {
		if (name !== "@juicesharp") symlinkSync(join(import.meta.dirname, "node_modules", name), join(runtime, "node_modules", name));
	}
	const settingsManager = pi.SettingsManager.inMemory();
	const loader = new pi.DefaultResourceLoader({ cwd: workspace, agentDir: workspace, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [runtime],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await pi.ModelRuntime.create({ authPath: join(workspace, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const warnings = t.mock.method(process, "emitWarning", () => {});
	const { session, extensionsResult } = await pi.createAgentSession({ cwd: workspace, agentDir: workspace,
		resourceLoader: loader, modelRuntime, settingsManager, sessionManager: pi.SessionManager.inMemory(workspace),
	});
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: (error: unknown) => errors.push(error) });
	assert.deepEqual(errors, []);
	const extension = extensionsResult.extensions.find((extension: any) => extension.tools.has("ask_user_question"));
	const ask = extension.tools.get("ask_user_question").definition;
	assert.deepEqual(ask.parameters, { type: "object", properties: { changed: { type: "string" } } });
	assert.equal(ask.promptGuidelines?.includes(ASK_CONTINUATION_GUIDELINE) ?? false, false);
	assert.deepEqual(await ask.execute(), { content: [{ type: "text", text: "native result" }], details: { native: true } });
	for (const name of ["act_ui", "subagent", "goal_continue", "ask_user_question", "edit", "write", "obs_recall", "search_tools"]) {
		assert.ok(extension.tools.has(name), `${name} must still register after schema drift`);
	}
	assert.ok(extension.commands.has("context"));
	const schemaWarnings = warnings.mock.calls.filter(call => (call.arguments[1] as any)?.code === "ROTOM_ASK_SCHEMA");
	assert.equal(schemaWarnings.length, 1);
	assert.match(String(schemaWarnings[0].arguments[0]), /Continuation disabled; using the original Ask tool/u);
});
