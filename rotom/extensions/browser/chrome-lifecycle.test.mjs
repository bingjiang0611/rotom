import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sessionPrincipalFromHello, DEFAULT_AGENT_ID, restoredSessionPrincipal, isMainAgentPrincipal, sessionPrincipalValue } from "./chrome-extension/session-principal.js";
import { extensionDir, root, restoreState_block } from "./chrome-test-paths.mjs";
test("Chrome MV3 worker 隔离 session ownership、持久化与 native host 路由", async () => {
	const worker = await readFile(join(extensionDir, "service-worker.js"), "utf8");
	const nativeHost = await readFile(join(root, "native-host.mjs"), "utf8");
	// tab 激活只能当作「用户焦点」信号进 focusCoordinator，不得再当作归属证据。
	assert.equal(worker.split("chrome.tabs.onActivated").length - 1, 1);
	assert.match(worker, /chrome\.tabs\.onActivated\.addListener\(\(info\) => \{ focusCoordinator\.recordActivation/u);
	assert.match(worker, /closeOwnedIdentity\(state, name, tab\.id, item, assertOperation\)/u);
	const tabsBlock = worker.match(/if \(operation === "tabs"\) \{[\s\S]*?return \{ schemaVersion: 1, kind: "rotom-browser-tabs", \.\.\.sessionPrincipalValue\(state\), tabs: withDialogs \};\n\t\}/u)?.[0] ?? "";
	assert.match(tabsBlock, /collectListedOwnedTabs/u, "tabs 必须通过可故障注入的非破坏 collector 降级状态");
	assert.match(tabsBlock, /sessionPrincipalValue\(state\)/u, "tabs 结果必须带当前 session 的 agentId/rootSessionId");
	// tabs 是弹窗期间唯一能看到「哪个 tab 被阻塞」的只读出口。
	assert.match(tabsBlock, /dialogState\.get\(tab\.tabId\)/u, "tabs 必须带当前弹窗状态");
	const principalBlock = worker.match(/if \(operation === "hello"\) \{[\s\S]*?capabilities:/u)?.[0] ?? "";
	assert.match(principalBlock, /sessionPrincipalFromHello\(payload, state\.sessionId\)/u, "hello 必须校验并记录 browser principal");
	assert.match(principalBlock, /await persistState\(\)/u, "principal 必须在 hello 时落盘，SW 重启后仍能归属 agent");
	// The serialized shape moved to session-persistence.js (one key per session).
	const persistenceModule = await readFile(resolve("rotom/extensions/browser/chrome-extension/session-persistence.js"), "utf8");
	assert.match(persistenceModule, /agentId: state\.agentId/u);
	assert.match(persistenceModule, /rootSessionId: state\.rootSessionId/u);
	assert.match(worker, /serializeSessionStateV3\(state\)/u, "SW 必须用共享序列化写入 principal");
	assert.match(restoreState_block(worker), /restoredSessionPrincipal\(stored, state\.sessionId\)/u, "SW 重启后必须恢复 principal");
	assert.doesNotMatch(tabsBlock, /closeOwned|chrome\.tabs\.remove/u, "tabs 健康检查不得关闭标签或删除 ownership");
	const restoreBlock = worker.match(/async function restoreState\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(restoreBlock, /try \{[\s\S]*?chrome\.debugger\.getTargets\(\)[\s\S]*?catch/u, "restore target 发现失败必须保留缓存 ownership");
	assert.match(restoreBlock, /isMissingChromeTabError\(error\)/u, "restore 只能在 Chrome 明确确认 tab 不存在时丢弃登记");
	assert.doesNotMatch(restoreBlock, /!target[^\n]*continue/u, "restore target 暂缺不得删除 ownership");
	assert.match(worker, /lock: createSessionLockV1\(\), tabLocks: createTabLocksV1\(\)/u, "每个 relay session 有独立的 session 锁与 tab 锁，不能被其他 session 的长任务阻塞");
	assert.match(worker, /isSessionScopedOperationV1\(message\.operation\)[\s\S]*?state\.lock\.write\(\(\) =>[\s\S]*?state\.lock\.read\(\(\) =>[\s\S]*?state\.tabLocks\.run\(/u, "结构性操作用 session 写锁，其余按 tab 加锁");
	const cleanupBlock = worker.match(/function queueRelaySessionCleanup\(sessionId, generation\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(cleanupBlock, /state\.epoch \+= 1;/u, "client disconnect 只失效对应 session");
	assert.match(cleanupBlock, /state\.lock\.write\(/u, "detach 全部标签是结构性操作，必须走 session 写锁");
	assert.match(worker, /const sessionWriter = createMergedSessionWriter\(\{/u, "并发 session 的 storage 写入必须走合并写，且按 session 分 key");
	assert.match(worker, /tabReservations\.has\(payload\.tabId\)[\s\S]*?tabReservations\.add\(payload\.tabId\)[\s\S]*?finally \{ tabReservations\.delete\(payload\.tabId\); \}/u, "并发 claim 必须全局原子保留 tab identity");
	assert.match(worker, /message\.operation === "client-disconnected"[\s\S]*?queueRelaySessionCleanup\(message\.sessionId, message\.generation\)/u);
	assert.match(worker, /nativePort\.onDisconnect\.addListener[\s\S]*?queueAllRelaySessionCleanup\(\)[\s\S]*?scheduleReconnect\(\)/u);
	assert.match(worker, /withBackgroundActivationGuard\(item/u);
	assert.match(worker, /updateTab: async \(tabId\) => globalThis\.chrome\.tabs\.update\(tabId, \{ active: true \}\)/u, "click 创建新标签后必须恢复原活动标签");
	assert.match(worker, /if \(!focusCoordinator\.userFocus\(\)\) await focusCoordinator\.observeActiveTab\(sourceTab\.windowId\)/u, "新启动的 service worker 必须先记录真实活动标签");
	assert.match(worker, /chrome\.windows\.update\(windowId, \{ focused: false \}\)/u, "Chrome 原本后台时必须撤销 popup 窗口焦点");
	assert.match(worker, /windowOpenGuardsByTabId[\s\S]*?method === "Page\.windowOpen"[\s\S]*?guard\.signals\.push/u, "noopener popup 必须通过 source-tab CDP windowOpen 信号关联，不能全局捕获其他 session 或用户的新 active tab");
	assert.match(worker, /consumeMatchingWindowOpenSignal\(windowOpenGuard\.signals, tab/u, "Page.windowOpen 必须与 created tab URL 精确关联");
	assert.doesNotMatch(worker.match(/async function withBackgroundActivationGuard[\s\S]*?\n\}/u)?.[0] ?? "", /tab\.active !== true|!knownTabIds\.has\(tab\.id\) && tab\.active/u, "activation guard 不得把任意全局新 active tab 归因给当前 click");
	assert.match(worker, /chrome\.tabs\.onCreated\.addListener\(onCreated\)[\s\S]*?chrome\.tabs\.onCreated\.removeListener\(onCreated\)/u);
	assert.match(worker, /backgroundPreserved: guarded\.restored, spawnedTabs: guarded\.spawnedTabs/u);
	assert.doesNotMatch(worker, /Page\.bringToFront/u);
	assert.match(nativeHost, /const clientBindings = new Map\(\)/u);
	assert.match(nativeHost, /client\.on\("error", \(\) =>/u, "单 client socket error 必须被隔离，不能终止共享 native host");
	assert.doesNotMatch(nativeHost, /activeClient|busyResponse|acquireClient/u, "protocol 15 native host 不得保留单 active client 仲裁");
	assert.match(nativeHost, /sendDirect\(route\.client, message, \(error\) => \{[\s\S]*?completeRoute\(key\)/u, "response route 只能在 socket write flush callback 中释放");
	assert.doesNotMatch(nativeHost.match(/function cleanupClient[\s\S]*?\n\}/u)?.[0] ?? "", /pendingRoutes\.delete/u, "client 在途断开时必须保留 route，直到旧 response 到达");
	assert.match(worker, /nativePort\.onDisconnect\.addListener\(\(\) => \{[\s\S]*?void chrome\.runtime\.lastError/u, "Native Host 正常退出或重载竞态必须消费 runtime.lastError，避免扩展错误页误报");
	assert.match(worker, /closeAllOwned\(state, assertOperation\)/u);
	assert.equal(worker.includes("Another debugger is already attached"), false);
});
test("hello principal：缺省按主 agent，显式字段生效，坏值拒绝", () => {
	assert.deepEqual(sessionPrincipalFromHello({}, "session-1"), { agentId: DEFAULT_AGENT_ID, rootSessionId: "session-1" }, "旧客户端不带字段时按主 agent 处理");
	assert.deepEqual(sessionPrincipalFromHello({ agentId: "run_9", rootSessionId: "root-7", leaseToken: "lease-a" }, "session-2"), { agentId: "run_9", rootSessionId: "root-7", leaseToken: "lease-a" });
	for (const payload of [{ agentId: "" }, { agentId: 7 }, { agentId: "a b" }, { agentId: "x".repeat(129) }, { rootSessionId: "line\nbreak" }, { leaseToken: "\u0000" }]) {
		assert.throws(() => sessionPrincipalFromHello(payload, "session-3"), /invalid/u, JSON.stringify(payload));
	}
	assert.deepEqual(restoredSessionPrincipal({ agentId: "run_9", rootSessionId: "root-7" }, "session-4"), { agentId: "run_9", rootSessionId: "root-7" }, "SW 重启后恢复身份");
	assert.deepEqual(restoredSessionPrincipal({ agentId: "not valid" }, "session-4"), { agentId: DEFAULT_AGENT_ID, rootSessionId: "session-4" }, "坏持久化值回落主 agent，不丢所有权");
	assert.equal(isMainAgentPrincipal({ agentId: DEFAULT_AGENT_ID }), true);
	assert.equal(isMainAgentPrincipal({ agentId: "run_9" }), false);
	assert.deepEqual(sessionPrincipalValue({ sessionId: "session-5" }), { agentId: DEFAULT_AGENT_ID, rootSessionId: "session-5" });
});
