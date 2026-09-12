import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFERRED_CAPABILITY_GROUPS,
	DEFERRED_DEFAULT_SURFACE_ENV,
	DEFERRED_INITIAL_TOOL_NAMES,
	DEFERRED_TOOLS_ENV,
	DEFERRED_TOOL_ROUTING_GUIDELINES,
	DEFERRED_TOOL_SEARCH_NAME,
	DEFERRED_TOOL_STATE_ENTRY,
	LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV,
	RESIDENT_BROWSER_TOOL_NAMES,
	deferredToolsEnabled,
	matchDeferredCapabilityGroups,
	registerDeferredTools as registerDeferredToolsBase,
} from "./register.ts";

const DEFAULT_DEFERRED_ENV = { [DEFERRED_DEFAULT_SURFACE_ENV]: "1" };
const registerDeferredTools = (api: any, environment: NodeJS.ProcessEnv = {}) => registerDeferredToolsBase(api, { ...DEFAULT_DEFERRED_ENV, ...environment });

// Goal 0.54.4 registers stable schemas even when no Goal is active. Keep the
// fixture faithful to the real loader rather than silently omitting these tools.
const GOAL_TOOL_NAMES = ["goal_complete", "goal_blocked", "goal_wait"];
const RESIDENT_PRODUCT_TOOLS = [...DEFERRED_INITIAL_TOOL_NAMES, ...GOAL_TOOL_NAMES];
const ALL_PRODUCT_TOOLS = [
	...RESIDENT_PRODUCT_TOOLS,
	...DEFERRED_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames]),
];

function fakeRuntime(branch: any[] = []) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const entries = [...branch];
	let active = [...new Set(ALL_PRODUCT_TOOLS)];
	for (const name of ALL_PRODUCT_TOOLS) tools.set(name, { name, description: name, parameters: { type: "object" } });
	const api = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
			active = [...new Set([...active, definition.name])];
		},
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		getAllTools() { return [...tools.values()]; },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	};
	const context = { sessionManager: { getBranch: () => entries, getEntries: () => { throw new Error("must derive from selected branch, not file order"); } } };
	return {
		api: api as any,
		tools,
		entries,
		active: () => [...active],
		setActive(names: string[]) { active = [...names]; },
		async tree(branch: any[]) {
			entries.splice(0, entries.length, ...branch);
			for (const handler of handlers.get("session_tree") ?? []) await handler({ type: "session_tree" }, context);
		},
		async start(reason = "startup") {
			for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason }, context);
		},
	};
}

test("deferred tools 默认开启，稳定 opt-out 优先并兼容旧环境变量", () => {
	assert.equal(deferredToolsEnabled({}), true);
	assert.equal(deferredToolsEnabled({ [DEFERRED_TOOLS_ENV]: "1" }), true);
	assert.equal(deferredToolsEnabled({ [DEFERRED_TOOLS_ENV]: "true" }), true);
	for (const value of ["0", "false", "NO"]) assert.equal(deferredToolsEnabled({ [DEFERRED_TOOLS_ENV]: value }), false);
	assert.equal(deferredToolsEnabled({ [LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV]: "1" }), true);
	assert.equal(deferredToolsEnabled({ [LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV]: "0" }), false);
	assert.equal(deferredToolsEnabled({ [DEFERRED_TOOLS_ENV]: "0", [LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV]: "1" }), false, "稳定变量必须优先");
	assert.equal(deferredToolsEnabled({ [DEFERRED_TOOLS_ENV]: "1", [LEGACY_EXPERIMENTAL_DEFERRED_TOOLS_ENV]: "0" }), true, "稳定变量必须优先");

	const runtime = fakeRuntime();
	registerDeferredTools(runtime.api, {});
	assert.equal(runtime.tools.has(DEFERRED_TOOL_SEARCH_NAME), true);
	const disabled = fakeRuntime();
	registerDeferredTools(disabled.api, { [DEFERRED_TOOLS_ENV]: "0" });
	assert.equal(disabled.tools.has(DEFERRED_TOOL_SEARCH_NAME), false);
});

test("中英文 capability map 只命中保留的 deferred groups", () => {
	for (const retired of ["旧工单平台", "历史服务目录", "旧配置中心", "legacy platform", "内部包发布", "退役业务平台"]) {
		assert.deepEqual(matchDeferredCapabilityGroups(retired), [], `退出产品的能力不得被搜索加载：${retired}`);
	}
	assert.deepEqual(matchDeferredCapabilityGroups("读取登录态网页文档"), [], "Browser 已常驻，不得再由 loader 路由");
	assert.deepEqual(matchDeferredCapabilityGroups("使用 MCP server tool"), [], "MCP 已退出产品面");
	assert.deepEqual(matchDeferredCapabilityGroups("让 Opus 子agent 做评审"), ["subagent"]);
	assert.deepEqual(matchDeferredCapabilityGroups("run fusion research in background", 3), []);
	assert.deepEqual(matchDeferredCapabilityGroups("修复 TypeScript 单元测试"), []);
	assert.deepEqual(DEFERRED_CAPABILITY_GROUPS.map((group) => group.id), ["subagent"]);
	for (const unrelated of [
		"fix mapping parser",
		"switch to main branch",
		"fix the express middleware",
		"validate the JSON schema",
		"web worker bundling",
		"cell a1 formatting",
		"应用这个补丁",
		"fix the CI pipeline",
	]) assert.deepEqual(matchDeferredCapabilityGroups(unrelated), [], `普通工程 query 不得误加载 specialized tools: ${unrelated}`);
});

test("默认全工具面在 session_start 保留 core + Ask + Browser/Computer Use + Goal + loader", async () => {
	const runtime = fakeRuntime();
	registerDeferredTools(runtime.api, {});
	await runtime.start();
	assert.deepEqual(new Set(runtime.active()), new Set([...RESIDENT_PRODUCT_TOOLS, DEFERRED_TOOL_SEARCH_NAME]));
	for (const tool of RESIDENT_BROWSER_TOOL_NAMES) assert.ok(runtime.active().includes(tool), `Browser/Computer Use 常驻工具缺失：${tool}`);
	const search = runtime.tools.get(DEFERRED_TOOL_SEARCH_NAME);
	assert.deepEqual(search.promptGuidelines, [...DEFERRED_TOOL_ROUTING_GUIDELINES]);
	assert.equal(search.executionMode, "sequential", "多个 group loader call 不得并发覆盖 active set");
	assert.doesNotMatch(JSON.stringify([search.description, search.promptSnippet, search.promptGuidelines]), /legacy-tracker|legacy-config/iu);
});

test("loader 只做 additive group 激活并持久化 resume/fork 所需状态", async () => {
	const runtime = fakeRuntime();
	registerDeferredTools(runtime.api, {});
	await runtime.start();
	const before = runtime.active();
	const search = runtime.tools.get(DEFERRED_TOOL_SEARCH_NAME);
	const result = await search.execute("load-subagent", { query: "委派子代理" });
	assert.deepEqual(result.details.matches, ["subagent"]);
	assert.deepEqual(result.details.added, ["subagent", "subagent_wait"]);
	assert.ok(before.every((name) => runtime.active().includes(name)), "loader 不得移除当前 active tools");
	assert.deepEqual(runtime.entries.at(-1), { type: "custom", customType: DEFERRED_TOOL_STATE_ENTRY, data: { v: 1, groups: ["subagent"] } });

	for (const reason of ["resume", "fork", "reload"]) {
		const restored = fakeRuntime(runtime.entries);
		registerDeferredTools(restored.api, {});
		await restored.start(reason);
		assert.deepEqual(restored.active(), runtime.active());
	}

	const again = await search.execute("load-again", { query: "Subagent" });
	assert.deepEqual(again.details.added, []);
	assert.deepEqual(runtime.entries.at(-1).data.groups, ["subagent"]);
});

test("tree is additive in the live runtime; replacement derives only its selected branch", async () => {
	const live = fakeRuntime(); registerDeferredTools(live.api); await live.start();
	await live.tools.get(DEFERRED_TOOL_SEARCH_NAME).execute("discover", { query: "subagent" });
	const discoveredBranch = structuredClone(live.entries);
	await live.tree([]);
	assert.ok(live.active().includes("subagent"), "tree navigation is not a capability revocation boundary");
	assert.equal(live.entries.length, 0, "navigation must not copy an abandoned discovery onto the new branch");
	for (const reason of ["new", "resume", "fork", "reload"]) {
		const replacement = fakeRuntime(live.entries); registerDeferredTools(replacement.api); await replacement.start(reason);
		assert.equal(replacement.active().includes("subagent"), false, reason);
	}
	const resumedDiscovered = fakeRuntime(discoveredBranch); registerDeferredTools(resumedDiscovered.api); await resumedDiscovered.start("resume");
	assert.ok(resumedDiscovered.active().includes("subagent"));
	// Explicitly discovering again journals the still-active capability on this branch.
	await live.tools.get(DEFERRED_TOOL_SEARCH_NAME).execute("rediscover", { query: "子代理" });
	assert.deepEqual(live.entries.at(-1).data.groups, ["subagent"]);
	const restored = fakeRuntime(live.entries); registerDeferredTools(restored.api); await restored.start("fork");
	assert.deepEqual(restored.active(), live.active());
});

test("旧会话丢弃退出产品的 groups，resume/fork 仍恢复 Subagent", async () => {
	for (const reason of ["resume", "fork"]) {
		for (const retained of [[], ["subagent"]]) {
			const legacy = fakeRuntime([{ type: "custom", customType: DEFERRED_TOOL_STATE_ENTRY, data: { v: 1, groups: ["mcp", "legacy-tracker", "legacy-config", "browser-ui", "unavailable-future-group", ...retained] } }]);
			registerDeferredTools(legacy.api, {});
			await legacy.start(reason);
			assert.deepEqual(legacy.active(), [...RESIDENT_PRODUCT_TOOLS, DEFERRED_TOOL_SEARCH_NAME, ...(retained.length ? ["subagent", "subagent_wait"] : [])]);
			const before = legacy.active();
			const result = await legacy.tools.get(DEFERRED_TOOL_SEARCH_NAME).execute("retired", { query: "legacy platform" });
			assert.deepEqual(result.details, { matches: [], added: [] });
			assert.deepEqual(legacy.active(), before);
			assert.equal(legacy.entries.length, 1, "未命中不得写入新的 capability state");
			await legacy.tools.get(DEFERRED_TOOL_SEARCH_NAME).execute("retained", { query: "subagent" });
			assert.deepEqual(legacy.entries.at(-1).data.groups, ["subagent"], "下一次持久化不得带回已退役 ID");
		}
	}
});

test("结构损坏或未知版本的快照不覆盖有效的 Subagent 状态", async () => {
	for (const bad of [{ v: 1, groups: [null] }, { v: 1, groups: ["subagent", 3] }, { v: 2, groups: [] }]) {
		const runtime = fakeRuntime([
			{ type: "custom", customType: DEFERRED_TOOL_STATE_ENTRY, data: { v: 1, groups: ["subagent"] } },
			{ type: "custom", customType: DEFERRED_TOOL_STATE_ENTRY, data: bad },
		]);
		registerDeferredTools(runtime.api, {});
		await runtime.start("resume");
		assert.ok(runtime.active().includes("subagent"));
		assert.ok(runtime.active().includes("subagent_wait"));
	}
});

test("中英文重复加载产生字节一致的 active tools 与持久化 state", async () => {
	async function loadInOrder(queries: string[]) {
		const runtime = fakeRuntime();
		registerDeferredTools(runtime.api, {});
		await runtime.start();
		const search = runtime.tools.get(DEFERRED_TOOL_SEARCH_NAME);
		for (const query of queries) await search.execute("load", { query });
		return {
			runtime,
			activeBytes: JSON.stringify(runtime.active()),
			stateBytes: JSON.stringify(runtime.entries.at(-1)),
		};
	}

	const forward = await loadInOrder(["Subagent", "委派子代理"]);
	const reverse = await loadInOrder(["委派子代理", "Subagent"]);
	assert.equal(forward.activeBytes, reverse.activeBytes);
	assert.equal(forward.stateBytes, reverse.stateBytes);
	assert.deepEqual(JSON.parse(forward.activeBytes), [
		...RESIDENT_PRODUCT_TOOLS,
		DEFERRED_TOOL_SEARCH_NAME,
		"subagent",
		"subagent_wait",
	]);
	assert.deepEqual(JSON.parse(forward.stateBytes).data.groups, ["subagent"]);

	const resumed = fakeRuntime(forward.runtime.entries);
	registerDeferredTools(resumed.api, {});
	await resumed.start("resume");
	assert.equal(JSON.stringify(resumed.active()), forward.activeBytes);
});

test("loader 不重新激活被显式排除的 Goal 工具", async () => {
	const runtime = fakeRuntime();
	registerDeferredTools(runtime.api);
	runtime.setActive(runtime.active().filter((name) => !GOAL_TOOL_NAMES.includes(name)));
	await runtime.start();
	await runtime.tools.get(DEFERRED_TOOL_SEARCH_NAME).execute("discover", { query: "subagent" });
	for (const name of GOAL_TOOL_NAMES) assert.equal(runtime.active().includes(name), false, name);
});

test("显式 full allowlist 与 narrowed runtime policy 都优先于默认 deferred", async () => {
	const fullAllowlist = fakeRuntime();
	registerDeferredToolsBase(fullAllowlist.api, {});
	await fullAllowlist.start();
	assert.deepEqual(new Set(fullAllowlist.active()), new Set([...ALL_PRODUCT_TOOLS, DEFERRED_TOOL_SEARCH_NAME]), "没有 launcher default-surface handshake 时不得缩减完整显式 allowlist");

	const narrowed = fakeRuntime();
	registerDeferredTools(narrowed.api, {});
	const explicit = [...DEFERRED_INITIAL_TOOL_NAMES, DEFERRED_TOOL_SEARCH_NAME, "subagent"];
	narrowed.setActive(explicit);
	await narrowed.start();
	assert.deepEqual(narrowed.active(), explicit, "即使 launcher 标记默认面，已受 runtime policy 缩窄的集合也不得被改写");
});
