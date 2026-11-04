import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import { uniqueTransferredNameV1 } from "./chrome-extension/agent-transfer.js";
import { sessionCleanupPlanV1 } from "./chrome-extension/session-cleanup.js";

const worker = await readFile(resolve("rotom/extensions/browser/chrome-extension/service-worker.js"), "utf8");

const opened = { tabId: 1, ownership: "agent" };
const claimed = { tabId: 2, ownership: "claimed" };
const transferredIn = { tabId: 3, ownership: "agent", transferredFrom: "run_other" };

test("主 agent 断开只 detach，不关也不交还", () => {
	const plan = sessionCleanupPlanV1({ agentId: "main", keepTabs: false, hasMainAgent: true, tabs: [{ name: "a", item: opened }, { name: "b", item: claimed }] });
	assert.deepEqual(plan.closes, []);
	assert.deepEqual(plan.handBacks, []);
	assert.deepEqual(plan.detaches.map((entry) => entry.name), ["a", "b"]);
});

test("子 agent 断开：自己开的关掉，claim 和移交来的交还主 agent", () => {
	const plan = sessionCleanupPlanV1({
		agentId: "run_agent_1",
		keepTabs: false,
		hasMainAgent: true,
		tabs: [{ name: "scratch", item: opened }, { name: "user-tab", item: claimed }, { name: "from-other", item: transferredIn }],
	});
	assert.deepEqual(plan.closes, [{ name: "scratch", tabId: 1 }]);
	assert.deepEqual(plan.handBacks.map((entry) => [entry.name, entry.toName]), [["user-tab", "user-tab@run_agent_1"], ["from-other", "from-other@run_agent_1"]]);
	assert.deepEqual(plan.detaches, []);
});

test("主 agent 不在线时只 detach，用户标签不会被关掉", () => {
	const plan = sessionCleanupPlanV1({
		agentId: "run_agent_1",
		keepTabs: false,
		hasMainAgent: false,
		tabs: [{ name: "scratch", item: opened }, { name: "user-tab", item: claimed }],
	});
	assert.deepEqual(plan.closes, [{ name: "scratch", tabId: 1 }], "自己开的仍然关掉");
	assert.deepEqual(plan.handBacks, []);
	assert.deepEqual(plan.detaches.map((entry) => entry.name), ["user-tab"]);
});

test("keepTabs 时不关任何 tab，只 detach", () => {
	const plan = sessionCleanupPlanV1({
		agentId: "run_agent_1",
		keepTabs: true,
		hasMainAgent: true,
		tabs: [{ name: "scratch", item: opened }, { name: "user-tab", item: claimed }],
	});
	assert.deepEqual(plan.closes, []);
	assert.deepEqual(plan.handBacks, []);
	assert.deepEqual(plan.detaches.map((entry) => entry.name), ["scratch", "user-tab"]);
});

test("交还名字冲突时加数字后缀，不覆盖主 agent 已有 tab", () => {
	const taken = new Set(["user-tab@run_agent_1", "user-tab@run_agent_1-2"]);
	const plan = sessionCleanupPlanV1({ agentId: "run_agent_1", keepTabs: false, hasMainAgent: true, tabs: [{ name: "user-tab", item: claimed }], mainTaken: taken });
	assert.equal(plan.handBacks[0].toName, "user-tab@run_agent_1-3");
	assert.equal(uniqueTransferredNameV1(new Set(), "docs", "run_1"), "docs@run_1");
	assert.equal(uniqueTransferredNameV1(new Set(["docs@run_1"]), "docs", "run_1"), "docs@run_1-2");
	// 名字过长时没有可用后缀，交接方必须只 detach，而不是丢 tab。
	const longName = "n".repeat(58);
	assert.throws(() => uniqueTransferredNameV1(new Set([`${longName}@run_1`]), longName, "run_1"), /no free transferred tab name|keep the source tabName under/u);
});

test("service worker 侧接线：断开时按 plan 关/交还/detach，keepTabs 从 hello 进来", () => {
	const retireBlock = worker.match(/async function retireDisconnectedSession\(state\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(retireBlock, /sessionCleanupPlanV1\(\{/u);
	assert.match(retireBlock, /for \(const \{ name \} of plan\.closes\) await closeOwned\(state, name\);/u);
	assert.match(retireBlock, /main\.tabsByName\.set\(toName, item\)/u, "交还的 tab 必须进入主 agent 的 ownership");
	assert.match(retireBlock, /resetTransferredItemV1\(item\)/u, "交还必须换新 generation/epoch");
	assert.match(retireBlock, /await detachItemsPreservingState\(detachItems\)/u);
	assert.match(worker, /state\.keepTabs = payload\.keepTabs === true;/u, "keepTabs 由 hello 上报");
	assert.match(worker, /connectedMainSessionForRoot\(state\.rootSessionId\)/u, "只交给在线的主 agent");
	const cleanupBlock = worker.match(/function queueRelaySessionCleanup\(sessionId, generation\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(cleanupBlock, /await retireDisconnectedSession\(state\)/u, "断开清理必须走新的归属逻辑");
});
