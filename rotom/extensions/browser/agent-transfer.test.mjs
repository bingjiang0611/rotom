import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import { resetTransferredItemV1, transferTargetSessionV1, transferredTabNameV1 } from "./chrome-extension/agent-transfer.js";
import { coordinateViewport, mintCoordinateObservation, validateCoordinateBinding } from "./chrome-extension/coordinate-click.js";
import { formatScopedAxRef, parseScopedAxRef } from "./chrome-extension/scoped-ax-ref.js";
import { forgetSpawnedTab, MAX_SPAWNED_TAB_LINKS, recordedOpenerTabId, rememberSpawnedTab } from "./chrome-extension/spawned-tabs.js";

const worker = await readFile(resolve("rotom/extensions/browser/chrome-extension/service-worker.js"), "utf8");

const session = (agentId, rootSessionId, tabs = []) => ({ agentId, rootSessionId, tabsByName: new Map(tabs.map((name, index) => [name, { tabId: index + 1, documentGeneration: 1, ownership: "agent" }])) });

test("transfer 只接受同一 root 下的目标 agent，且歧义必须拒绝", () => {
	const sessions = [session("main", "root-a"), session("run_2", "root-a"), session("run_9", "root-b")];
	assert.equal(transferTargetSessionV1(sessions, { rootSessionId: "root-a", toAgentId: "run_2" }).agentId, "run_2");
	assert.throws(() => transferTargetSessionV1(sessions, { rootSessionId: "root-a", toAgentId: "run_9" }), /no relay session for agent run_9/u, "不同 root 的 agent 不能被移交");
	assert.throws(() => transferTargetSessionV1(sessions, { rootSessionId: "root-a", toAgentId: "main_typo" }), /no relay session/u);
	assert.throws(() => transferTargetSessionV1([...sessions, session("run_2", "root-a")], { rootSessionId: "root-a", toAgentId: "run_2" }), /multiple relay sessions/u, "两个连接同报一个 agentId 时不能猜");
	assert.throws(() => transferTargetSessionV1(sessions, { rootSessionId: "root-a", toAgentId: "bad agent" }), /toAgentId invalid/u);
});

test("接收方 tabName 是 <原名>@<来源 agent>，超长与非法字符在本地拒绝", () => {
	assert.equal(transferredTabNameV1("checkout", "run_2"), "checkout@run_2");
	assert.equal(transferredTabNameV1("a", "main"), "a@main");
	assert.equal(transferredTabNameV1("checkout@run_1", "run_2"), "checkout@run_1@run_2", "已含 @ 的名称仍可用");
	assert.throws(() => transferredTabNameV1("n".repeat(60), "run_agent"), /keep the source tabName under/u, "拼接后超过 64 字符必须拒绝");
	assert.throws(() => transferredTabNameV1("-leading", "main"), /tabName format invalid/u);
	assert.throws(() => transferredTabNameV1("checkout", ""), /source agent invalid/u);
});

test("transfer 之后旧 ref 与旧截图坐标都失效", () => {
	const item = { tabId: 7, documentGeneration: 3, ownership: "agent", observationEpoch: 4 };
	const metrics = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1 } };
	const binding = mintCoordinateObservation(item, metrics);
	const oldRef = formatScopedAxRef(item.documentGeneration, "r", 42);
	assert.equal(parseScopedAxRef(oldRef, item.documentGeneration).backendNodeId, 42, "移交前 ref 可用");

	resetTransferredItemV1(item);
	assert.equal(item.documentGeneration, 4, "移交必须换新 documentGeneration");
	assert.ok(item.observationEpoch > binding.observationEpoch, "移交必须换新 observationEpoch");
	assert.equal(parseScopedAxRef(oldRef, item.documentGeneration), undefined, "旧 ref 在新 generation 下解析失败，即 stale");
	assert.throws(() => validateCoordinateBinding(item, { x: 10, y: 10, observationEpoch: binding.observationEpoch, documentGeneration: 3 }, metrics),
		/current browser screenshot|stale/u, "移交后旧坐标必须先重新截图");
	mintCoordinateObservation(item, metrics);
	assert.throws(() => validateCoordinateBinding(item, { x: 10, y: 10, observationEpoch: binding.observationEpoch, documentGeneration: 3 }, metrics), /stale/u, "旧 epoch 在新截图之后必须报 stale");
	assert.equal(coordinateViewport(metrics).width, 800);
});

test("弹窗归属记录有界，并在 tab 关闭时清理", () => {
	const links = new Map();
	rememberSpawnedTab(links, 20, 10);
	assert.equal(recordedOpenerTabId(links, { id: 20 }), 10, "记录优先于 Chrome 的 openerTabId");
	assert.equal(recordedOpenerTabId(links, { id: 20, openerTabId: 99 }), 10);
	assert.equal(recordedOpenerTabId(links, { id: 21, openerTabId: 99 }), 99, "没有记录时退回浏览器字段");
	assert.equal(recordedOpenerTabId(links, { id: 22 }), undefined, "两者都没有就是没有 opener");
	for (let index = 0; index < MAX_SPAWNED_TAB_LINKS + 10; index += 1) rememberSpawnedTab(links, 100 + index, 10);
	assert.equal(links.size, MAX_SPAWNED_TAB_LINKS, "记录必须有界");
	assert.equal(recordedOpenerTabId(links, { id: 20 }), undefined, "最旧的记录被淘汰");
	rememberSpawnedTab(links, 200, 10);
	forgetSpawnedTab(links, 200);
	assert.equal(links.has(200), false, "tab 关闭后必须清理");
	rememberSpawnedTab(links, "bad", 10);
	assert.equal(links.has("bad"), false, "非整数 id 不记录");
});

test("service worker 侧接线：discover/claim 隔离另一个 session，并暴露 transfer 能力", () => {
	const discoverBlock = worker.match(/if \(operation === "discover"\) \{[\s\S]*?\n\t\}/u)?.[0] ?? "";
	assert.match(discoverBlock, /ownedIds = new Set\(\[\.\.\.allSessionItems\(\)/u, "discover 必须排除所有 relay session 已拥有的 tab");
	assert.match(discoverBlock, /const openerTabId = recordedOpenerTabId\(spawnedTabOpeners, tab\);/u, "opener 必须优先用 relay 自己记录的相关性");
	assert.match(discoverBlock, /openerOwnedByYou: sessionOwnsTabId\(state, openerTabId\)/u, "由自己的 tab 打开的新 tab 才标 openerOwnedByYou");

	const claimBlock = worker.match(/if \(operation === "claim"\) \{[\s\S]*?\n\t\}/u)?.[0] ?? "";
	assert.match(claimBlock, /tab already owned by another relay session/u, "claim 别人的 tab 必须拒绝");
	assert.doesNotMatch(claimBlock, /findSessionItemByTabId[\s\S]*?tabName/u, "claim 的拒绝信息不得带出对方 tabName");
	assert.match(claimBlock, /openerOwner !== undefined && openerOwner !== state/u, "只有 opener 属于另一个 session 时才拒绝 claim");
	assert.match(claimBlock, /only its opener may claim it/u, "其他 session 打开的弹窗只能由 opener 的拥有者 claim");

	const transferBlock = worker.match(/if \(operation === "transfer"\) \{[\s\S]*?\n\t\}/u)?.[0] ?? "";
	assert.match(transferBlock, /transferTargetSessionV1\(sessionStates\.values\(\), \{ rootSessionId: state\.rootSessionId, toAgentId: payload\.toAgentId \}\)/u);
	assert.match(transferBlock, /resetTransferredItemV1\(item\)/u);
	assert.match(transferBlock, /state\.tabsByName\.delete\(name\)[\s\S]*?target\.tabsByName\.set\(nextName, item\)/u, "移交是一次移动，不能同时留在两边");
	assert.match(transferBlock, /await persistState\(\)/u);
	assert.match(worker, /sessionOwnsTabId\(state, tabId\)/u);
	assert.match(worker, /"cross-agent-transfer"/u, "hello 必须声明 transfer 能力，客户端按能力本地拒绝旧扩展");
});
