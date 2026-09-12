import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import test from "node:test";
import { mergeRenderedText, scrollableTextTargets } from "./chrome-extension/full-read.js";
import { observedInteractionNode } from "./chrome-extension/interaction-observation.js";
import { invalidateCoordinateObservation, mintCoordinateObservation, validateCoordinateBinding, validateCoordinateHit } from "./chrome-extension/coordinate-click.js";
import { interactionScrollTarget } from "./chrome-extension/interaction-scroll-target.js";
import { createOperationGuard } from "./chrome-extension/operation-guard.js";
import { consumeMatchingWindowOpenSignal } from "./chrome-extension/window-open-correlation.js";
import { relayOperationDeadlineMs, runWithRelayDeadline, valueWithinRelayDeadline } from "./chrome-extension/relay-deadline.js";
import { collectRenderedText, utf8TextChunks } from "./chrome-extension/rendered-text.js";
import { collectPageAlerts, pageAlertNodes } from "./chrome-extension/page-alerts.js";
import { evaluateInteractionExpectation, interactionTargetChange, parseInteractionExpectation, readInteractionTargetState } from "./chrome-extension/interaction-target-state.js";
import { formatScopedAxRef, parseScopedAxRef } from "./chrome-extension/scoped-ax-ref.js";
import { agentOwnedTabIdsInWindow, placeAgentTabsInSharedGroup } from "./chrome-extension/shared-tab-group.js";
import { collectListedOwnedTabs, isMissingChromeTabError, listedOwnedTabStatus } from "./chrome-extension/tab-list-status.js";

const root = resolve("rotom/extensions/browser");
const extensionDir = join(root, "chrome-extension");
const installer = join(root, "install-chrome-relay.mjs");
const extensionId = "kgadcllokaodnoknakblocmhidemimdi";

test("Chrome MV3 manifest 固定 identity 且不申请 cookie/script/host 权限", async () => {
	const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
	assert.equal(manifest.manifest_version, 3);
	assert.equal(manifest.version, "0.9.0");
	const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
	const derived = [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
	assert.equal(derived, extensionId);
	assert.deepEqual([...manifest.permissions].sort(), ["alarms", "debugger", "nativeMessaging", "storage", "tabGroups", "tabs"].sort());
	assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
	assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
	const worker = await readFile(join(extensionDir, "service-worker.js"), "utf8");
	const nativeHost = await readFile(join(root, "native-host.mjs"), "utf8");
	const scrollTarget = await readFile(join(extensionDir, "interaction-scroll-target.js"), "utf8");
	const tabListStatus = await readFile(join(extensionDir, "tab-list-status.js"), "utf8");
	const extensionSource = `${worker}\n${scrollTarget}\n${tabListStatus}`;
	assert.doesNotMatch(worker, /^await\b/mu, "MV3 service worker 不允许 top-level await");
	assert.match(worker, /void startRelay\(\);/u);
	for (const denied of ["chrome.cookies", "chrome.scripting"]) assert.equal(extensionSource.includes(denied), false, denied);
	assert.match(worker, /collectRenderedText\.toString\(\)/u, "只允许扩展内置的固定正文提取函数，不接受模型提供 JavaScript");
	assert.match(worker, /chrome\.tabs\.create\(\{ url, active: false \}\)/u);
	assert.match(worker, /let tabGroupChain = Promise\.resolve\(\)/u, "跨 session 并发 open 必须串行收敛共享标签组");
	assert.match(worker, /tabGroupChain = pending\.catch\(\(\) => undefined\)/u);
	assert.match(worker, /await placeInSharedAgentGroup\(tab, assertOperation\)/u);
	assert.doesNotMatch(worker, /chrome\.tabs\.group\(\{ tabIds: \[tab\.id\] \}\)/u, "不得为每个 Pi 标签单独创建分组");
	assert.match(worker, /operation === "discover"/u);
	assert.match(worker, /operation === "claim"/u);
	assert.match(worker, /operation === "handoff"/u);
	assert.match(worker, /item\.ownership !== "claimed"/u, "handoff/close 必须保留用户原标签");
	assert.match(worker, /chrome\.debugger\.attach\(\{ tabId: item\.tabId \}, "1\.3"\)/u);
	assert.match(worker, /chrome\.debugger\.getTargets\(\)/u);
	assert.match(worker, /candidate\.id === item\.targetId/u);
	assert.match(worker, /state\.epoch !== expectedEpoch/u);
	assert.match(worker, /protocolRevision: 17/u);
	assert.match(worker, /"targeted-keypress"/u);
	assert.match(worker, /"virtualized-frame-scroll"/u);
	assert.match(worker, /"multi-client-multiplex"/u);
	assert.match(worker, /"coordinate-click"/u);
	assert.match(worker, /"interaction-target-state"/u);
	assert.match(worker, /"page-alert-readback"/u);
	assert.match(worker, /const sessionStates = new Map\(\)/u);
	assert.match(worker, /browserRelayStateV2/u);
	assert.match(worker, /allSessionItems\(\)/u, "discover/claim 与 Chrome events 必须看到所有 relay session 的 tab ownership");
	assert.match(worker, /chrome\.alarms\.create\(NATIVE_RECONNECT_ALARM/u, "Native Messaging 断开后必须有可唤醒 MV3 worker 的重连兜底");
	assert.match(worker, /"oopif-accessibility"/u);
	assert.match(worker, /"rendered-document-text"/u);
	assert.match(worker, /"full-document-read"/u);
	assert.match(worker, /"content-coverage"/u);
	assert.match(worker, /"non-destructive-timeout"/u);
	assert.match(worker, /"in-place-recovery"/u);
	assert.match(worker, /"operation-deadline"/u);
	assert.match(worker, /Target\.setAutoAttach/u);
	assert.match(worker, /flatten: true/u);
	assert.match(worker, /Target\.attachedToTarget/u);
	assert.match(worker, /Page\.frameNavigated/u);
	assert.match(worker, /rotateChildSessionScope/u);
	assert.match(worker, /sessionId: entry\.sessionId/u);
	assert.match(worker, /valueWithinRelayDeadline\(chrome\.debugger\.sendCommand\(\{ tabId: item\.tabId, sessionId: entry\.sessionId \}, "Accessibility\.getFullAXTree"/u);
	assert.match(worker, /handleOperationWithDeadline/u);
	assert.match(worker, /resetAfterOperationTimeout/u);
	assert.match(worker, /detachAllOwnedPreservingState/u);
	assert.doesNotMatch(worker.match(/async function resetAfterOperationTimeout[\s\S]*?\n\}/u)?.[0] ?? "", /tabsByName\.clear|chrome\.tabs\.remove/u, "单次 operation timeout 不得删除 owned tab");
	assert.match(worker, /boundedInteractionReadback/u, "交互后正文回读必须有独立短 deadline");
	assert.match(worker, /collectPageAlerts\.toString\(\)/u, "页面提示只允许扩展内置的固定函数，不接受模型提供 JavaScript");
	assert.match(worker, /readInteractionTargetState\.toString\(\)/u, "目标状态读取只允许扩展内置的固定函数");
	assert.match(worker, /scopedEvaluations\(item, `\(\$\{collectPageAlerts\.toString\(\)\}\)\(\)`, PAGE_ALERT_WAIT_MS, assertOperation\)/u, "页面提示收集必须有独立短 deadline");
	assert.match(worker, /const alerts = pageAlertNodes\(item\.documentGeneration, alertSources, MAX_PAGE_ALERTS\);[\s\S]*?\[\.\.\.alerts\.nodes, \.\.\.text\.nodes\]/u, "校验错误必须排在有界正文之前，不能被截断掉");
	assert.match(worker, /const stateObjectId = target\.action === "scroll" \? undefined : await interactionTargetObjectId\(target, assertOperation\)/u, "写动作必须在派发前解析目标对象，不能事后重新查找");
	assert.match(worker, /interaction expect requires a targetRef click, type, select, or keypress/u, "坐标点击与整页滚动不得声称目标级期望已满足");
	assert.match(worker, /await attach\(item, assertOperation\);[\s\S]*?const target = await interactionTarget/u, "timeout detach 后必须先重新 attach 再解析交互目标");
	assert.match(worker, /item\.attached === true && item\.detached !== true && target\.attached === true/u, "缓存 attached 状态不得绕过 Chrome 实际 debugger 状态核验");
	const recoverBlock = worker.match(/if \(operation === "recover"\) \{[\s\S]*?\n\t\}/u)?.[0] ?? "";
	assert.match(recoverBlock, /const \{ name, item \} = owned\(state, payload\.tabName\)[\s\S]*?await attach\(item, assertOperation\)/u, "recover 必须只对原标签原地重新 attach");
	assert.match(recoverBlock, /tabs: \[target\]/u, "recover 只能回读目标标签");
	assert.doesNotMatch(recoverBlock, /handleOperation\(state, "tabs"/u, "recover 不得进入会清理其他标签的全局 tabs 路径");
	assert.match(worker, /browser recover failed for tab/u, "recover attach 失败必须显式报错，不能伪装成成功 tabs");
	assert.match(worker, /resetAfterOperationTimeout\(state, operation, targetItem\)[\s\S]*?detachItemsPreservingState\(\[targetItem\]\)/u, "interaction/recover timeout 只能 detach 原标签");
	assert.match(worker, /parsed === undefined \? undefined : observedInteractionNode\(item\.lastObservationNodes, parsed\.ref\)/u, "带 targetRef 的 scroll 必须拒绝最新 observation 中不存在的 stale ref");
	assert.match(worker, /const node = observedInteractionNode\(item\.lastObservationNodes, parsed\.ref\)/u, "非 scroll 交互必须拒绝最新 observation 中不存在的 stale ref");
	assert.match(worker, /createOperationGuard\(state, expectedEpoch\)[\s\S]*?operationGuard\.invalidate\(\)/u, "timeout 后必须用 operation revision 阻止迟到操作继续执行");
	assert.match(worker, /async function waitForTab\(name, item, payload, assertSession\)[\s\S]*?for \(;;\) \{[\s\S]*?assertSession\(\)/u, "长 wait 必须周期检查 session epoch，使 disconnect cleanup 和 reconnect 快速解除阻塞");
	assert.match(worker, /const result = await observation\(name, item, assertSession\);[\s\S]*?assertSession\(\);[\s\S]*?return result/u, "wait 匹配后 observation 完成时必须再次检查 session，不能让断线后的 stale observation 阻塞 cleanup");
	assert.match(tabListStatus, /\brelayAttached,/u, "tabs 必须暴露 relay 实际连接状态");
	assert.match(worker, /valueWithinRelayDeadline\(dispatchPromise, SCROLL_DISPATCH_WAIT_MS\)/u, "滚轮派发不得无限等待页面主线程");
	assert.match(worker, /DOM\.getDocument[\s\S]*?SCROLL_TARGET_WAIT_MS/u, "无 targetRef 的滚动准备不得无限等待 DOM");
	assert.match(worker, /Runtime\.callFunctionOn[\s\S]*?SCROLL_TARGET_WAIT_MS/u, "最近滚动容器解析不得无限等待页面脚本");
	assert.match(worker, /dispatchPoint\(target\.debuggee, target\.parsed\?\.backendNodeId, SCROLL_TARGET_WAIT_MS, target\.parsed !== undefined, target\.parsed !== undefined, assertOperation\)/u, "有锚点的滚动必须自动 reveal、使用短 deadline 且禁止中心点降级");
	assert.match(worker, /DOM\.scrollIntoViewIfNeeded[\s\S]*?CLICK_REVEAL_WAIT_MS/u, "视口外的点击目标必须先通过后台 CDP 滚入可见区域");
	assert.match(worker, /dispatchPoint\(target\.debuggee, target\.parsed\.backendNodeId, CLICK_TARGET_WAIT_MS, true, true, assertOperation\)/u, "click 几何查询必须有短 deadline、自动 reveal 且禁止中心点降级");
	assert.match(worker, /async function withFocusEmulation[\s\S]*?enabled: true[\s\S]*?finally[\s\S]*?enabled: false/u, "后台 CDP Input 必须临时模拟 focus，且派发后恢复");
	assert.match(worker, /if \(target\.action === "click"\)[\s\S]*?withFocusEmulation\(target\.debuggee/u, "后台 click 必须使用 focus emulation");
	assert.match(worker, /const wheel = await withFocusEmulation\(target\.debuggee/u, "后台 scroll 必须使用 focus emulation");
	assert.doesNotMatch(worker, /Page\.bringToFront/u, "后台 click 不得通过 CDP 抢占窗口前台");
	assert.match(worker, /if \(dispatchError\) throw dispatchError/u, "滚轮命令的即时 CDP 错误不能伪装成已派发");
	assert.match(worker, /dispatchSettled: dispatched\.ok/u);
	assert.doesNotMatch(worker.match(/async function interactionTarget[\s\S]*?\n\}/u)?.[0] ?? "", /await observation\(/u, "interaction 前不得再次全量扫描页面");
	assert.match(worker, /"direct-interaction"/u);
	assert.match(worker, /"cdp-mouse"/u);
	assert.match(worker, /"targeted-scroll"/u);
	assert.match(worker, /operation === "interact"/u);
	assert.match(worker, /operation === "read_full"/u);
	for (const eventType of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]) assert.match(worker, new RegExp(`type: "${eventType}"`, "u"));
	assert.match(worker, /DOM\.getNodeForLocation/u, "坐标 fallback 必须在 CDP mouse dispatch 前执行 DOM hit-test");
	assert.match(worker, /coordinate screenshot observation epoch is stale|validateCoordinateBinding/u, "坐标 fallback 必须绑定最新 screenshot epoch");
	assert.doesNotMatch(worker, /assertBackgroundOwned|chrome\.tabs\.onActivated|inputType === "password"|one-time-code|popupAttempted|interaction popup was blocked/u);
	assert.match(worker, /closeOwnedIdentity\(state, name, tab\.id, item, assertOperation\)/u);
	const tabsBlock = worker.match(/if \(operation === "tabs"\) \{[\s\S]*?return \{ schemaVersion: 1, kind: "rotom-browser-tabs", tabs \};\n\t\}/u)?.[0] ?? "";
	assert.match(tabsBlock, /collectListedOwnedTabs/u, "tabs 必须通过可故障注入的非破坏 collector 降级状态");
	assert.doesNotMatch(tabsBlock, /closeOwned|chrome\.tabs\.remove/u, "tabs 健康检查不得关闭标签或删除 ownership");
	const restoreBlock = worker.match(/async function restoreState\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(restoreBlock, /try \{[\s\S]*?chrome\.debugger\.getTargets\(\)[\s\S]*?catch/u, "restore target 发现失败必须保留缓存 ownership");
	assert.match(restoreBlock, /isMissingChromeTabError\(error\)/u, "restore 只能在 Chrome 明确确认 tab 不存在时丢弃登记");
	assert.doesNotMatch(restoreBlock, /!target[^\n]*continue/u, "restore target 暂缺不得删除 ownership");
	assert.match(worker, /operationChain: Promise\.resolve\(\)/u);
	assert.match(worker, /state\.operationChain = state\.operationChain\.then\(\(\) => handleRequest\(message, state\)\)/u, "不同 relay session 必须使用独立 operation chain，不能被全局长任务阻塞");
	assert.match(worker, /function queueRelaySessionCleanup\(sessionId, generation\)[\s\S]*?state\.epoch \+= 1;[\s\S]*?state\.operationChain = state\.operationChain\.then/u, "client disconnect 只失效对应 session，并与其 replacement hello 共用 session chain");
	assert.match(worker, /persistChain = persistChain\.catch\(\(\) => undefined\)\.then/u, "并发 session 的 storage snapshot 必须串行落盘");
	assert.match(worker, /tabReservations\.has\(payload\.tabId\)[\s\S]*?tabReservations\.add\(payload\.tabId\)[\s\S]*?finally \{ tabReservations\.delete\(payload\.tabId\); \}/u, "并发 claim 必须全局原子保留 tab identity");
	assert.match(worker, /message\.operation === "client-disconnected"[\s\S]*?queueRelaySessionCleanup\(message\.sessionId, message\.generation\)/u);
	assert.match(worker, /nativePort\.onDisconnect\.addListener[\s\S]*?queueAllRelaySessionCleanup\(\)[\s\S]*?scheduleReconnect\(\)/u);
	assert.match(worker, /withBackgroundActivationGuard\(item/u);
	assert.match(worker, /chrome\.tabs\.update\(activeBefore\.id, \{ active: true \}\)/u, "click 创建新标签后必须恢复原活动标签");
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

test("坐标点击绑定 screenshot epoch、文档 generation、viewport 与非歧义 hit target", () => {
	const item = { documentGeneration: 4 };
	const metrics = { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 120, scale: 1 } };
	const minted = mintCoordinateObservation(item, metrics);
	assert.equal(minted.observationEpoch, 1);
	assert.deepEqual(validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, metrics), { x: 640, y: 400, viewport: { width: 1280, height: 800, pageX: 0, pageY: 120, scale: 1 } });
	assert.deepEqual(validateCoordinateHit({ backendNodeId: 91, nodeName: "CANVAS" }), { backendNodeId: 91, nodeName: "canvas" });
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 0, documentGeneration: 4, x: 640, y: 400 }, metrics), /epoch is stale/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 5, x: 640, y: 400 }, metrics), /generation is stale/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, { cssVisualViewport: { ...metrics.cssVisualViewport, pageY: 121 } }), /viewport changed/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 0, y: 400 }, metrics), /outside/u);
	assert.throws(() => validateCoordinateHit({ backendNodeId: 92, nodeName: "BODY" }), /ambiguous/u);
	invalidateCoordinateObservation(item);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, metrics), /current browser screenshot/u);
});

test("同一窗口的 agent 标签收敛到唯一 Pi 分组，且不移动 claimed、固定或其他窗口标签", async () => {
	const items = [
		{ tabId: 11, ownership: "agent" },
		{ tabId: 12, ownership: "agent" },
		{ tabId: 13, ownership: "agent" },
		{ tabId: 14, ownership: "claimed" },
		{ tabId: 15, ownership: "agent" },
	];
	const tabs = [
		{ id: 14, windowId: 7 },
		{ id: 12, windowId: 7 },
		{ id: 13, windowId: 8 },
		{ id: 15, windowId: 7, pinned: true },
		{ id: 11, windowId: 7 },
	];
	assert.deepEqual(agentOwnedTabIdsInWindow(items, tabs, 7), [11, 12]);
	const calls = [];
	const result = await placeAgentTabsInSharedGroup({
		createdTab: { id: 12, windowId: 7 },
		items,
		queryTabs: async (query) => { calls.push(["query", query]); return tabs; },
		groupTabs: async (options) => { calls.push(["group", options]); return 91; },
		updateGroup: async (groupId, options) => { calls.push(["update", groupId, options]); },
	});
	assert.deepEqual(result, { groupId: 91, tabIds: [11, 12] });
	assert.deepEqual(calls, [
		["query", { windowId: 7 }],
		["group", { tabIds: [11, 12] }],
		["update", 91, { title: "Pi", color: "blue", collapsed: false }],
	]);
	await assert.rejects(() => placeAgentTabsInSharedGroup({
		createdTab: { id: 99, windowId: 7 },
		items,
		queryTabs: async () => tabs,
		groupTabs: async () => 92,
		updateGroup: async () => undefined,
	}), /created tab unavailable for grouping/u);
});

test("tabs target 暂缺时保留标签 identity 并返回 detached 状态", () => {
	const item = { tabId: 41, documentGeneration: 3, url: "https://example.test/before", status: "complete", ownership: "agent", attached: true, detached: false };
	const missing = listedOwnedTabStatus({ name: "docs", item, tab: { id: 41, status: "complete", active: false }, targetUrl: undefined, targetAttached: false, currentTabName: "docs" });
	assert.deepEqual(missing.state, { url: "https://example.test/before", status: "complete", attached: false, detached: true });
	assert.deepEqual(missing.value, { name: "docs", tabId: 41, documentGeneration: 3, url: "https://example.test/before", title: "", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: false });
	const recovered = listedOwnedTabStatus({ name: "docs", item: { ...item, ...missing.state }, tab: { id: 41, status: "complete", active: true }, targetUrl: "https://example.test/after", targetAttached: true, currentTabName: "docs" });
	assert.equal(recovered.value.relayAttached, false, "target 回来后仍需显式 recover/attach，不能伪造 relayAttached");
	assert.deepEqual(recovered.state, { url: "https://example.test/after", status: "complete", attached: false, detached: true });
	const healthy = listedOwnedTabStatus({ name: "docs", item, tab: { id: 41, status: "complete", active: false }, targetUrl: "https://example.test/healthy", targetAttached: true, currentTabName: "docs" });
	assert.equal(healthy.value.relayAttached, true);
	assert.deepEqual(healthy.state, { url: "https://example.test/healthy", status: "complete", attached: true, detached: false });
});

test("tabs Chrome API 失败时仍返回缓存 identity 并保留 ownership", async () => {
	const item = { tabId: 42, targetId: "target-42", documentGeneration: 2, url: "https://example.test/cached", status: "complete", ownership: "claimed", attached: true, detached: false };
	const entries = new Map([["cached", item]]);
	let detached = 0;
	const tabs = await collectListedOwnedTabs({
		entries,
		currentTabName: "cached",
		getTargets: async () => { throw new Error("temporary debugger failure"); },
		getTab: async () => { throw new Error("Tabs cannot be queried right now"); },
		normalizeUrl: (url) => url,
		onDetached: () => { detached += 1; },
	});
	assert.equal(entries.get("cached"), item, "health check 不得删除 ownership");
	assert.deepEqual(item, { tabId: 42, targetId: "target-42", documentGeneration: 2, url: "https://example.test/cached", status: "complete", ownership: "claimed", attached: false, detached: true });
	assert.deepEqual(tabs, [{ name: "cached", tabId: 42, documentGeneration: 2, url: "https://example.test/cached", title: "", status: "complete", current: true, browserActive: false, ownership: "claimed", relayAttached: false }]);
	assert.equal(detached, 1);
	const tabFailureOnlyItem = { tabId: 43, targetId: "target-43", documentGeneration: 1, url: "https://example.test/tab-failure", status: "complete", ownership: "agent", attached: true, detached: false };
	const tabFailureOnly = await collectListedOwnedTabs({
		entries: new Map([["tab-failure", tabFailureOnlyItem]]),
		currentTabName: "tab-failure",
		getTargets: async () => [{ tabId: 43, id: "target-43", type: "page", url: "https://example.test/tab-failure", attached: true }],
		getTab: async () => { throw new Error("temporary tabs.get failure"); },
		normalizeUrl: (url) => url,
	});
	assert.equal(tabFailureOnly[0].relayAttached, false, "tabs.get 失败不得被健康 target 覆盖为 attached");
	assert.equal(tabFailureOnlyItem.attached, false);
	assert.equal(tabFailureOnlyItem.detached, true);
	assert.equal(isMissingChromeTabError(new Error("No tab with id: 42.")), true);
	assert.equal(isMissingChromeTabError(new Error("Tabs cannot be queried right now")), false);
});

test("windowOpen signal 只关联 URL 匹配的新标签且单次消费", () => {
	const signals = [{ timestamp: 1_000, url: "https://example.test/popup?x=1", used: false }];
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 1, url: "https://unrelated.test/" }, 1_100, 2_000), false);
	assert.equal(signals[0].used, false, "无关 session/用户标签不得消费 source-tab popup signal");
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 2, pendingUrl: "https://example.test/popup?x=1" }, 1_200, 2_000), true);
	assert.equal(signals[0].used, true);
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 3, url: "https://example.test/popup?x=1" }, 1_300, 2_000), false, "signal 只能关联一个 created tab");
	assert.equal(consumeMatchingWindowOpenSignal([{ timestamp: 1_000, url: "https://example.test/late", used: false }], { url: "https://example.test/late" }, 4_000, 2_000), false, "过期 signal 不得关联后续无关标签");
});

test("AX ref 保持根页面兼容并绑定 OOPIF scope", () => {
	assert.equal(formatScopedAxRef(3, "r", 42), "ax_3_42");
	assert.equal(formatScopedAxRef(3, "f2", 42), "ax_3_f2_42");
	assert.deepEqual(parseScopedAxRef("ax_3_42", 3), { ref: "ax_3_42", scopeId: "r", backendNodeId: 42 });
	assert.deepEqual(parseScopedAxRef("ax_3_f2_42", 3), { ref: "ax_3_f2_42", scopeId: "f2", backendNodeId: 42 });
	assert.equal(parseScopedAxRef("ax_2_f2_42", 3), undefined);
	assert.equal(parseScopedAxRef("ax_3_f0_42", 3), undefined);
});

test("固定正文提取覆盖同源 iframe，并以 UTF-8 安全分块", () => {
	const child = { document: { body: { innerText: "正文第二段" } }, frames: [] };
	const blocked = {};
	Object.defineProperty(blocked, "document", { get() { throw new Error("cross origin"); } });
	const rootWindow = { document: { body: { innerText: "Wiki 导航\n\n\n正文第一段" } }, frames: [child, blocked] };
	assert.equal(collectRenderedText(rootWindow), "Wiki 导航\n\n正文第一段\n\n正文第二段");
	const complete = utf8TextChunks("示例正文".repeat(30), 48, 20);
	assert.equal(complete.truncated, false);
	assert.equal(complete.chunks.join(""), "示例正文".repeat(30));
	assert.equal(complete.chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 48), true);
	const truncated = utf8TextChunks("正文".repeat(100), 12, 2);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.chunks.length, 2);
});

test("全文分段按相邻重叠合并且不会把容量完整误报成页面完整", () => {
	const first = mergeRenderedText("标题\n第一段\n第二段", "第二段\n第三段\n第四段", 10_000);
	assert.equal(first.text, "标题\n第一段\n第二段\n第三段\n第四段");
	assert.equal(first.addedLines, 2);
	const duplicate = mergeRenderedText(first.text, "第一段\n第二段", 10_000);
	assert.equal(duplicate.text, first.text);
	assert.equal(duplicate.addedLines, 0);
	assert.equal(mergeRenderedText("a", "b".repeat(20), 8).truncated, true);
});

test("全文读取沿采样点和同源 iframe 寻找滚动容器，不遍历页面全量 DOM", () => {
	const root = { clientHeight: 800, clientWidth: 1200, scrollHeight: 800, innerText: "root", parentElement: null, getBoundingClientRect: () => ({ width: 1200, height: 800, bottom: 800, right: 1200 }) };
	const content = { clientHeight: 700, clientWidth: 900, scrollHeight: 4_200, innerText: "正文".repeat(500), parentElement: root, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 760, right: 1_150 }) };
	const leaf = { clientHeight: 20, clientWidth: 200, scrollHeight: 20, innerText: "段落", parentElement: content, getBoundingClientRect: () => ({ width: 200, height: 20, bottom: 400, right: 800 }) };
	const fakeDocument = {
		scrollingElement: root,
		defaultView: { innerWidth: 1_200, innerHeight: 800, getComputedStyle: (element) => ({ overflowY: element === content ? "auto" : "visible" }) },
		elementsFromPoint: () => [leaf],
		querySelectorAll() { throw new Error("full DOM traversal denied"); },
	};
	root.ownerDocument = fakeDocument; content.ownerDocument = fakeDocument; leaf.ownerDocument = fakeDocument;
	assert.equal(scrollableTextTargets(fakeDocument, 3)[0], content);

	const frameRoot = { clientHeight: 700, clientWidth: 900, scrollHeight: 700, innerText: "frame", parentElement: null, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 700, right: 900 }) };
	const frameContent = { clientHeight: 600, clientWidth: 800, scrollHeight: 5_000, innerText: "第四章正文".repeat(800), parentElement: frameRoot, getBoundingClientRect: () => ({ width: 800, height: 600, bottom: 650, right: 850 }) };
	const frameLeaf = { clientHeight: 20, clientWidth: 200, scrollHeight: 20, innerText: "详细需求", parentElement: frameContent, getBoundingClientRect: () => ({ width: 200, height: 20, bottom: 300, right: 700 }) };
	const frameDocument = {
		scrollingElement: frameRoot,
		defaultView: { innerWidth: 900, innerHeight: 700, getComputedStyle: (element) => ({ overflowY: element === frameContent ? "auto" : "visible" }) },
		elementsFromPoint: () => [frameLeaf],
		querySelectorAll: () => [],
	};
	frameRoot.ownerDocument = frameDocument; frameContent.ownerDocument = frameDocument; frameLeaf.ownerDocument = frameDocument;
	const iframe = { tagName: "IFRAME", contentDocument: frameDocument, clientHeight: 700, clientWidth: 900, scrollHeight: 700, innerText: "", parentElement: root, ownerDocument: fakeDocument, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 700, right: 1_100 }) };
	fakeDocument.elementsFromPoint = () => [iframe];
	fakeDocument.querySelectorAll = (selector) => selector === "iframe,frame" ? [iframe] : [];
	assert.equal(scrollableTextTargets(fakeDocument, 6)[0], frameContent, "同源 iframe 内的虚拟化正文容器必须优先于外层空壳");
});

test("扩展 operation deadline 先于客户端超时并覆盖长 wait", () => {
	assert.equal(relayOperationDeadlineMs("hello", {}), 2_000);
	assert.equal(relayOperationDeadlineMs("tabs", {}), 4_000);
	assert.equal(relayOperationDeadlineMs("snapshot", {}), 20_000);
	assert.equal(relayOperationDeadlineMs("interact", {}), 6_000);
	assert.equal(relayOperationDeadlineMs("recover", {}), 8_000);
	assert.equal(relayOperationDeadlineMs("read_full", {}), 25_000);
	assert.equal(relayOperationDeadlineMs("wait", { timeoutMs: 12_000 }), 12_500);
});

test("扩展 operation deadline 会等待清理完成后释放串行队列", async () => {
	let cleanupFinished = false;
	const never = new Promise(() => undefined);
	await assert.rejects(runWithRelayDeadline("snapshot", never, async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		cleanupFinished = true;
	}, 10), /browser relay snapshot operation timeout/u);
	assert.equal(cleanupFinished, true);
});

test("交互 ref 必须存在于最新 observation", () => {
	const node = { ref: "ax_3_42", role: "button", name: "Close" };
	assert.equal(observedInteractionNode([node], "ax_3_42"), node);
	assert.throws(() => observedInteractionNode([node], "ax_3_9371"), /stale or unavailable.*snapshot_visible/u);
	assert.throws(() => observedInteractionNode(undefined, "ax_3_42"), /stale or unavailable/u);
});

test("目标状态只读布尔与长度，且将未知与未变分开", () => {
	const element = (overrides = {}) => ({ isConnected: true, checked: false, disabled: false, value: "", validationMessage: "", ownerDocument: { activeElement: undefined }, getAttribute: (name) => (name === "aria-expanded" ? "false" : null), ...overrides });
	const before = readInteractionTargetState.call(element());
	assert.deepEqual(before, { connected: true, checked: false, expanded: false, disabled: false, focused: false, valueLength: 0, valid: true });
	const after = readInteractionTargetState.call(element({ checked: true, value: "hunter2", validationMessage: "请填写密码", getAttribute: (name) => (name === "aria-expanded" ? "true" : null) }));
	assert.equal(JSON.stringify(after).includes("hunter2"), false, "目标状态不得回传输入内容");
	assert.equal(JSON.stringify(after).includes("请填写密码"), false, "校验文案只能走 readback 节点的脱敏路径");
	assert.deepEqual(interactionTargetChange(before, after), { changed: true, transitions: ["checked=false→true", "expanded=false→true", "valueLength=0→7", "valid=true→false"] });
	assert.deepEqual(interactionTargetChange(before, undefined), { changed: null, transitions: [] }, "读不到状态是 unknown，不是未变");
	assert.deepEqual(interactionTargetChange(before, { ...before, focused: true }), { changed: false, transitions: ["focused=false→true"] }, "点击自带的聚焦是机械后果，不能当成页面反应");
	const removed = readInteractionTargetState.call(element({ isConnected: false }));
	assert.deepEqual(interactionTargetChange(before, removed), { changed: true, transitions: ["connected=true→false"] });
	assert.deepEqual(readInteractionTargetState.call({ isConnected: true, getAttribute: () => { throw new Error("detached"); } }), { connected: true }, "getter 抛错的字段必须缺省为未知");
});

test("expect 只接受固定判据，并保留 met/unmet/unknown 三态", () => {
	assert.equal(parseInteractionExpectation(undefined), undefined);
	assert.deepEqual(parseInteractionExpectation("checked=true"), { requested: "checked=true", field: "checked", operator: "true" });
	assert.deepEqual(parseInteractionExpectation("value=nonempty"), { requested: "value=nonempty", field: "valueLength", operator: "nonempty" });
	for (const invalid of ["", "checked", "checked=maybe", "value=12", "innerText=hi", "document.title", "x".repeat(33)]) assert.throws(() => parseInteractionExpectation(invalid), /interaction expect must be/u);
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), { checked: true }), { requested: "checked=true", outcome: "met" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), { checked: false }), { requested: "checked=true", outcome: "unmet" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), {}), { requested: "checked=true", outcome: "unknown" }, "目标不报该字段时不能压成 unmet");
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("checked=true"), undefined), { requested: "checked=true", outcome: "unknown" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("value=nonempty"), { valueLength: 11 }), { requested: "value=nonempty", outcome: "met" });
	assert.deepEqual(evaluateInteractionExpectation(parseInteractionExpectation("value=empty"), { valueLength: 11 }), { requested: "value=empty", outcome: "unmet" });
	assert.equal(evaluateInteractionExpectation(undefined, { checked: true }), undefined);
});

test("页面提示收集只读、有界，且覆盖原生校验消息", () => {
	let validityChecks = 0;
	const node = (overrides) => ({ getClientRects: () => [{}], getAttribute: () => null, ...overrides });
	const control = node({ willValidate: true, validity: { valid: false }, validationMessage: "请填写 11 位手机号", checkValidity: () => { validityChecks += 1; return false; } });
	const alerts = collectPageAlerts({
		document: {
			querySelectorAll: (selector) => (selector.includes("role=\"alert\"") ? [node({ innerText: "  提交失败\n请稍后重试  " }), node({ innerText: "提交失败 请稍后重试" }), node({ getClientRects: () => [], innerText: "隐藏提示" })] : [control]),
			getElementById: () => undefined,
		},
		frames: { length: 0 },
	});
	assert.deepEqual(alerts, ["提交失败 请稍后重试", "请填写 11 位手机号"]);
	assert.equal(validityChecks, 0, "不得调用 checkValidity：它会在被观察页面上派发 invalid 事件");
	const built = pageAlertNodes(3, [{ scopeId: "r", alerts: ["A", "A", "B"] }, { scopeId: "f2", alerts: ["C"] }, { scopeId: "bogus", alerts: ["D"] }]);
	assert.deepEqual(built.nodes.map((entry) => [entry.ref, entry.role, entry.name, entry.states]), [["alert_3_r_1", "page-alert", "A", ["read-only=true"]], ["alert_3_r_2", "page-alert", "B", ["read-only=true"]], ["alert_3_f2_3", "page-alert", "C", ["read-only=true"]]]);
	assert.equal(built.truncated, false);
	const overflow = pageAlertNodes(1, [{ scopeId: "r", alerts: Array.from({ length: 12 }, (_, index) => `alert ${index}`) }]);
	assert.deepEqual([overflow.nodes.length, overflow.truncated], [8, true]);
	assert.throws(() => pageAlertNodes(0, []), /generation invalid/u);
});

test("operation guard 在 timeout 后阻止迟到操作", () => {
	const state = { operationRevision: 4, epoch: 2, generation: "generation" };
	const guard = createOperationGuard(state, 2);
	guard.assert();
	guard.invalidate();
	assert.equal(state.operationRevision, 5);
	assert.throws(() => guard.assert(), /operation invalidated/u);
	guard.invalidate();
	assert.equal(state.operationRevision, 5, "重复 invalidation 不能误伤下一 operation");
});

test("child CDP pending 被短路且不会阻塞根页面结果", async () => {
	const never = new Promise(() => undefined);
	assert.deepEqual(await valueWithinRelayDeadline(Promise.resolve("root"), 10), { ok: true, value: "root" });
	assert.deepEqual(await valueWithinRelayDeadline(Promise.reject(new Error("detached")), 10), { ok: false });
	assert.deepEqual(await valueWithinRelayDeadline(never, 10), { ok: false });
});

test("scroll target 优先选择 anchor 最近的纵向滚动祖先并保留 document fallback", () => {
	const documentScroller = { nodeType: 1, scrollHeight: 2_000, clientHeight: 800 };
	const document = {
		nodeType: 9,
		scrollingElement: documentScroller,
		documentElement: documentScroller,
		defaultView: { getComputedStyle: (element) => ({ overflowY: element.overflowY ?? "visible" }) },
	};
	const nestedScroller = { nodeType: 1, ownerDocument: document, parentElement: null, overflowY: "auto", scrollHeight: 900, clientHeight: 200 };
	const row = { nodeType: 1, ownerDocument: document, parentElement: nestedScroller, overflowY: "visible", scrollHeight: 40, clientHeight: 40 };
	assert.equal(interactionScrollTarget.call(row), nestedScroller);
	nestedScroller.scrollHeight = 200;
	assert.equal(interactionScrollTarget.call(row), documentScroller, "不可滚动的 auto 容器必须回退 document");
	nestedScroller.scrollHeight = 900;
	nestedScroller.overflowY = "hidden";
	assert.equal(interactionScrollTarget.call(row), documentScroller, "hidden 容器不能冒充用户可滚动区域");
	assert.equal(interactionScrollTarget.call(document), documentScroller);

	const frameScroller = { nodeType: 1, overflowY: "auto", scrollHeight: 1_200, clientHeight: 300, parentElement: null };
	const frameRow = { nodeType: 1, parentElement: frameScroller };
	const frameDocument = {
		nodeType: 9,
		body: frameRow,
		defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: (element) => ({ overflowY: element.overflowY ?? "visible" }) },
		elementFromPoint: () => frameRow,
	};
	frameScroller.ownerDocument = frameDocument;
	frameRow.ownerDocument = frameDocument;
	const iframe = { nodeType: 1, ownerDocument: document, contentDocument: frameDocument };
	document.defaultView.innerWidth = 1_200;
	document.defaultView.innerHeight = 900;
	document.elementFromPoint = () => iframe;
	assert.equal(interactionScrollTarget.call(document), frameScroller, "无 targetRef 时必须下钻鼠标中心命中的同源 iframe 滚动容器");

	const shadowScroller = { nodeType: 1, ownerDocument: document, parentElement: null, overflowY: "scroll", scrollHeight: 600, clientHeight: 100 };
	const shadowRoot = { host: shadowScroller };
	const shadowRow = { nodeType: 1, ownerDocument: document, parentElement: null, getRootNode: () => shadowRoot };
	assert.equal(interactionScrollTarget.call(shadowRow), shadowScroller);
});

test("installer 固定组件存储与 exact 注册，status 校验内容且 uninstall 不跟随 symlink", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pi-browser-installer-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, "Library", "Application Support"), { recursive: true });
	const run = (operation) => spawnSync(process.execPath, [installer, operation], { cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: "utf8" });
	const installed = run("install");
	assert.equal(installed.status, 0, installed.stderr);
	const details = JSON.parse(installed.stdout);
	assert.equal(details.extensionId, extensionId);
	assert.match(details.extensionDir, /\/components\/[a-f0-9]{64}\/chrome-extension$/u);
	assert.notEqual(details.extensionDir, extensionDir);
	assert.equal(await readFile(join(details.extensionDir, "service-worker.js"), "utf8"), await readFile(join(extensionDir, "service-worker.js"), "utf8"));
	const manifestInfo = await lstat(details.nativeHostManifest);
	assert.equal(manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.nlink === 1, true);
	assert.equal(manifestInfo.mode & 0o077, 0);
	const nativeManifest = JSON.parse(await readFile(details.nativeHostManifest, "utf8"));
	assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
	assert.equal(nativeManifest.name, "dev.rotom.browser_relay");
	assert.equal(nativeManifest.type, "stdio");
	assert.match(await readFile(nativeManifest.path, "utf8"), /^#!\/bin\/sh\nexec '/u);
	assert.equal(JSON.parse(run("status").stdout).installed, true);
	await writeFile(nativeManifest.path, "tampered\n", { mode: 0o700 });
	assert.equal(JSON.parse(run("status").stdout).installed, false);
	assert.equal(run("install").status, 0, "installer 应可原子修复普通文件内容漂移");
	assert.equal(run("uninstall").status, 0);
	assert.equal(JSON.parse(run("status").stdout).installed, false);
	assert.equal((await lstat(details.extensionDir)).isDirectory(), true, "uninstall 必须保留可能仍在使用的组件");
	await mkdir(join(home, "outside"));
	const outside = join(home, "outside", "sentinel");
	await writeFile(outside, "keep", { mode: 0o600 });
	await mkdir(join(home, "Library", "Application Support", "rotom", "browser-relay"), { recursive: true, mode: 0o700 });
	const launcher = join(home, "Library", "Application Support", "rotom", "browser-relay", "native-host-launcher.sh");
	await import("node:fs/promises").then(({ symlink }) => symlink(outside, launcher));
	const rejected = run("uninstall");
	assert.notEqual(rejected.status, 0);
	assert.equal(await readFile(outside, "utf8"), "keep");
});

test("Native host 并行 multiplex 多个 Pi client、按 binding 路由响应并隔离断线 cleanup", async (t) => {
	const home = await mkdtemp("/private/tmp/pibr-multiplex-");
	t.after(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, "Library", "Application Support"), { recursive: true });
	const child = spawn(process.execPath, [join(root, "native-host.mjs")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_048); });
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	const socketPath = join(home, "Library", "Application Support", "rotom", "browser-relay", "relay.sock");
	let ready = false;
	for (let attempt = 0; attempt < 1_500; attempt += 1) {
		try { if ((await lstat(socketPath)).isSocket()) { ready = true; break; } }
		catch (error) { if (error?.code !== "ENOENT") throw error; }
		if (child.exitCode !== null) break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	if (!ready && child.exitCode === 70) { t.skip("sandbox 禁止 Native host Unix socket listen"); return; }
	assert.equal(ready, true, `native host exit=${child.exitCode} stderr=${stderr}`);

	const withTimeout = (promise, label, timeoutMs = 1_000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs))]);
	const nativeQueue = []; const nativeWaiters = []; let nativeBuffer = Buffer.alloc(0);
	child.stdout.on("data", (chunk) => {
		nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
		while (nativeBuffer.length >= 4) {
			const size = nativeBuffer.readUInt32LE(0); if (nativeBuffer.length < size + 4) break;
			const message = JSON.parse(nativeBuffer.subarray(4, size + 4).toString("utf8")); nativeBuffer = nativeBuffer.subarray(size + 4);
			const waiter = nativeWaiters.shift(); if (waiter) waiter(message); else nativeQueue.push(message);
		}
	});
	const nextNative = () => nativeQueue.length ? Promise.resolve(nativeQueue.shift()) : new Promise((resolveMessage) => nativeWaiters.push(resolveMessage));
	const sendNativeResponse = (request, result) => {
		const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "response", id: request.id, sessionId: request.sessionId, generation: request.generation, ok: true, result }), "utf8");
		const header = Buffer.alloc(4); header.writeUInt32LE(payload.length, 0); child.stdin.write(Buffer.concat([header, payload]));
	};
	const connectClient = async () => {
		const socket = createConnection(socketPath); await new Promise((resolveConnected, reject) => { socket.once("connect", resolveConnected); socket.once("error", reject); });
		const queue = []; const waiters = []; let buffer = ""; socket.setEncoding("utf8");
		socket.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); } });
		return { socket, send: (message) => socket.write(`${JSON.stringify(message)}\n`), next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolveMessage) => waiters.push(resolveMessage)) };
	};
	const request = (id, sessionId, operation) => ({ schemaVersion: 1, kind: "request", id, sessionId, generation: `generation-${sessionId}`, operation, payload: operation === "hello" ? { nonce: `nonce-${sessionId}` } : {} });
	const readyResult = (sessionId) => ({ schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 14, nonce: `nonce-${sessionId}`, capabilities: ["virtualized-frame-scroll", "multi-client-multiplex"] });

	const first = await connectClient(); const second = await connectClient();
	first.send(request("hello-1", "one", "hello")); second.send(request("hello-2", "two", "hello"));
	const firstHello = await withTimeout(nextNative(), "first native hello");
	const secondHello = await withTimeout(nextNative(), "second native hello");
	sendNativeResponse(firstHello, readyResult(firstHello.sessionId)); sendNativeResponse(secondHello, readyResult(secondHello.sessionId));
	assert.equal((await withTimeout(first.next(), "first hello response")).ok, true);
	assert.equal((await withTimeout(second.next(), "second hello response")).ok, true);

	const probe = await connectClient(); probe.socket.destroy();
	first.send(request("tabs-1", "one", "tabs")); second.send(request("snapshot-2", "two", "snapshot"));
	const firstRequest = await withTimeout(nextNative(), "first parallel request");
	const secondRequest = await withTimeout(nextNative(), "second parallel request");
	sendNativeResponse(secondRequest, { marker: "two" }); sendNativeResponse(firstRequest, { marker: "one" });
	assert.equal((await withTimeout(second.next(), "second routed response")).result.marker, "two");
	assert.equal((await withTimeout(first.next(), "first routed response")).result.marker, "one");

	second.send(request("wait-2", "two", "wait"));
	const orphanedRequest = await withTimeout(nextNative(), "orphaned native request");
	const secondClosed = new Promise((resolveClosed) => second.socket.once("close", resolveClosed));
	second.socket.destroy(); await withTimeout(secondClosed, "second client close");
	const disconnectControl = await withTimeout(nextNative(), "session-scoped disconnect control");
	assert.deepEqual({ kind: disconnectControl.kind, operation: disconnectControl.operation, sessionId: disconnectControl.sessionId, generation: disconnectControl.generation }, { kind: "control", operation: "client-disconnected", sessionId: "two", generation: "generation-two" });
	first.send(request("tabs-1b", "one", "tabs"));
	const survivingRequest = await withTimeout(nextNative(), "surviving client request");
	sendNativeResponse(survivingRequest, { marker: "one-still-live" });
	assert.equal((await withTimeout(first.next(), "surviving client response")).result.marker, "one-still-live");
	sendNativeResponse(orphanedRequest, { marker: "dropped-orphan" });

	const third = await connectClient(); third.send(request("hello-3", "three", "hello"));
	const thirdHello = await withTimeout(nextNative(), "third native hello"); sendNativeResponse(thirdHello, readyResult("three"));
	assert.equal((await withTimeout(third.next(), "third hello response")).ok, true);
	const firstClosed = new Promise((resolveClosed) => first.socket.once("close", resolveClosed));
	const thirdClosed = new Promise((resolveClosed) => third.socket.once("close", resolveClosed));
	child.stdin.end();
	await withTimeout(new Promise((resolveExit) => child.once("exit", resolveExit)), "native host owner-loss exit", 3_000);
	await Promise.all([withTimeout(firstClosed, "first client close"), withTimeout(thirdClosed, "third client close")]);
	await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
});
