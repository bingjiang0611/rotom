import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { extensionDir, extensionId } from "./chrome-test-paths.mjs";
test("Chrome MV3 manifest 固定 identity 且不申请 cookie/script/host 权限", async () => {
	const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
	assert.equal(manifest.manifest_version, 3);
	assert.equal(manifest.version, "0.12.0");
	const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
	const derived = [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
	assert.equal(derived, extensionId);
	// `downloads` (T22) is the only added permission; it is required to route agent downloads
	// and it shows the user a new permission line on the next install.
	assert.deepEqual([...manifest.permissions].sort(), ["alarms", "debugger", "downloads", "nativeMessaging", "storage", "tabGroups", "tabs"].sort());
	assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
	assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
});
test("Chrome MV3 worker 保留后台观察、输入与事件合同", async () => {
	const worker = await readFile(join(extensionDir, "service-worker.js"), "utf8");
	const scrollTarget = await readFile(join(extensionDir, "interaction-scroll-target.js"), "utf8");
	const tabListStatus = await readFile(join(extensionDir, "tab-list-status.js"), "utf8");
	const extensionSource = `${worker}\n${scrollTarget}\n${tabListStatus}`;
	assert.doesNotMatch(worker, /^await\b/mu, "MV3 service worker 不允许 top-level await");
	assert.match(worker, /void startRelay\(\);/u);
	for (const denied of ["chrome.cookies", "chrome.scripting"])
		assert.equal(extensionSource.includes(denied), false, denied);
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
	assert.match(worker, /protocolRevision: 21/u);
	assert.match(worker, /"snapshot-query"/u);
	assert.match(worker, /"targeted-keypress"/u);
	assert.match(worker, /"virtualized-frame-scroll"/u);
	assert.match(worker, /"multi-client-multiplex"/u);
	assert.match(worker, /"coordinate-click"/u);
	assert.match(worker, /"interaction-target-state"/u);
	assert.match(worker, /"page-alert-readback"/u);
	assert.match(worker, /const sessionStates = new Map\(\)/u);
	// Quotas are counted in the service worker only; `open` and `claim` must both pass
	// the check and `hello` must never trust the client's numbers.
	assert.match(worker, /assertTabQuotaAllowed\(state, itemOriginV1\(url\)\);/u);
	// navigate must resolve history through CDP, respect the client lease origins and
	// bump the document generation before dispatching anything.
	assert.match(worker, /operation === "navigate"/u);
	// Console: capture enabled on open, claimed tabs lazily, and every buffer dropped
	// when the tab goes away so `captureSince` never lies.
	assert.match(worker, /await enableConsoleCapture\(item, assertOperation\);/u);
	assert.equal(worker.match(/Runtime\.enable/u)?.length >= 1, true);
	assert.match(worker, /Log\.enable/u);
	assert.match(worker, /Runtime\.consoleAPICalled/u);
	assert.match(worker, /Runtime\.exceptionThrown/u);
	assert.match(worker, /Log\.entryAdded/u);
	assert.match(worker, /function forgetConsoleTabV1/u);
	// Pointer actions share one sequence table; drags press, move at least five times and
	// release, and HTML5 drags go through intercepted-or-synthesized CDP drag data.
	assert.match(worker, /pointerSequenceV1\(target\.action, point\)/u);
	assert.match(worker, /dragSequenceV1\(start, end\)/u);
	assert.match(worker, /Input\.setInterceptDrags/u);
	assert.match(worker, /Input\.dispatchDragEvent/u);
	assert.match(worker, /"Input\.dragIntercepted"/u);
	// Upload mounts real files through CDP but only on a file input, and only with the
	// paths the tool layer already validated.
	assert.match(worker, /DOM\.setFileInputFiles/u);
	assert.match(worker, /this\.tagName === 'INPUT' && this\.type === 'file'/u);
	assert.match(worker, /interaction upload paths invalid/u);
	assert.match(worker, /interaction paths require upload/u);
	// A suspended tab refuses every operation except the ones that can resolve or leave
	// the tab, and the input dispatch that opens a dialog reports it instead of hanging.
	assert.match(worker, /Page\.javascriptDialogOpening/u);
	assert.match(worker, /Page\.javascriptDialogClosed/u);
	assert.match(worker, /Page\.handleJavaScriptDialog/u);
	assert.match(worker, /function dialogGateV1\(/u);
	assert.match(worker, /dialogOpened: true/u);
	// Keypress uses the shared key table and never invents a key: no insertText, no
	// hand-written keyCode map, and the dispatch carries the table's parameters.
	assert.match(worker, /keyEventV1\(key, modifiers\)/u);
	assert.match(worker, /normalizeModifiersV1\(payload\.modifiers\)/u);
	// input.insertText (lowercase) belongs to the `type` action; the keypress path must
	// never call it. Only one call site exists, and it is guarded by action === "type".
	assert.equal((worker.match(/Input\.insertText/gu) ?? []).length, 1);
	// `type` is the only path that inserts text, and it is not the keypress branch.
	assert.ok(worker.indexOf('target.action === "type"') < worker.indexOf("Input.insertText"));
	assert.equal(worker.includes("windowsVirtualKeyCode: keyCode"), false);
	assert.match(worker, /Page\.getNavigationHistory/u);
	assert.match(worker, /Page\.navigateToHistoryEntry/u);
	assert.match(worker, /Page\.reload/u);
	assert.match(worker, /resetTransferredItemV1\(item\);|item\.documentGeneration = Number\.isSafeInteger\(item\.documentGeneration\)/u);
	assert.equal(worker.match(/assertTabQuotaAllowed\(state, itemOriginV1\(url\)\);/gu).length, 2, "open 与 claim 都要计入配额");
	assert.match(worker, /sanitizeBrowserTabQuotasV1\(payload\.tabQuotas\) \?\? \{ \.\.\.DEFAULT_BROWSER_TAB_QUOTAS_V1 \}/u);
	assert.match(worker, /sessionStateKeyV3\(state\.sessionId\)/u, "持久化必须按 session 分 key");
	assert.doesNotMatch(worker, /browserRelayStateV2: \{/u, "不得再写单文档 V2 状态");
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
	assert.match(worker, /createOperationGuard\(state, expectedEpoch, scopeKey\)[\s\S]*?operationGuard\.invalidate\(\)/u, "timeout 后必须用 operation revision 阻止迟到操作继续执行");
	assert.match(worker, /const scopeKey = `tab:\$\{tabLockKeyV1\(message\.payload, state\.currentTabName\)\}`;/u, "operation revision 必须按 tab 作用域隔离");
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
	for (const eventType of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"])
		assert.match(worker, new RegExp(`type: "${eventType}"`, "u"));
	assert.match(worker, /DOM\.getNodeForLocation/u, "坐标 fallback 必须在 CDP mouse dispatch 前执行 DOM hit-test");
	assert.match(worker, /coordinate screenshot observation epoch is stale|validateCoordinateBinding/u, "坐标 fallback 必须绑定最新 screenshot epoch");
	assert.doesNotMatch(worker, /assertBackgroundOwned|inputType === "password"|one-time-code|popupAttempted|interaction popup was blocked/u);
});
