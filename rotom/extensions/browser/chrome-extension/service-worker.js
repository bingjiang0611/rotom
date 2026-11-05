import { observedInteractionNode } from "./interaction-observation.js";
import { coordinateViewport, invalidateCoordinateObservation, mintCoordinateObservation, validateCoordinateBinding, validateCoordinateHit } from "./coordinate-click.js";
import { resetTransferredItemV1, transferTargetSessionV1, transferredTabNameV1 } from "./agent-transfer.js";
import { forgetSpawnedTab, recordedOpenerTabId, rememberSpawnedTab } from "./spawned-tabs.js";
import { createSessionLockV1, createTabLocksV1, isSessionScopedOperationV1, tabLockKeyV1 } from "./request-locks.js";
import { sessionCleanupPlanV1 } from "./session-cleanup.js";
import { consoleLevelFromTypeV1, createConsoleCaptureV1, parseConsoleCursorV1, sanitizeConsoleLevelV1, sanitizeConsoleLimitV1, sanitizeConsolePatternV1 } from "./console-buffer.js";
import { isBrowserKeyV1, keyEventV1, normalizeModifiersV1 } from "./key-table.js";
import { DIALOG_CURRENT_TAB_OPERATIONS_V1, createDialogStateV1 } from "./dialog-state.js";
import { BROWSER_POINTER_ACTIONS_V1, dragSequenceV1, pointerSequenceV1 } from "./pointer-events.js";
import { readInteractionSensitivity, sensitivityFromFactsV1 } from "./sensitive-actions.js";
import { MAX_DOWNLOAD_RECORDS_V1, downloadOwnerAgentIdV1, downloadRecordV1, downloadRelativeFilenameV1 } from "./downloads.js";
import { createNetworkCaptureV1, parseNetworkCursorV1, sanitizeNetworkLimitV1, sanitizeNetworkPatternV1, sanitizeNetworkResourceTypeV1 } from "./network-buffer.js";
import { MAX_DEVTOOLS_RESULT_BYTES_V1, MAX_EXPORT_HEIGHT_V1, MAX_EXPORT_WIDTH_V1, base64FromBytesV1, boundDevtoolsTextV1, bytesFromBase64V1, devtoolsEvaluateRecordV1, sanitizeDevtoolsExpressionV1, sanitizeDevtoolsWorldV1, sanitizeExportRequestV1, sanitizeViewportOverrideV1, viewportRecordV1 } from "./devtools-params.js";
import { checkBrowserTabQuotasV1, DEFAULT_BROWSER_TAB_QUOTAS_V1, sanitizeBrowserTabQuotasV1 } from "./tab-quotas.js";
import { createFocusCoordinator } from "./focus-coordinator.js";
import { withTabWake } from "./lifecycle-wake.js";
import { responseFramesV1 } from "./response-chunks.js";
import { createMergedSessionWriter, isSessionStateKeyV3, LEGACY_SESSION_STATE_KEY_V1, LEGACY_SESSION_STATE_KEY_V2, legacyV1Sessions, legacyV2Sessions, serializeSessionStateV3, sessionStateKeyV3 } from "./session-persistence.js";
import { interactionScrollTarget } from "./interaction-scroll-target.js";
import { createOperationGuard } from "./operation-guard.js";
import { operationChrome } from "./operation-chrome.js";
import { consumeMatchingWindowOpenSignal } from "./window-open-correlation.js";
import { RELAY_SETTLE_MS, relayOperationDeadlineMs, runWithRelayDeadline, valueWithinRelayDeadline } from "./relay-deadline.js";
import { fullReadCoverage, fullReadScrollStep, mergeRenderedText, scrollableTextTargets, scrollTargetState, scrollTargetTo } from "./full-read.js";
import { collectRenderedText, utf8TextChunks } from "./rendered-text.js";
import { collectPageAlerts, MAX_PAGE_ALERTS, pageAlertNodes } from "./page-alerts.js";
import { evaluateInteractionExpectation, interactionTargetChange, parseInteractionExpectation, readInteractionTargetState } from "./interaction-target-state.js";
import { formatScopedAxRef, parseScopedAxRef } from "./scoped-ax-ref.js";
import { placeAgentTabsInSharedGroup } from "./shared-tab-group.js";
import { applyOwnedTabUpdate, collectListedOwnedTabs, isMissingChromeTabError, listedOwnedTabStatus, ownedTabNotFoundError, relayUrl as safeUrl, reportableRelayUrl, retireOwnedTabName } from "./tab-list-status.js";
import { DEFAULT_AGENT_ID, restoredSessionPrincipal, sessionPrincipalFromHello, sessionPrincipalValue } from "./session-principal.js";

const HOST_NAME = "dev.rotom.browser_relay";
const MAX_NATIVE_BYTES = 1024 * 1024;
// Transport limit for one screenshot; what the model may see is bounded by the
// client's model-facing limit, not here.
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
// A response body buffer is deliberately small: this is a diagnostic view, not a proxy.
const MAX_NETWORK_BODY_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_NETWORK_BODY_RESOURCE_BYTES = 1024 * 1024;
const NETWORK_BODY_TEXT_MIME = /^(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded)|[^;]*\+(?:json|xml))/iu;
const MAX_AX_NODES = 600;
const MAX_QUERY_AX_NODES = 20_000;
const MAX_TEXT_NODES = 320;
const MAX_INTERACTION_TEXT_NODES = 24;
const TEXT_NODE_BYTES = 900;
const SCROLL_TARGET_WAIT_MS = 400;
const CLICK_TARGET_WAIT_MS = 750;
const CLICK_REVEAL_WAIT_MS = 750;
const BACKGROUND_ACTIVATION_GUARD_MS = 750;
const SCROLL_DISPATCH_WAIT_MS = 750;
const SCROLL_EFFECT_WAIT_MS = 500;
const INTERACTION_READBACK_WAIT_MS = 750;
const TARGET_STATE_WAIT_MS = 400;
const PAGE_ALERT_WAIT_MS = 500;
const NATIVE_RECONNECT_ALARM = "rotom-browser-relay-reconnect";
const FULL_READ_COMMAND_WAIT_MS = 750;
const FULL_READ_RENDER_WAIT_MS = 150;
const FULL_READ_MAX_TARGETS = 6;
const FULL_READ_MAX_STEPS = 60;
const FULL_READ_MAX_CHARACTERS = 500_000;
const MAX_NAME_CHARS = 512;
const sessionStates = new Map();
const childSessionsByTabId = new Map();
const tabReservations = new Set();
const windowOpenGuardsByTabId = new Map();
const spawnedTabOpeners = new Map();
// One user-focus record for the whole browser: several agents restore to the same
// place instead of each remembering its own pre-action focus.
const focusCoordinator = createFocusCoordinator({
	updateTab: async (tabId) => globalThis.chrome.tabs.update(tabId, { active: true }),
	updateWindow: async (windowId) => globalThis.chrome.windows.update(windowId, { focused: true }),
	windowIdOf: async (windowId) => {
		const tabs = await globalThis.chrome.tabs.query(Number.isInteger(windowId) ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
		const tab = tabs?.find((candidate) => candidate.active === true) ?? tabs?.[0];
		if (!Number.isInteger(tab?.id)) return undefined;
		const window = Number.isInteger(tab.windowId) ? await globalThis.chrome.windows.get(tab.windowId).catch(() => undefined) : undefined;
		return { tabId: tab.id, windowId: tab.windowId, focused: window?.focused === true };
	},
});
let nativePort;
let reconnectTimer;
let tabGroupChain = Promise.resolve();

function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeString(value, name, max = 256) {
	if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) throw new Error(`${name} invalid`);
	return value;
}
function safeName(value) {
	const name = safeString(value, "tabName", 64);
	if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(name)) throw new Error("tabName format invalid");
	return name;
}
function boundedText(value, max = MAX_NAME_CHARS) {
	return typeof value === "string" ? value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "") : "";
}
function publicError(error) {
	if (error instanceof Error) {
		if (/tab|url|session|timeout|debugger|navigation|relay|screenshot|snapshot|operation|owned|interaction|target|ref|download|agent|deploy|quota|console|network|lease|navigation|pattern|level|cursor|allowedOrigins|resourceType|failedOnly|devtools|expression|world|viewport|frame|invalid/iu.test(error.message)) return error.message.slice(0, 512);
	}
	return "browser relay operation failed";
}
function post(message) {
	const encoded = JSON.stringify(message);
	if (new TextEncoder().encode(encoded).length > MAX_NATIVE_BYTES) throw new Error("native message too large");
	nativePort?.postMessage(message);
}
// A response that exceeds one native message travels as numbered chunks carrying
// the digest of the whole serialized message; the client reassembles and verifies.
async function postResponse(message) {
	for (const frame of await responseFramesV1(message)) post(frame);
}
function createSessionState(sessionId) {
	const id = safeString(sessionId, "sessionId", 512);
	return { sessionId: id, agentId: DEFAULT_AGENT_ID, rootSessionId: id, leaseToken: undefined, tabQuotas: { ...DEFAULT_BROWSER_TAB_QUOTAS_V1 }, generation: undefined, epoch: 0, operationRevisions: new Map(), currentTabName: undefined, tabsByName: new Map(), retiredTabNames: new Map(), lock: createSessionLockV1(), tabLocks: createTabLocksV1() };
}
function allSessionItems() {
	return [...sessionStates.values()].flatMap((state) => [...state.tabsByName.values()]);
}
function findSessionItemByTabId(tabId) {
	for (const state of sessionStates.values()) for (const item of state.tabsByName.values()) if (item.tabId === tabId) return item;
}
function sessionOwnsTabId(state, tabId) {
	for (const item of state.tabsByName.values()) if (item.tabId === tabId) return true;
	return false;
}
function sessionOwningTabId(tabId) {
	for (const state of sessionStates.values()) if (sessionOwnsTabId(state, tabId)) return state;
}
function connectedMainSessionForRoot(rootSessionId) {
	for (const state of sessionStates.values()) if (state.rootSessionId === rootSessionId && state.agentId === DEFAULT_AGENT_ID && state.generation !== undefined) return state;
}
/**
 * Agent tabs, counted globally the way the quotas define them: a tab the agent opened
 * itself counts, a claimed user tab belongs to the user and does not.
 */
function agentTabCountsV1(state, origin) {
	let ownTabs = 0;
	let globalTabs = 0;
	let originTabs = 0;
	for (const owner of sessionStates.values()) {
		for (const item of owner.tabsByName.values()) {
			if (item.ownership !== "agent") continue;
			globalTabs += 1;
			if (owner === state) ownTabs += 1;
			if (origin !== undefined && itemOriginV1(item.url) === origin) originTabs += 1;
		}
	}
	const connected = [...sessionStates.values()].filter((candidate) => candidate.generation !== undefined);
	return { ownTabs, globalTabs, originTabs, agents: connected.length, agentIndex: connected.indexOf(state) };
}
function itemOriginV1(url) {
	try { return new URL(url).origin; } catch { return undefined; }
}
/** Refuse an over-quota `open`/`claim` before touching Chrome; never queue it. */
function assertTabQuotaAllowed(state, origin) {
	const counts = agentTabCountsV1(state, origin);
	const decision = checkBrowserTabQuotasV1({ quotas: state.tabQuotas ?? DEFAULT_BROWSER_TAB_QUOTAS_V1, origin, ...counts });
	if (!decision.ok) throw new Error(decision.message);
}

async function placeInSharedAgentGroup(tab, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const pending = tabGroupChain.catch(() => undefined).then(() => placeAgentTabsInSharedGroup({
		createdTab: tab,
		items: [...sessionStates.values()].flatMap((state) => [...state.tabsByName.values()].map((item) => ({ ...item, agentId: state.agentId }))),
		queryTabs: (query) => chrome.tabs.query(query),
		groupTabs: (options) => chrome.tabs.group(options),
		updateGroup: (groupId, options) => chrome.tabGroups.update(groupId, options),
	}));
	tabGroupChain = pending.catch(() => undefined);
	await pending;
}
// One storage key per session, coalesced for a short window and diffed against the
// last write, so a burst of operations touches one key once and idle sessions are
// never rewritten.
const sessionWriter = createMergedSessionWriter({
	entries: () => new Map([...sessionStates.values()].map((state) => [sessionStateKeyV3(state.sessionId), serializeSessionStateV3(state)])),
	write: (payload) => chrome.storage.session.set(payload),
	remove: (keys) => chrome.storage.session.remove(keys),
});
function persistState() { return sessionWriter.schedule(); }
async function restoreState() {
	const storedValues = (await chrome.storage.session.get(null)) ?? {};
	const storedSessions = [];
	for (const [key, value] of Object.entries(storedValues)) if (isSessionStateKeyV3(key) && record(value)) storedSessions.push(value);
	const knownSessionIds = new Set(storedSessions.map((stored) => stored.sessionId));
	// Legacy documents are migrated key by key, then removed so the next start is V3 only.
	const migrated = [...legacyV2Sessions(storedValues[LEGACY_SESSION_STATE_KEY_V2]), ...legacyV1Sessions(storedValues[LEGACY_SESSION_STATE_KEY_V1])]
		.filter((stored) => !knownSessionIds.has(stored.sessionId));
	storedSessions.push(...migrated);
	let targets = [];
	try {
		const resolvedTargets = await chrome.debugger.getTargets();
		if (Array.isArray(resolvedTargets)) targets = resolvedTargets;
	} catch { /* indeterminate target discovery restores cached ownership as detached */ }
	const seenTabIds = new Set();
	for (const stored of storedSessions) {
		if (!record(stored) || typeof stored.sessionId !== "string" || !Array.isArray(stored.tabs)) continue;
		let state;
		try { state = createSessionState(stored.sessionId); } catch { continue; }
		state.currentTabName = typeof stored.currentTabName === "string" ? stored.currentTabName : undefined;
		state.keepTabs = stored.keepTabs === true;
		Object.assign(state, restoredSessionPrincipal(stored, state.sessionId));
		for (const candidate of stored.tabs) {
			if (!record(candidate) || !Number.isInteger(candidate.tabId) || typeof candidate.targetId !== "string" || seenTabIds.has(candidate.tabId)) continue;
			let name; let cachedUrl;
			try { name = safeName(candidate.name); } catch { continue; }
			try { cachedUrl = safeUrl(candidate.url); }
			catch { retireOwnedTabName(state.retiredTabNames, name, "dropped on extension restart because its saved URL is unsupported"); continue; }
			let tab;
			try { tab = await chrome.tabs.get(candidate.tabId); }
			catch (error) { if (isMissingChromeTabError(error)) { retireOwnedTabName(state.retiredTabNames, name, "its Chrome tab was gone when the extension restarted"); continue; } }
			const target = targets.find((item) => item.tabId === candidate.tabId && item.id === candidate.targetId && item.type === "page");
			let actualUrl;
			if (target && typeof target.url === "string") try { actualUrl = safeUrl(target.url); } catch { /* unsupported navigation remains detached */ }
			state.tabsByName.set(name, {
				tabId: candidate.tabId,
				targetId: candidate.targetId,
				documentGeneration: Number.isInteger(candidate.documentGeneration) && candidate.documentGeneration > 0 ? candidate.documentGeneration : 1,
				url: actualUrl ?? cachedUrl,
				status: tab?.status === "complete" ? "complete" : tab?.status === "loading" ? "loading" : candidate.status === "complete" ? "complete" : "loading",
				ownership: candidate.ownership === "claimed" ? "claimed" : "agent",
				...(typeof candidate.restoreAutoDiscardable === "boolean" ? { restoreAutoDiscardable: candidate.restoreAutoDiscardable } : {}),
				attached: false,
				detached: true,
			});
			seenTabIds.add(candidate.tabId);
		}
		if (state.currentTabName && !state.tabsByName.has(state.currentTabName)) state.currentTabName = undefined;
		sessionStates.set(state.sessionId, state);
	}
	await sessionWriter.flushNow();
	if (storedValues[LEGACY_SESSION_STATE_KEY_V2] !== undefined || storedValues[LEGACY_SESSION_STATE_KEY_V1] !== undefined) {
		await chrome.storage.session.remove([LEGACY_SESSION_STATE_KEY_V2, LEGACY_SESSION_STATE_KEY_V1]);
	}
}

// Best-effort: a tab that Chrome froze or discarded is moved back to "active" on
// every attach. Failing here is a diagnostic, never an operation failure.
async function wakeTabLifecycle(item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	return withTabWake({
		item,
		assertOperation,
		sendCommand: (debuggee, method, params) => chrome.debugger.sendCommand(debuggee, method, params),
		diagnose: (message) => console.warn(`browser relay lifecycle wake failed: ${message}`),
	});
}
// Console capture is memory only: a service-worker restart drops it, and every buffer
// then reports a fresh `captureSince` instead of pretending the old entries exist.
const consoleCapture = createConsoleCaptureV1();
/** Whether Runtime/Log are enabled for this debugger attachment. */
const consoleEnabledTabIds = new Set();
function consoleTextFromRemoteObjects(args) {
	if (!Array.isArray(args)) return "";
	return args.map((argument) => {
		if (!argument || typeof argument !== "object") return "";
		if (typeof argument.value === "string") return argument.value;
		if (typeof argument.value === "number" || typeof argument.value === "boolean") return String(argument.value);
		if (argument.value === null) return "null";
		if (typeof argument.unserializableValue === "string") return argument.unserializableValue;
		if (typeof argument.description === "string") return argument.description;
		return argument.type === "undefined" ? "undefined" : "";
	}).filter((part) => part.length > 0).join(" ");
}
function consoleStackFrames(stackTrace) {
	const frames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
	return frames.slice(0, 10).map((frame) => {
		const fn = typeof frame?.functionName === "string" && frame.functionName.length > 0 ? frame.functionName : "(anonymous)";
		const where = typeof frame?.url === "string" && frame.url.length > 0 ? `${safeUrl(frame.url)}:${Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : 0}` : "<anonymous>";
		return `${fn} @ ${where}`;
	});
}
function recordConsoleEvent(tabId, method, params) {
	if (method === "Runtime.consoleAPICalled") {
		consoleCapture.append(tabId, {
			level: consoleLevelFromTypeV1(params?.type),
			text: consoleTextFromRemoteObjects(params?.args),
			...(typeof params?.stackTrace?.callFrames?.[0]?.url === "string" ? { url: safeUrl(params.stackTrace.callFrames[0].url) } : {}),
			...(Number.isInteger(params?.stackTrace?.callFrames?.[0]?.lineNumber) ? { lineNumber: params.stackTrace.callFrames[0].lineNumber + 1 } : {}),
			at: Number.isFinite(params?.timestamp) ? params.timestamp : Date.now(),
			source: "console",
			stack: consoleStackFrames(params?.stackTrace),
		});
		return;
	}
	if (method === "Runtime.exceptionThrown") {
		const details = params?.exceptionDetails;
		const description = typeof details?.exception?.description === "string" ? details.exception.description : typeof details?.text === "string" ? details.text : "";
		consoleCapture.append(tabId, {
			level: "error",
			text: description,
			...(typeof details?.url === "string" && details.url.length > 0 ? { url: safeUrl(details.url) } : {}),
			...(Number.isInteger(details?.lineNumber) ? { lineNumber: details.lineNumber + 1 } : {}),
			at: Number.isFinite(details?.timestamp) ? details.timestamp : Date.now(),
			source: "exception",
			stack: consoleStackFrames(details?.stackTrace),
		});
		return;
	}
	if (method === "Log.entryAdded") {
		const entry = params?.entry;
		consoleCapture.append(tabId, {
			level: consoleLevelFromTypeV1(entry?.level),
			text: typeof entry?.text === "string" ? entry.text : "",
			...(typeof entry?.url === "string" && entry.url.length > 0 ? { url: safeUrl(entry.url) } : {}),
			...(Number.isInteger(entry?.lineNumber) ? { lineNumber: entry.lineNumber + 1 } : {}),
			at: Number.isFinite(entry?.timestamp) ? entry.timestamp : Date.now(),
			source: typeof entry?.source === "string" ? entry.source : "log",
		});
	}
}
// Network capture keeps metadata only: no header, body or cookie is ever stored, and
// Network.enable below asks Chrome not to buffer response bodies at all.
const networkCapture = createNetworkCaptureV1();
const dialogState = createDialogStateV1();
// Last closed dialog per tab: readback evidence for the `dialog` action, not state.
const dialogLastClosedByTabId = new Map();
const networkEnabledTabIds = new Set();
// CDP timestamps are monotonic seconds since an arbitrary epoch, so they are kept only
// to measure duration; every reported time is wall clock from this side.
const networkStartTimestamps = new Map();
// HTML5 drag-and-drop is not driven by mouse events: Chrome emits one interception with
// the dragged payload and the page then expects CDP drag events. One slot per tab, set
// only for the duration of a drag action.
const dragInterceptionByTabId = new Map();
function recordNetworkEvent(tabId, method, params) {
	if (method === "Network.requestWillBeSent") {
		if (typeof params?.requestId === "string" && Number.isFinite(params?.timestamp)) networkStartTimestamps.set(params.requestId, params.timestamp);
		networkCapture.started(tabId, {
			requestId: params?.requestId,
			url: typeof params?.request?.url === "string" ? safeUrl(params.request.url) : "",
			method: params?.request?.method,
			resourceType: params?.type,
			at: Date.now(),
		});
		return;
	}
	if (method === "Network.responseReceived") {
		networkCapture.responded(tabId, {
			requestId: params?.response?.requestId ?? params?.requestId,
			status: params?.response?.status,
			mimeType: params?.response?.mimeType,
			resourceType: params?.type,
			fromDiskCache: params?.response?.fromDiskCache,
			fromServiceWorker: params?.response?.fromServiceWorker,
		});
		return;
	}
	if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
		const start = networkStartTimestamps.get(params?.requestId);
		const durationMs = Number.isFinite(start) && Number.isFinite(params?.timestamp) ? (params.timestamp - start) * 1_000 : undefined;
		if (typeof params?.requestId === "string") networkStartTimestamps.delete(params.requestId);
		networkCapture.finished(tabId, {
			requestId: params?.requestId,
			at: Date.now(),
			...(durationMs === undefined ? {} : { durationMs }),
			...(method === "Network.loadingFailed" ? { failure: params?.errorText ?? "failed" } : {}),
		});
	}
}
/** Enable network metadata capture once per debugger attachment. */
// Response bodies need Chrome to keep them: re-enable with a small, explicit buffer. A tab
// that was already enabled loses its earlier bodies on purpose, so the caller is told that
// only requests issued after this call can be read.
const networkBodyTabIds = new Set();
async function enableNetworkBodyCapture(item, assertOperation = () => undefined) {
	if (networkBodyTabIds.has(item.tabId)) return;
	await globalThis.chrome.debugger.sendCommand({ tabId: item.tabId }, "Network.enable", { maxTotalBufferSize: MAX_NETWORK_BODY_TOTAL_BYTES, maxResourceBufferSize: MAX_NETWORK_BODY_RESOURCE_BYTES, maxPostDataSize: 0 });
	assertOperation();
	networkBodyTabIds.add(item.tabId);
	networkEnabledTabIds.add(item.tabId);
}
async function enableNetworkCapture(item, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	if (networkEnabledTabIds.has(item.tabId)) return;
	// Zero-size buffers: Chrome keeps no response body for us to fetch by mistake.
	await chrome.debugger.sendCommand({ tabId: item.tabId }, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
	assertOperation();
	networkEnabledTabIds.add(item.tabId);
}
/** A tab that stops being attached or owned loses its capture instead of silently
 *  resuming with a gap; the next read reports a fresh `captureSince`. */
function forgetConsoleTabV1(tabId) {
	consoleEnabledTabIds.delete(tabId);
	consoleCapture.reset(tabId);
	networkEnabledTabIds.delete(tabId);
	networkCapture.reset(tabId);
	// A dialog cannot survive its tab: leaving a record behind would block a future
	// tab that happens to reuse the id.
	dialogState.reset(tabId);
}
/** Enable console capture once per debugger attachment; claimed tabs wait for a call. */
async function enableConsoleCapture(item, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	if (consoleEnabledTabIds.has(item.tabId)) return;
	await chrome.debugger.sendCommand({ tabId: item.tabId }, "Runtime.enable");
	await chrome.debugger.sendCommand({ tabId: item.tabId }, "Log.enable");
	assertOperation();
	consoleEnabledTabIds.add(item.tabId);
}
async function attach(item, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	assertOperation();
	const targets = await chrome.debugger.getTargets();
	assertOperation();
	if (typeof item.targetId === "string") {
		const target = targets.find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
		if (!target) throw new Error("owned debugger target identity changed");
		if (item.attached === true && item.detached !== true && target.attached === true) { await wakeTabLifecycle(item, assertOperation); return; }
		assertOperation();
		item.attached = false;
		item.detached = true;
		if (target.attached === true) {
			try {
				await chrome.debugger.sendCommand({ tabId: item.tabId }, "Page.enable");
				await chrome.debugger.sendCommand({ tabId: item.tabId }, "Accessibility.enable");
				await enableChildFrameSessions({ tabId: item.tabId }, assertOperation);
				assertOperation();
				item.attached = true; item.detached = false; await persistState(); await wakeTabLifecycle(item, assertOperation); assertOperation(); return;
			} catch { throw new Error("owned debugger target is attached by another client"); }
		}
	}
	let attachedHere = false;
	try {
		await chrome.debugger.attach({ tabId: item.tabId }, "1.3");
		attachedHere = true;
		assertOperation();
		await chrome.debugger.sendCommand({ tabId: item.tabId }, "Page.enable");
		await chrome.debugger.sendCommand({ tabId: item.tabId }, "Accessibility.enable");
		await enableChildFrameSessions({ tabId: item.tabId }, assertOperation);
		assertOperation();
		const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === item.tabId && candidate.type === "page");
		if (!target || (item.targetId && item.targetId !== target.id)) throw new Error("owned debugger target identity unavailable");
		assertOperation();
		item.targetId = target.id;
		item.attached = true;
		item.detached = false;
		await persistState();
		await wakeTabLifecycle(item, assertOperation);
		assertOperation();
	} catch (error) {
		if (attachedHere) try { await chrome.debugger.detach({ tabId: item.tabId }); } catch { /* already detached */ }
		throw error;
	}
}
function childSessionEntries(tabId) {
	return [...(childSessionsByTabId.get(tabId)?.values() ?? [])];
}
async function enableChildFrameSessions(debuggee, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
		autoAttach: true,
		waitForDebuggerOnStart: false,
		flatten: true,
		filter: [{ type: "iframe", exclude: false }],
	});
}
function registerChildSession(tabId, params) {
	if (typeof params?.sessionId !== "string" || params?.targetInfo?.type !== "iframe") return;
	const item = findSessionItemByTabId(tabId);
	if (!item) return;
	let sessions = childSessionsByTabId.get(tabId);
	if (!sessions) { sessions = new Map(); childSessionsByTabId.set(tabId, sessions); }
	if (sessions.has(params.sessionId)) return;
	item.nextFrameScope = Number.isSafeInteger(item.nextFrameScope) ? item.nextFrameScope + 1 : 1;
	const entry = { sessionId: params.sessionId, targetId: params.targetInfo.targetId, scopeId: `f${item.nextFrameScope}` };
	sessions.set(entry.sessionId, entry);
	const ownerState = [...sessionStates.values()].find((state) => [...state.tabsByName.values()].includes(item));
	const ownerEpoch = ownerState?.epoch;
	const assertChild = () => {
		if (findSessionItemByTabId(tabId) !== item || ownerState?.epoch !== ownerEpoch || childSessionsByTabId.get(tabId)?.get(entry.sessionId) !== entry) throw new Error("child debugger session retired");
	};
	entry.ready = (async () => {
		const chrome = operationChrome(globalThis.chrome, assertChild);
		const debuggee = { tabId, sessionId: entry.sessionId };
		await chrome.debugger.sendCommand(debuggee, "Page.enable");
		await chrome.debugger.sendCommand(debuggee, "Accessibility.enable");
		await enableChildFrameSessions(debuggee, assertChild);
	})();
	entry.ready.catch(() => { if (sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId); });
}
function removeChildSession(tabId, sessionId) {
	const sessions = childSessionsByTabId.get(tabId);
	if (!sessions || typeof sessionId !== "string") return;
	sessions.delete(sessionId);
	if (sessions.size === 0) childSessionsByTabId.delete(tabId);
}
function rotateChildSessionScope(tabId, sessionId) {
	const entry = childSessionsByTabId.get(tabId)?.get(sessionId);
	const item = findSessionItemByTabId(tabId);
	if (!entry || !item) return;
	item.nextFrameScope = Number.isSafeInteger(item.nextFrameScope) ? item.nextFrameScope + 1 : 1;
	entry.scopeId = `f${item.nextFrameScope}`;
}
/** Agent tabs must not be discarded underneath a running operation. */
async function protectFromDiscard(chrome, tabId) {
	try {
		const before = await chrome.tabs.get(tabId);
		await chrome.tabs.update(tabId, { autoDiscardable: false });
		return before?.autoDiscardable !== false;
	} catch { return undefined; }
}
async function releaseDiscardProtection(chrome, item) {
	if (item?.restoreAutoDiscardable === undefined) return;
	try { await chrome.tabs.update(item.tabId, { autoDiscardable: item.restoreAutoDiscardable }); }
	catch { /* tab already gone */ }
}
/** `placement: "agent-window"` keeps a dedicated unfocused window per agent. */
async function createAgentWindowTab(state, url) {
	const chrome = globalThis.chrome;
	if (Number.isInteger(state.agentWindowId)) {
		const existing = await chrome.windows.get(state.agentWindowId).catch(() => undefined);
		if (existing) return chrome.tabs.create({ windowId: state.agentWindowId, url, active: false });
		state.agentWindowId = undefined;
	}
	focusCoordinator.markAgentActivity();
	const created = await chrome.windows.create({ url, focused: false, type: "normal" });
	if (!Number.isInteger(created?.id)) throw new Error("agent window creation failed");
	state.agentWindowId = created.id;
	const tab = (created.tabs ?? []).find((candidate) => Number.isInteger(candidate?.id));
	if (!tab) throw new Error("agent window tab unavailable");
	return tab;
}
async function closeOwned(state, name, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	assertOperation();
	const item = state.tabsByName.get(name);
	if (!item) return false;
	// Keep a retiring ID unavailable to concurrent sessions until cleanup settles.
	tabReservations.add(item.tabId);
	state.tabsByName.delete(name);
	retireOwnedTabName(state.retiredTabNames, name, "closed by the relay (close request or failed open/claim cleanup)");
	childSessionsByTabId.delete(item.tabId);
	forgetConsoleTabV1(item.tabId);
	if (state.currentTabName === name) state.currentTabName = undefined;
	try {
		try { await chrome.debugger.detach({ tabId: item.tabId }); } catch { /* already detached or retired */ }
		if (item.ownership !== "claimed") try { await chrome.tabs.remove(item.tabId); } catch { /* already closed or retired */ }
		else await releaseDiscardProtection(chrome, item);
		await persistState();
		return true;
	} finally { tabReservations.delete(item.tabId); }
}
async function closeOwnedIdentity(state, name, tabId, expectedItem, assertOperation) {
	assertOperation();
	const current = state.tabsByName.get(name);
	if (current === expectedItem && current?.tabId === tabId) await closeOwned(state, name, assertOperation);
	// Never clean up a name/ID that has been rebound to another owner.
}
async function closeAllOwned(state, assertOperation = () => undefined) {
	for (const name of [...state.tabsByName.keys()]) await closeOwned(state, name, assertOperation);
	assertOperation();
	state.currentTabName = undefined;
	await persistState();
}
function owned(state, nameValue) {
	const name = nameValue === undefined ? state.currentTabName : safeName(nameValue);
	if (!name) throw new Error("no current owned tab");
	const item = state.tabsByName.get(name);
	if (!item) throw ownedTabNotFoundError(state.retiredTabNames, name);
	return { name, item };
}
async function assertOwnedWithin(item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	if (!tab || tab.id !== item.tabId) throw new Error("owned tab lost");
	return tab;
}
function axValue(node, field) {
	const value = node?.[field]?.value;
	return typeof value === "string" ? boundedText(value) : "";
}
function axStates(node) {
	const result = [];
	for (const property of Array.isArray(node.properties) ? node.properties : []) {
		if (!["checked", "disabled", "expanded", "focused", "invalid", "pressed", "readonly", "required", "selected"].includes(property?.name)) continue;
		const value = property?.value?.value;
		if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") result.push(`${property.name}=${String(value).slice(0, 32)}`);
	}
	return result;
}
function observationValue(name, item, tab, nodes, truncated, coverage = {}, visibilityState) {
	const observationEpoch = invalidateCoordinateObservation(item);
	return {
		schemaVersion: 1,
		kind: "rotom-browser-observation",
		tabName: name,
		tabId: item.tabId,
		documentGeneration: item.documentGeneration,
		observationEpoch,
		url: item.url,
		title: "",
		status: tab.status === "complete" ? "complete" : "loading",
		nodes,
		truncated,
		contentCoverage: coverage.contentCoverage === "scroll-end" ? "scroll-end" : "rendered-dom",
		contentComplete: coverage.contentComplete === true,
		...(visibilityState === undefined ? {} : { visibilityState }),
		...(Number.isSafeInteger(coverage.scanSteps) ? { scanSteps: coverage.scanSteps } : {}),
		...(Number.isSafeInteger(coverage.scannedContainers) ? { scannedContainers: coverage.scannedContainers } : {}),
		...(Number.isSafeInteger(coverage.scrolledContainers) ? { scrolledContainers: coverage.scrolledContainers } : {}),
	};
}
// 每个 scope（主文档 + 各子框架 CDP session）跑同一段扩展内置函数，永不接受模型提供的
// JavaScript。单个 scope 超时或失败只丢它自己那份，不阻塞其余 scope。
async function scopedEvaluations(item, expression, deadlineMs, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const evaluate = async (debuggee) => {
		const evaluated = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression, returnByValue: true }), deadlineMs);
		return evaluated.ok ? evaluated.value?.result?.value : undefined;
	};
	const root = evaluate({ tabId: item.tabId }).then((value) => ({ scopeId: "r", value }));
	const children = childSessionEntries(item.tabId).map(async (entry) => {
		const ready = await valueWithinRelayDeadline(entry.ready, 1_000);
		if (!ready.ok) return undefined;
		return { scopeId: entry.scopeId, value: await evaluate({ tabId: item.tabId, sessionId: entry.sessionId }) };
	});
	const results = await Promise.all([root, ...children]);
	assertOperation();
	return results.filter((entry) => entry !== undefined);
}
async function renderedTextSources(item, assertOperation) {
	const evaluated = await scopedEvaluations(item, `(${collectRenderedText.toString()})()`, 2_500, assertOperation);
	return {
		sources: evaluated.filter((entry) => typeof entry.value === "string" && entry.value).map((entry) => ({ scopeId: entry.scopeId, text: entry.value })),
		incomplete: evaluated.length !== 1 + childSessionEntries(item.tabId).length || evaluated.some((entry) => typeof entry.value !== "string"),
	};
}
/** `document.visibilityState` of the root document, or undefined when unreadable. */
async function readVisibilityState(item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const evaluated = await valueWithinRelayDeadline(chrome.debugger.sendCommand({ tabId: item.tabId }, "Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }), 1_500);
	const value = evaluated.ok ? evaluated.value?.result?.value : undefined;
	return value === "visible" || value === "hidden" ? value : undefined;
}
async function pageAlertSources(item, assertOperation) {
	const evaluated = await scopedEvaluations(item, `(${collectPageAlerts.toString()})()`, PAGE_ALERT_WAIT_MS, assertOperation);
	return evaluated.filter((entry) => Array.isArray(entry.value) && entry.value.length > 0).map((entry) => ({ scopeId: entry.scopeId, alerts: entry.value }));
}
function renderedTextNodes(item, sources, maxNodes) {
	const nodes = [];
	let truncated = false;
	const seen = new Set();
	for (const source of sources) {
		const chunked = utf8TextChunks(source.text, TEXT_NODE_BYTES, Math.max(1, maxNodes - nodes.length));
		truncated ||= chunked.truncated;
		for (let index = 0; index < chunked.chunks.length && nodes.length < maxNodes; index += 1) {
			const name = chunked.chunks[index];
			if (seen.has(name)) continue;
			seen.add(name);
			nodes.push({ ref: `txt_${item.documentGeneration}_${source.scopeId}_${index + 1}`, role: "document-text", name, states: ["read-only=true"] });
		}
		if (nodes.length >= maxNodes) { truncated = true; break; }
	}
	return { nodes, truncated };
}
async function observation(name, item, assertOperation, payload = {}) {
	const query = {};
	for (const [key, max] of [["text", 256], ["role", 128]]) {
		if (payload[key] === undefined) continue;
		if (typeof payload[key] !== "string" || !payload[key].length || payload[key].length > max || payload[key].includes("\0")) throw new Error(`snapshot query ${key} invalid`);
		query[key] = payload[key];
	}
	const filtered = query.text !== undefined || query.role !== undefined;
	const needle = query.text?.toLowerCase();
	const matches = (role, name) => (query.role === undefined || query.role === role) && (needle === undefined || name.toLowerCase().includes(needle));
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	await attach(item, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	if (!tab || tab.id !== item.tabId) throw new Error("owned tab lost");
	await delay(50);
	const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
	if (!target || typeof target.url !== "string") throw new Error("owned debugger target identity changed");
	assertOperation();
	// A target can be briefly non-reportable (about:blank between creation and navigation,
	// or a chrome:// page). Keep the last reportable URL instead of failing the call.
	item.url = reportableRelayUrl(target.url) ?? item.url;
	const rootTreePromise = valueWithinRelayDeadline(chrome.debugger.sendCommand({ tabId: item.tabId }, "Accessibility.getFullAXTree", { depth: 64 }), 8_000);
	const childTreesPromise = Promise.all(childSessionEntries(item.tabId).map(async (entry) => {
		const ready = await valueWithinRelayDeadline(entry.ready, 1_000);
		if (!ready.ok) return undefined;
		const tree = await valueWithinRelayDeadline(chrome.debugger.sendCommand({ tabId: item.tabId, sessionId: entry.sessionId }, "Accessibility.getFullAXTree", { depth: 64 }), 2_000);
		return tree.ok ? { scopeId: entry.scopeId, nodes: Array.isArray(tree.value?.nodes) ? tree.value.nodes : [], incomplete: !Array.isArray(tree.value?.nodes) } : undefined;
	}));
	const includeText = !filtered || query.role === undefined || query.role === "document-text";
	const [rootTree, childTrees, textSources, visibilityState] = await Promise.all([rootTreePromise, childTreesPromise,
		includeText ? renderedTextSources(item, assertOperation) : { sources: [], incomplete: false },
		readVisibilityState(item, assertOperation)]);
	assertOperation();
	const rawNodes = (rootTree.ok && Array.isArray(rootTree.value?.nodes) ? rootTree.value.nodes : []).map((node) => ({ node, scopeId: "r" }));
	for (const child of childTrees) if (child) for (const node of child.nodes) rawNodes.push({ node, scopeId: child.scopeId });
	const nodes = [];
	const selection = filtered ? { ...query, sourceNodes: 0, scannedAxNodes: Math.min(rawNodes.length, MAX_QUERY_AX_NODES),
		scanTruncated: rawNodes.length > MAX_QUERY_AX_NODES || !rootTree.ok || !Array.isArray(rootTree.value?.nodes) || childTrees.some((child) => !child || child.incomplete), matchesTruncated: false } : undefined;
	const scanned = filtered ? rawNodes.slice(0, MAX_QUERY_AX_NODES) : rawNodes;
	// Missing child IDs expose depth/scan boundaries; no whole-DOM absence claim.
	const scannedIds = filtered ? new Set(scanned.map(({ node, scopeId }) => `${scopeId}:${node.nodeId}`)) : undefined;
	const seenBackendNodeIds = new Set();
	for (const { node, scopeId } of scanned) {
		if (!filtered && nodes.length >= MAX_AX_NODES) break;
		if (selection && node.childIds?.some((id) => !scannedIds.has(`${scopeId}:${id}`))) selection.scanTruncated = true;
		if (node?.ignored === true || !Number.isInteger(node?.backendDOMNodeId)) continue;
		const scopedBackendNodeId = `${scopeId}:${node.backendDOMNodeId}`;
		if (seenBackendNodeIds.has(scopedBackendNodeId)) continue;
		const role = axValue(node, "role");
		const nameValue = axValue(node, "name");
		if (!role && !nameValue) continue;
		seenBackendNodeIds.add(scopedBackendNodeId);
		if (selection) {
			selection.sourceNodes += 1;
			if (!matches(role, nameValue)) continue;
			if (nodes.length >= MAX_AX_NODES) { selection.matchesTruncated = true; continue; }
		}
		const ref = formatScopedAxRef(item.documentGeneration, scopeId, node.backendDOMNodeId);
		nodes.push({ ref, role, name: nameValue, states: axStates(node) });
	}
	const text = renderedTextNodes(item, textSources.sources, MAX_TEXT_NODES);
	nodes.push(...(filtered ? text.nodes.filter((node) => matches(node.role, node.name)) : text.nodes));
	item.lastObservationNodes = nodes;
	if (selection) {
		selection.sourceNodes += text.nodes.length;
		selection.scanTruncated ||= text.truncated || textSources.incomplete;
		return { ...observationValue(name, item, tab, nodes, selection.scanTruncated || selection.matchesTruncated), selection };
	}
	return observationValue(name, item, tab, nodes, (rawNodes.length > MAX_AX_NODES) || text.truncated || !rootTree.ok, {}, visibilityState);
}
async function interactionReadback(name, item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	const [textSources, alertSources] = await Promise.all([renderedTextSources(item, assertOperation), pageAlertSources(item, assertOperation)]);
	assertOperation();
	const text = renderedTextNodes(item, textSources.sources, MAX_INTERACTION_TEXT_NODES);
	// 提示排在正文之前：被校验拦下的表单，错误就是这次交互唯一重要的结果。
	const alerts = pageAlertNodes(item.documentGeneration, alertSources, MAX_PAGE_ALERTS);
	return observationValue(name, item, tab, [...alerts.nodes, ...text.nodes], text.truncated || alerts.truncated);
}
async function boundedInteractionReadback(name, item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const readback = await valueWithinRelayDeadline(interactionReadback(name, item, assertOperation), INTERACTION_READBACK_WAIT_MS);
	assertOperation();
	if (readback.ok) return readback.value;
	const tab = await chrome.tabs.get(item.tabId);
	assertOperation();
	return observationValue(name, item, tab, [], true);
}

async function scopedDebuggerCommandWithin(debuggee, method, parameters, deadlineMs = FULL_READ_COMMAND_WAIT_MS, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const result = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, method, parameters), deadlineMs);
	assertOperation();
	return result.ok ? result.value : undefined;
}

async function fullRenderedTextSource(debuggee, scopeId, remainingSteps, assertOperation) {
	const debuggerCommandWithin = (debuggee, method, parameters, deadlineMs) => scopedDebuggerCommandWithin(debuggee, method, parameters, deadlineMs, assertOperation);
	const objectGroup = `rotom-full-read-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let scanSteps = 0;
	let scannedContainers = 0;
	let scrolledContainers = 0;
	let endReached = true;
	let text = "";
	let truncated = false;
	try {
		const evaluated = await debuggerCommandWithin(debuggee, "Runtime.evaluate", {
			expression: `(${scrollableTextTargets.toString()})(document, ${FULL_READ_MAX_TARGETS})`,
			returnByValue: false,
			objectGroup,
		});
		const targetsObjectId = evaluated?.result?.objectId;
		if (typeof targetsObjectId !== "string") return { scopeId, text: "", endReached: false, truncated: false, scanSteps, scannedContainers, scrolledContainers };
		const lengthResult = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", {
			objectId: targetsObjectId,
			functionDeclaration: "function(){return {length:this.length,truncated:this.truncated===true};}",
			returnByValue: true,
		});
		const discovered = lengthResult?.result?.value;
		truncated ||= !record(discovered) || discovered.truncated === true;
		const targetCount = Math.max(0, Math.min(Number(discovered?.length) || 0, FULL_READ_MAX_TARGETS));
		for (let index = 0; index < targetCount && scanSteps < remainingSteps; index += 1) {
			const targetResult = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", {
				objectId: targetsObjectId,
				arguments: [{ value: index }],
				functionDeclaration: "function(index){return this[index];}",
				returnByValue: false,
			});
			const targetObjectId = targetResult?.result?.objectId;
			if (typeof targetObjectId !== "string") { endReached = false; continue; }
			const original = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, functionDeclaration: scrollTargetState.toString(), returnByValue: true });
			if (!record(original?.result?.value)) { endReached = false; continue; }
			const originalTop = Number(original.result.value.top) || 0;
			let rendered = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: 0 }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true, awaitPromise: true });
			await delay(FULL_READ_RENDER_WAIT_MS);
			scannedContainers += 1;
			let targetComplete = false;
			let targetMoved = false;
			let targetScrollable = false;
			let stableEndPasses = 0;
			let previousHeight = -1;
			let previousTop = -1;
			let previousClientHeight = 0;
			for (;;) {
				if (scanSteps >= remainingSteps || typeof rendered?.result?.value !== "number") break;
				const stateResult = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, functionDeclaration: scrollTargetState.toString(), returnByValue: true });
				const state = stateResult?.result?.value;
				if (!record(state)) break;
				scanSteps += 1;
				const top = Number(state.top) || 0;
				const clientHeight = Number(state.clientHeight) || 0;
				const scrollHeight = Number(state.scrollHeight) || 0;
				targetScrollable ||= scrollHeight - clientHeight > 2;
				targetMoved ||= previousTop >= 0 && top > previousTop + 1;
				// Observe the start and overlapping progress, not just a dispatched
				// scroll request: snapping or a refused reset can skip unseen content.
				if (previousTop < 0 ? Math.abs(top) > 1 : top < previousTop - 1 || top > previousTop + previousClientHeight + 1) break;
				const merged = mergeRenderedText(text, typeof state.text === "string" ? state.text : "", FULL_READ_MAX_CHARACTERS);
				text = merged.text;
				truncated ||= merged.truncated;
				const atEnd = clientHeight <= 0 || top + clientHeight >= scrollHeight - 2;
				if (atEnd) {
					stableEndPasses = scrollHeight === previousHeight ? stableEndPasses + 1 : 0;
					if (stableEndPasses >= 2) { targetComplete = !targetScrollable || targetMoved; break; }
				} else stableEndPasses = 0;
				const step = fullReadScrollStep(clientHeight);
				const nextTop = Math.min(Math.max(0, scrollHeight - clientHeight), top + step);
				if (!atEnd && (nextTop <= top + 1 || top === previousTop)) break;
				previousHeight = scrollHeight;
				previousTop = top;
				previousClientHeight = clientHeight;
				rendered = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: nextTop }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true, awaitPromise: true });
				await delay(FULL_READ_RENDER_WAIT_MS);
			}
			if (targetMoved) scrolledContainers += 1;
			endReached &&= targetComplete;
			const restored = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: originalTop }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true, awaitPromise: true });
			if (typeof restored?.result?.value !== "number" || Math.abs(restored.result.value - originalTop) > 1) endReached = false;
		}
		if (targetCount === 0) endReached = false;
		return { scopeId, text, endReached, truncated, scanSteps, scannedContainers, scrolledContainers };
	} finally {
		await debuggerCommandWithin(debuggee, "Runtime.releaseObjectGroup", { objectGroup }, 300);
	}
}

async function fullObservation(name, item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	await attach(item, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	if (!tab || tab.id !== item.tabId) throw new Error("owned tab lost");
	// Reuse the background interaction primitive: allow rendering without selecting
	// the tab or focusing its window. Each scroll also proves a rendered frame.
	return withFocusEmulation({ tabId: item.tabId }, async () => {
		const root = await fullRenderedTextSource({ tabId: item.tabId }, "r", FULL_READ_MAX_STEPS, assertOperation);
		let remainingSteps = Math.max(0, FULL_READ_MAX_STEPS - root.scanSteps);
		const sources = [root];
		let framesComplete = true;
		for (const entry of childSessionEntries(item.tabId)) {
			if (remainingSteps <= 0) { framesComplete = false; break; }
			const ready = await valueWithinRelayDeadline(entry.ready, 500);
			if (!ready.ok) { framesComplete = false; continue; }
			const child = await fullRenderedTextSource({ tabId: item.tabId, sessionId: entry.sessionId }, entry.scopeId, remainingSteps, assertOperation);
			remainingSteps = Math.max(0, remainingSteps - child.scanSteps);
			sources.push(child);
		}
		assertOperation();
		let combined = "";
		let truncated = false;
		for (const source of sources) {
			const merged = mergeRenderedText(combined, source.text, FULL_READ_MAX_CHARACTERS);
			combined = merged.text;
			truncated ||= source.truncated || merged.truncated;
		}
		const text = renderedTextNodes(item, [{ scopeId: "full", text: combined }], MAX_TEXT_NODES);
		truncated ||= text.truncated;
		item.lastObservationNodes = text.nodes;
		return observationValue(name, item, tab, text.nodes, truncated, fullReadCoverage(sources, truncated, FULL_READ_MAX_STEPS, framesComplete));
	}, assertOperation);
}
function interactionRef(value, generation) {
	const ref = safeString(value, "targetRef", 128);
	const parsed = parseScopedAxRef(ref, generation);
	if (!parsed) throw new Error("interaction target ref is stale or invalid");
	return parsed;
}
async function interactionDebuggee(item, scopeId) {
	if (scopeId === "r") return { tabId: item.tabId };
	const entry = childSessionEntries(item.tabId).find((candidate) => candidate.scopeId === scopeId);
	if (!entry) throw new Error("interaction target frame is stale or unavailable");
	const ready = await valueWithinRelayDeadline(entry.ready, SCROLL_TARGET_WAIT_MS);
	if (!ready.ok) throw new Error("interaction target frame is not ready");
	return { tabId: item.tabId, sessionId: entry.sessionId };
}
async function interactionTarget(name, item, payload, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const assertOwned = (item) => assertOwnedWithin(item, assertOperation);
	const action = safeString(payload.action, "action", 32);
	if (!["click", "type", "scroll", "select", "keypress", "upload", ...BROWSER_POINTER_ACTIONS_V1.filter((value) => value !== "click")].includes(action)) throw new Error("interaction action invalid");
	if (action !== "upload" && payload.paths !== undefined) throw new Error("interaction paths require upload");
	if (action === "drag") {
		if (payload.dropRef === undefined) throw new Error("interaction drag requires dropRef");
		if (payload.key !== undefined || payload.modifiers !== undefined) throw new Error("interaction drag parameters invalid");
		if (["x", "y", "observationEpoch"].some((field) => payload[field] !== undefined)) throw new Error("interaction drag accepts refs, not coordinates");
	} else if (payload.dropRef !== undefined) throw new Error("interaction dropRef requires drag");
	if (action === "keypress") {
		if (!isBrowserKeyV1(payload.key)) throw new Error("interaction keypress key invalid");
		if (payload.modifiers !== undefined && normalizeModifiersV1(payload.modifiers) === undefined) throw new Error("interaction keypress modifiers invalid");
		if (["x", "y", "observationEpoch", "text", "replace", "option", "direction", "amount"].some((field) => payload[field] !== undefined)) throw new Error("interaction keypress parameters invalid");
	} else if (payload.key !== undefined) throw new Error("interaction key requires keypress");
	else if (payload.modifiers !== undefined) throw new Error("interaction modifiers require keypress");
	await assertOwned(item);
	if (action === "scroll") {
		const parsed = payload.targetRef === undefined ? undefined : interactionRef(payload.targetRef, item.documentGeneration);
		const node = parsed === undefined ? undefined : observedInteractionNode(item.lastObservationNodes, parsed.ref);
		const debuggee = await interactionDebuggee(item, parsed?.scopeId ?? "r");
		let scrollBackendNodeId = parsed?.backendNodeId;
		let scrollScope = parsed ? "anchor" : "viewport";
		if (!parsed) {
			const document = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.getDocument", { depth: 0 }), SCROLL_TARGET_WAIT_MS);
			if (document.ok && Number.isSafeInteger(document.value?.root?.backendNodeId)) scrollBackendNodeId = document.value.root.backendNodeId;
		} else {
			const anchor = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", { backendNodeId: parsed.backendNodeId }), SCROLL_TARGET_WAIT_MS);
			if (anchor.ok && typeof anchor.value?.object?.objectId === "string") {
				const selected = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
					objectId: anchor.value.object.objectId,
					functionDeclaration: interactionScrollTarget.toString(),
					returnByValue: false,
				}), SCROLL_TARGET_WAIT_MS);
				if (selected.ok && typeof selected.value?.result?.objectId === "string") {
					const described = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.describeNode", { objectId: selected.value.result.objectId }), SCROLL_TARGET_WAIT_MS);
					if (described.ok && Number.isSafeInteger(described.value?.node?.backendNodeId)) {
						scrollBackendNodeId = described.value.node.backendNodeId;
						scrollScope = "nearest";
					}
				}
			}
		}
		await assertOwned(item);
		const scrollTargetRef = Number.isSafeInteger(scrollBackendNodeId) ? formatScopedAxRef(item.documentGeneration, parsed?.scopeId ?? "r", scrollBackendNodeId) : undefined;
		return { action, parsed, node, debuggee, scrollBackendNodeId, scrollTargetRef, scrollScope };
	}
	if (action === "hover" || action === "dblclick" || action === "right_click") {
		// Same ref contract as click, without the editable/selectable role rules.
		const parsed = interactionRef(payload.targetRef, item.documentGeneration);
		const node = observedInteractionNode(item.lastObservationNodes, parsed.ref);
		if (node.role === "document-text") throw new Error("document text ref is read-only");
		if (action === "hover" && payload.text !== undefined) throw new Error("interaction hover parameters invalid");
		await assertOwned(item);
		return { action, parsed, node, debuggee: await interactionDebuggee(item, parsed.scopeId) };
	}
	if (action === "upload") {
		const parsed = interactionRef(payload.targetRef, item.documentGeneration);
		const node = observedInteractionNode(item.lastObservationNodes, parsed.ref);
		if (node.role === "document-text") throw new Error("document text ref is read-only");
		if (!Array.isArray(payload.paths) || payload.paths.length === 0 || payload.paths.length > 10) throw new Error("interaction upload paths invalid");
		if (payload.paths.some((path) => typeof path !== "string" || path.length === 0)) throw new Error("interaction upload path invalid");
		await assertOwned(item);
		return { action, parsed, node, debuggee: await interactionDebuggee(item, parsed.scopeId) };
	}
	if (action === "drag") {
		const parsed = interactionRef(payload.targetRef, item.documentGeneration);
		const dropRef = interactionRef(payload.dropRef, item.documentGeneration);
		const node = observedInteractionNode(item.lastObservationNodes, parsed.ref);
		const dropNode = observedInteractionNode(item.lastObservationNodes, dropRef.ref);
		for (const candidate of [node, dropNode]) if (candidate.role === "document-text") throw new Error("document text ref is read-only");
		if (parsed.scopeId !== dropRef.scopeId) throw new Error("interaction drag refs must share one frame");
		await assertOwned(item);
		return { action, parsed, node, dropParsed: dropRef, dropNode, debuggee: await interactionDebuggee(item, parsed.scopeId) };
	}
	if (action === "click" && payload.targetRef === undefined) {
		const debuggee = { tabId: item.tabId };
		const metrics = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
		const point = validateCoordinateBinding(item, payload, metrics);
		const hit = await coordinateHitTarget(debuggee, point, assertOperation);
		await assertOwned(item);
		return { action, coordinate: true, debuggee, point, hit };
	}
	const parsed = interactionRef(payload.targetRef, item.documentGeneration);
	const node = observedInteractionNode(item.lastObservationNodes, parsed.ref);
	if (node.role === "document-text") throw new Error("document text ref is read-only");
	if (action === "type" && !["textbox", "searchbox", "combobox", "spinbutton"].includes(node.role)) throw new Error("interaction type target is not editable");
	if (action === "select" && !["combobox", "listbox"].includes(node.role)) throw new Error("interaction select target is not selectable");
	await assertOwned(item);
	return { action, parsed, node, debuggee: await interactionDebuggee(item, parsed.scopeId) };
}
function quadBounds(quad) {
	if (!Array.isArray(quad) || quad.length < 8 || quad.some((value) => typeof value !== "number" || !Number.isFinite(value))) return undefined;
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}
async function dispatchPoint(debuggee, backendNodeId, deadlineMs, revealTarget = false, requireTargetBox = false, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const command = async (method, parameters) => {
		const pending = chrome.debugger.sendCommand(debuggee, method, parameters);
		if (deadlineMs === undefined) return pending;
		const bounded = await valueWithinRelayDeadline(pending, deadlineMs);
		return bounded.ok ? bounded.value : undefined;
	};
	const geometry = async () => {
		const metrics = await command("Page.getLayoutMetrics");
		const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
		const width = Number(viewport?.clientWidth);
		const height = Number(viewport?.clientHeight);
		if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) throw new Error("interaction viewport unavailable");
		if (backendNodeId === undefined) return { width, height };
		const model = await command("DOM.getBoxModel", { backendNodeId });
		return { width, height, bounds: quadBounds(model?.model?.border ?? model?.model?.content) };
	};
	let { width, height, bounds } = await geometry();
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) throw new Error("interaction viewport unavailable");
	if (backendNodeId === undefined) return { x: width / 2, y: height / 2 };
	if (!bounds && requireTargetBox) throw new Error("interaction target geometry unavailable");
	if (!bounds && deadlineMs !== undefined) return { x: width / 2, y: height / 2 };
	if (!bounds) throw new Error("interaction target has no dispatch box");
	const visible = () => bounds.right > 1 && bounds.left < width - 1 && bounds.bottom > 1 && bounds.top < height - 1;
	if (!visible() && revealTarget) {
		const revealed = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId }), CLICK_REVEAL_WAIT_MS);
		if (!revealed.ok) throw new Error("interaction target could not be scrolled into the visible viewport");
		({ width, height, bounds } = await geometry());
		if (!bounds) throw new Error("interaction target has no dispatch box after scrolling into view");
	}
	const left = Math.max(1, bounds.left);
	const right = Math.min(width - 1, bounds.right);
	const top = Math.max(1, bounds.top);
	const bottom = Math.min(height - 1, bounds.bottom);
	if (right <= left || bottom <= top) throw new Error("interaction target is outside the visible viewport");
	return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
async function coordinateHitTarget(debuggee, point, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const located = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false }), CLICK_TARGET_WAIT_MS);
	if (!located.ok || !Number.isSafeInteger(located.value?.backendNodeId)) throw new Error("coordinate click hit-test found no DOM target");
	const described = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "DOM.describeNode", { backendNodeId: located.value.backendNodeId, depth: 0 }), CLICK_TARGET_WAIT_MS);
	if (!described.ok) throw new Error("coordinate click hit-test target could not be described");
	const hit = validateCoordinateHit({ backendNodeId: located.value.backendNodeId, nodeName: described.value?.node?.localName || described.value?.node?.nodeName });
	return hit;
}
async function withFocusEmulation(debuggee, action, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	await chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });
	try { return await action(); }
	finally { await chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: false }); }
}
async function withBackgroundActivationGuard(item, action, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const sourceTab = await chrome.tabs.get(item.tabId);
	if (!Number.isInteger(sourceTab?.windowId)) return { value: await action(), spawnedTabs: 0, restored: false };
	const tabsBefore = await chrome.tabs.query({});
	const knownTabIds = new Set(tabsBefore.map((tab) => tab.id).filter(Number.isInteger));
	const spawned = new Map();
	const windowOpenGuard = { signals: [] };
	assertOperation();
	// Anything the dispatch activates or focuses in this window is agent noise, not
	// the user moving around.
	focusCoordinator.markAgentActivity(BACKGROUND_ACTIVATION_GUARD_MS + 2_000);
	// A freshly started service worker has not seen any activation yet; seed the
	// record from the real active tab so the first dispatch still restores it.
	if (!focusCoordinator.userFocus()) await focusCoordinator.observeActiveTab(sourceTab.windowId);
	windowOpenGuardsByTabId.set(item.tabId, windowOpenGuard);
	let restorationChain = Promise.resolve();
	const restore = async () => {
		// Only the user's focus is restored; a window an agent opened for itself is
		// never brought forward.
		await focusCoordinator.restore();
		const relatedWindowIds = new Set([...[...spawned.values()].map((tab) => tab.windowId).filter(Number.isInteger)]);
		const userFocus = focusCoordinator.userFocus();
		for (const windowId of relatedWindowIds) {
			if (windowId === userFocus?.windowId) continue;
			try { const current = await chrome.windows.get(windowId); if (current.focused === true) await chrome.windows.update(windowId, { focused: false }); }
			catch { /* popup may already have closed */ }
		}
	};
	const queueRestore = () => { restorationChain = restorationChain.then(restore).catch(() => undefined); };
	const consumeWindowOpenSignal = (tab) => consumeMatchingWindowOpenSignal(windowOpenGuard.signals, tab, Date.now(), BACKGROUND_ACTIVATION_GUARD_MS + 1_000);
	const onCreated = (tab) => {
		try { assertOperation(); } catch { return; }
		if (!Number.isInteger(tab?.id)) return;
		const signalMatched = consumeWindowOpenSignal(tab);
		if (tab.openerTabId !== item.tabId && !signalMatched) return;
		spawned.set(tab.id, tab);
		rememberSpawnedTab(spawnedTabOpeners, tab.id, item.tabId);
		queueRestore();
	};
	chrome.tabs.onCreated.addListener(onCreated);
	try {
		const value = await action();
		await delay(BACKGROUND_ACTIVATION_GUARD_MS);
		for (const tab of await chrome.tabs.query({})) if (Number.isInteger(tab.id) && !knownTabIds.has(tab.id) && (tab.openerTabId === item.tabId || consumeWindowOpenSignal(tab))) { spawned.set(tab.id, tab); rememberSpawnedTab(spawnedTabOpeners, tab.id, item.tabId); }
		queueRestore();
		await restorationChain;
		return { value, spawnedTabs: spawned.size, restored: true };
	} finally {
		chrome.tabs.onCreated.removeListener(onCreated);
		if (windowOpenGuardsByTabId.get(item.tabId) === windowOpenGuard) windowOpenGuardsByTabId.delete(item.tabId);
	}
}
// 目标状态用派发前解析到的同一个 JS 对象读，不重新按 ref 查找：元素被移除、被替换
// 本身就是强证据，而重新查找会把这个信号抹掉。读不到就是 unknown，不是「没变」。
async function interactionTargetObjectId(target, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	if (target.coordinate === true || target.parsed === undefined) return undefined;
	const resolved = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "DOM.resolveNode", { backendNodeId: target.parsed.backendNodeId }), TARGET_STATE_WAIT_MS);
	return resolved.ok && typeof resolved.value?.object?.objectId === "string" ? resolved.value.object.objectId : undefined;
}
async function interactionTargetState(debuggee, objectId, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	if (objectId === undefined) return undefined;
	const evaluated = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: readInteractionTargetState.toString(),
		returnByValue: true,
	}), TARGET_STATE_WAIT_MS);
	const value = evaluated.ok ? evaluated.value?.result?.value : undefined;
	return record(value) ? value : undefined;
}
/**
 * Facts about the interaction target, used to decide whether the user must confirm.
 * Coordinate clicks have no ref, so the probe runs on the hit-tested node instead.
 */
async function interactionSensitivity(target, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const backendNodeId = target.coordinate === true ? target.hit?.backendNodeId : target.parsed?.backendNodeId;
	if (!Number.isSafeInteger(backendNodeId)) return undefined;
	const resolved = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "DOM.resolveNode", { backendNodeId }), TARGET_STATE_WAIT_MS);
	if (!resolved.ok || typeof resolved.value?.object?.objectId !== "string") return undefined;
	const evaluated = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
		objectId: resolved.value.object.objectId,
		functionDeclaration: readInteractionSensitivity.toString(),
		returnByValue: true,
	}), TARGET_STATE_WAIT_MS);
	assertOperation();
	const value = evaluated.ok ? evaluated.value?.result?.value : undefined;
	if (!record(value)) return undefined;
	return sensitivityFromFactsV1({ name: typeof value.name === "string" ? value.name : "", creditCardForm: value.creditCardForm === true });
}
async function performInteraction(name, item, payload, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const assertOwned = (item) => assertOwnedWithin(item, assertOperation);
	assertOperation();
	await attach(item, assertOperation);
	await assertOwned(item);
	assertOperation();
	if (payload.action === "dialog") {
		// Handling a dialog is not a page interaction: no ref, no hit-test, no readback
		// of a suspended tree. Chrome resolves the command after the dialog closes.
		if (typeof payload.accept !== "boolean") throw new Error("interaction dialog requires accept");
		const accept = payload.accept;
		// An empty prompt answer is legitimate, so this cannot use safeString (which
		// rejects the empty string).
		const promptText = payload.promptText === undefined ? undefined : (typeof payload.promptText === "string" && payload.promptText.length <= 500 && !payload.promptText.includes("\0") ? payload.promptText : undefined);
		if (payload.promptText !== undefined && promptText === undefined) throw new Error("interaction dialog promptText invalid");
		if (!accept && promptText !== undefined) throw new Error("interaction dialog promptText requires accept=true");
		for (const field of ["targetRef", "dropRef", "paths", "key", "modifiers", "text", "replace", "option", "direction", "amount", "expect", "x", "y", "observationEpoch"]) {
			if (payload[field] !== undefined) throw new Error("interaction dialog parameters invalid");
		}
		const current = dialogState.get(item.tabId);
		if (current === undefined) throw new Error("interaction dialog is not open on this tab");
		await assertOwned(item);
		assertOperation();
		await chrome.debugger.sendCommand({ tabId: item.tabId }, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
		assertOperation();
		// Chrome closed it when the command resolved; the record is cleared here so a
		// missing `javascriptDialogClosed` event cannot leave the tab blocked forever.
		const handled = dialogState.closed(item.tabId) ?? current;
		await assertOwned(item);
		let readback;
		try { readback = await boundedInteractionReadback(name, item, assertOperation); }
		catch {
			const tab = await chrome.tabs.get(item.tabId);
			assertOperation();
			readback = observationValue(name, item, tab, [], true);
		}
		assertOperation();
		return {
			schemaVersion: 1,
			kind: "rotom-browser-interaction-result",
			actionId: safeString(payload.actionId, "actionId", 128),
			action: "dialog",
			acknowledged: true,
			effect: {
				dispatch: "handleJavaScriptDialog",
				accept,
				dialog: handled,
				...(handled.sensitive ? { sensitive: true } : {}),
				...(promptText === undefined ? {} : { promptTextLength: [...promptText].length }),
			},
			readback,
		};
	}
	// Re-check the tab's origin immediately before dispatching a write. The caller's
	// authorized set is what the policy layer granted; if a server-side redirect moved the
	// tab somewhere else, that origin was never authorized and the write must not happen.
	if (payload.action !== "scroll" && payload.allowedOrigins !== undefined) {
		if (!Array.isArray(payload.allowedOrigins) || payload.allowedOrigins.some((origin) => typeof origin !== "string")) throw new Error("interaction allowedOrigins invalid");
		const tab = await chrome.tabs.get(item.tabId);
		assertOperation();
		const currentUrl = safeUrl(tab.url);
		const currentOrigin = itemOriginV1(currentUrl);
		if (currentOrigin === undefined || !payload.allowedOrigins.includes(currentOrigin)) {
			return { schemaVersion: 1, kind: "needs-approval", tabName: name, origin: currentOrigin ?? "", capability: "write", reason: "origin" };
		}
	}
	if (payload.allowDownload !== undefined) {
		const owner = sessionOwningTabId(item.tabId);
		if (owner) owner.allowDownload = payload.allowDownload === true;
	}
	const target = await interactionTarget(name, item, payload, assertOperation);
	assertOperation();
	// A sensitive target is refused before anything is dispatched: Pi asks the user and
	// re-sends the same action with `confirmed: true`. The label never leaves the worker.
	const sensitive = payload.action === "scroll" ? undefined : await interactionSensitivity(target, assertOperation);
	if (sensitive !== undefined && payload.confirmed !== true) {
		return { schemaVersion: 1, kind: "needs-confirmation", tabName: name, origin: itemOriginV1(safeUrl(item.url)) ?? "", capability: "interact", ...sensitive };
	}
	const expectation = parseInteractionExpectation(payload.expect);
	if (expectation && (target.action === "scroll" || target.coordinate === true)) throw new Error("interaction expect requires a targetRef click, type, select, or keypress");
	const stateObjectId = target.action === "scroll" ? undefined : await interactionTargetObjectId(target, assertOperation);
	const stateBefore = await interactionTargetState(target.debuggee, stateObjectId, assertOperation);
	assertOperation();
	let effect;
	// A dialog suspends the renderer, so the input command that triggers one never
	// resolves: the release waits for the page to resume. Race the whole dispatch against
	// dialog detection so the caller learns about the dialog instead of timing out.
	const dispatchAction = async () => {
		if (target.action === "click") {
			const point = target.coordinate ? target.point : await dispatchPoint(target.debuggee, target.parsed.backendNodeId, CLICK_TARGET_WAIT_MS, true, true, assertOperation);
			assertOperation();
			const guarded = await withBackgroundActivationGuard(item, () => withFocusEmulation(target.debuggee, async () => {
				assertOperation();
				if (target.coordinate) {
					const currentHit = await coordinateHitTarget(target.debuggee, point, assertOperation);
					if (currentHit.backendNodeId !== target.hit.backendNodeId) throw new Error("coordinate click hit-test target changed before dispatch");
				}
				assertOperation();
				await assertOwned(item);
				await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", pointerType: "mouse" });
				await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
				await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
			}, assertOperation), assertOperation);
			assertOperation();
			effect = { dispatch: "mouse", x: point.x, y: point.y, ...(target.coordinate ? { coordinate: true, observationEpoch: payload.observationEpoch, hitTested: true, hitNodeName: target.hit.nodeName } : {}), focusEmulated: true, backgroundPreserved: guarded.restored, spawnedTabs: guarded.spawnedTabs };
		} else if (target.action === "hover" || target.action === "dblclick" || target.action === "right_click") {
			const point = await dispatchPoint(target.debuggee, target.parsed.backendNodeId, CLICK_TARGET_WAIT_MS, true, true, assertOperation);
			assertOperation();
			const events = pointerSequenceV1(target.action, point);
			const guarded = await withBackgroundActivationGuard(item, () => withFocusEmulation(target.debuggee, async () => {
				assertOperation();
				await assertOwned(item);
				for (const event of events) await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", event);
			}, assertOperation), assertOperation);
			assertOperation();
			effect = { dispatch: "mouse", action: target.action, x: point.x, y: point.y, events: events.length, focusEmulated: true, backgroundPreserved: guarded.restored, spawnedTabs: guarded.spawnedTabs };
		} else if (target.action === "drag") {
			const start = await dispatchPoint(target.debuggee, target.parsed.backendNodeId, CLICK_TARGET_WAIT_MS, true, true, assertOperation);
			const end = await dispatchPoint(target.debuggee, target.dropParsed.backendNodeId, CLICK_TARGET_WAIT_MS, true, true, assertOperation);
			assertOperation();
			const drag = dragSequenceV1(start, end);
			const slot = { data: undefined };
			let dragDataSource = "none";
			dragInterceptionByTabId.set(item.tabId, slot);
			let guarded;
			try {
				guarded = await withBackgroundActivationGuard(item, () => withFocusEmulation(target.debuggee, async () => {
					assertOperation();
					await assertOwned(item);
					// Interception must be on before the press, otherwise an HTML5 draggable
					// element starts a native drag the relay cannot complete.
					await chrome.debugger.sendCommand(target.debuggee, "Input.setInterceptDrags", { enabled: true });
					for (const event of drag.before) await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", event);
					for (const event of drag.moves) {
						assertOperation();
						await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", event);
						if (slot.data !== undefined) break;
					}
					// A pointer-based drag needs the moves only; an HTML5 drag answers with an
					// interception and then needs explicit drag events at the drop point.
					for (let attempt = 0; attempt < 12 && slot.data === undefined; attempt += 1) await delay(25);
					// Chrome does not start a real HTML5 drag from synthetic mouse input, so the
					// interception often never arrives. Fall back to DragData built from the
					// dragged element's own text; the page then reads it in `drop` via
					// dataTransfer. `dragstart` does not fire on this path, and the effect says so.
					let dragData = slot.data;
					if (dragData !== undefined) dragDataSource = "intercepted";
					if (dragData === undefined) {
						const objectId = await interactionTargetObjectId(target, assertOperation);
						if (objectId !== undefined) {
							// Only a draggable source takes drag events: a pointer-driven drag on a
							// plain element must stay a pure mouse sequence.
							const described = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
								objectId,
								functionDeclaration: "function(){ return JSON.stringify({ draggable: this.draggable === true, text: (this.innerText || this.textContent || '').trim().slice(0, 1024) }); }",
								returnByValue: true,
							}), TARGET_STATE_WAIT_MS);
							const raw = described.value?.result?.value;
							let facts;
							try { facts = typeof raw === "string" ? JSON.parse(raw) : undefined; } catch { facts = undefined; }
							if (facts?.draggable === true) {
								dragData = { items: [{ mimeType: "text/plain", data: typeof facts.text === "string" ? facts.text : "" }], dragOperationsMask: 1 };
								dragDataSource = "synthesized-from-text";
							}
						}
					}
					if (dragData !== undefined) {
						for (const type of ["dragEnter", "dragOver", "drop"]) {
							assertOperation();
							await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchDragEvent", { type, ...end, data: dragData });
						}
					}
					for (const event of drag.after) await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", event);
					await chrome.debugger.sendCommand(target.debuggee, "Input.setInterceptDrags", { enabled: false });
				}, assertOperation), assertOperation);
			} finally {
				dragInterceptionByTabId.delete(item.tabId);
			}
			assertOperation();
			effect = { dispatch: "mouse", action: "drag", from: { x: start.x, y: start.y }, to: { x: end.x, y: end.y }, moves: drag.moves.length, droppedAt: payload.dropRef, html5: dragDataSource !== "none", dragDataSource, dragstartFired: dragDataSource === "intercepted", focusEmulated: true, backgroundPreserved: guarded.restored, spawnedTabs: guarded.spawnedTabs };
		} else if (target.action === "upload") {
			if (stateObjectId === undefined) throw new Error("interaction upload target could not be resolved");
			// The element must be a file input: setting files on anything else would either do
			// nothing or attach data to a control the caller did not mean.
			const isFileInput = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
				objectId: stateObjectId,
				functionDeclaration: "function(){ return this.tagName === 'INPUT' && this.type === 'file'; }",
				returnByValue: true,
			}), TARGET_STATE_WAIT_MS);
			if (isFileInput.value?.result?.value !== true) throw new Error("interaction upload target is not a file input");
			assertOperation();
			await chrome.debugger.sendCommand(target.debuggee, "DOM.setFileInputFiles", { files: payload.paths, backendNodeId: target.parsed.backendNodeId });
			assertOperation();
			effect = { dispatch: "files", files: payload.paths.length, focusVerified: false };
		} else if (target.action === "keypress") {
			if (stateObjectId === undefined) throw new Error("interaction keypress target could not be resolved");
			const key = payload.key;
			const modifiers = normalizeModifiersV1(payload.modifiers);
			if (modifiers === undefined) throw new Error("interaction keypress modifiers invalid");
			const keyEvent = keyEventV1(key, modifiers);
			if (!keyEvent) throw new Error("interaction keypress key invalid");
			const assertKeyTarget = () => {
				assertOperation();
				interactionRef(target.parsed.ref, item.documentGeneration);
				if (target.parsed.scopeId !== "r" && !childSessionEntries(item.tabId).some((entry) => entry.scopeId === target.parsed.scopeId && entry.sessionId === target.debuggee.sessionId)) throw new Error("interaction keypress frame is stale");
			};
			const guarded = await withBackgroundActivationGuard(item, () => withFocusEmulation(target.debuggee, async () => {
				assertKeyTarget();
				await chrome.debugger.sendCommand(target.debuggee, "DOM.focus", { backendNodeId: target.parsed.backendNodeId });
				await assertOwned(item);
				// Focus handlers can replace the input or redirect focus. Never send a key to
				// whichever control happens to be focused; prove the original object owns it.
				const focused = await chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
					objectId: stateObjectId,
					functionDeclaration: "function(){ return this.isConnected === true && !this.disabled && this.getRootNode().activeElement === this; }",
					returnByValue: true,
				});
				if (focused?.result?.value !== true) throw new Error("interaction keypress target did not retain focus");
				assertKeyTarget();
				// A real CDP key event, never insertText or a synthetic DOM KeyboardEvent. A key
				// that inserts a character travels as one keyDown carrying that character; a
				// chorded or non-printing key travels as rawKeyDown without text.
				const { text, unmodifiedText, ...parameters } = keyEvent;
				await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchKeyEvent", { ...parameters, ...(text === undefined ? {} : { text, unmodifiedText }), type: text === undefined ? (modifiers.length > 0 ? "keyDown" : "rawKeyDown") : "keyDown", ...(key === "a" && modifiers.some((modifier) => modifier === "Meta" || modifier === "Control") ? { commands: ["selectAll"] } : {}) });
				assertKeyTarget();
				await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchKeyEvent", { ...parameters, type: "keyUp" });
			}, assertOperation), assertOperation);
			assertOperation();
			effect = { dispatch: "keyboard", key, ...(modifiers.length > 0 ? { modifiers } : {}), focusVerified: true, focusEmulated: true, backgroundPreserved: guarded.restored, spawnedTabs: guarded.spawnedTabs };
		} else if (target.action === "type") {
			const text = safeString(payload.text, "text", 4096);
			await chrome.debugger.sendCommand(target.debuggee, "DOM.focus", { backendNodeId: target.parsed.backendNodeId });
			assertOperation();
			if (payload.replace === true) {
				const resolved = await chrome.debugger.sendCommand(target.debuggee, "DOM.resolveNode", { backendNodeId: target.parsed.backendNodeId });
				assertOperation();
				if (typeof resolved?.object?.objectId !== "string") throw new Error("interaction editable target could not be resolved");
				await chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
					objectId: resolved.object.objectId,
					functionDeclaration: "function(){ this.focus(); if (typeof this.select === 'function') this.select(); }",
					returnByValue: true,
				});
				assertOperation();
			}
			await assertOwned(item);
			assertOperation();
			await chrome.debugger.sendCommand(target.debuggee, "Input.insertText", { text });
			assertOperation();
		} else if (target.action === "select") {
			const option = safeString(payload.option, "option", 512);
			const resolved = await chrome.debugger.sendCommand(target.debuggee, "DOM.resolveNode", { backendNodeId: target.parsed.backendNodeId });
			assertOperation();
			if (typeof resolved?.object?.objectId !== "string") throw new Error("interaction selectable target could not be resolved");
			await assertOwned(item);
			assertOperation();
			const selected = await chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
				objectId: resolved.object.objectId,
				arguments: [{ value: option }],
				functionDeclaration: "function(expected){ const options=Array.from(this.options||[]); const match=options.find((entry)=>entry.value===expected||entry.textContent?.trim()===expected); if(!match)return false; this.value=match.value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
				returnByValue: true,
			});
			assertOperation();
			if (selected?.result?.value !== true) throw new Error("interaction select option not found");
		} else {
			const direction = payload.direction === "up" ? "up" : payload.direction === "down" ? "down" : undefined;
			if (!direction) throw new Error("interaction scroll direction invalid");
			const amount = Number.isSafeInteger(payload.amount) && payload.amount >= 1 && payload.amount <= 100_000 ? payload.amount : 600;
			let scrollObjectId;
			if (Number.isSafeInteger(target.scrollBackendNodeId)) {
				const resolved = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "DOM.resolveNode", { backendNodeId: target.scrollBackendNodeId }), SCROLL_EFFECT_WAIT_MS);
				if (resolved.ok && typeof resolved.value?.object?.objectId === "string") scrollObjectId = resolved.value.object.objectId;
			}
			const beforeMeasured = scrollObjectId === undefined ? { ok: false } : await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", {
				objectId: scrollObjectId,
				functionDeclaration: "function(){const target=this.nodeType===9?this.scrollingElement:this;return Number(target?.scrollTop)||0;}",
				returnByValue: true,
			}), SCROLL_EFFECT_WAIT_MS);
			const beforeResult = beforeMeasured.ok ? beforeMeasured.value : undefined;
			const point = await dispatchPoint(target.debuggee, target.parsed?.backendNodeId, SCROLL_TARGET_WAIT_MS, target.parsed !== undefined, target.parsed !== undefined, assertOperation);
			await assertOwned(item);
			assertOperation();
			const wheel = await withFocusEmulation(target.debuggee, async () => {
				assertOperation();
				let dispatchError;
				const dispatchPromise = chrome.debugger.sendCommand(target.debuggee, "Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: direction === "down" ? amount : -amount, button: "none", pointerType: "mouse" }).catch((error) => { dispatchError = error; return undefined; });
				const dispatched = await valueWithinRelayDeadline(dispatchPromise, SCROLL_DISPATCH_WAIT_MS);
				if (dispatchError) throw dispatchError;
				let afterResult;
				if (dispatched.ok && scrollObjectId !== undefined) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					const measured = await valueWithinRelayDeadline(chrome.debugger.sendCommand(target.debuggee, "Runtime.callFunctionOn", { objectId: scrollObjectId, functionDeclaration: "function(){const target=this.nodeType===9?this.scrollingElement:this;return Number(target?.scrollTop)||0;}", returnByValue: true }), SCROLL_EFFECT_WAIT_MS);
					if (measured.ok) afterResult = measured.value;
				}
				return { dispatched, afterResult };
			}, assertOperation);
			assertOperation();
			const { dispatched, afterResult } = wheel;
			const before = Number(beforeResult?.result?.value);
			const after = Number(afterResult?.result?.value);
			effect = { dispatch: "mouseWheel", dispatchSettled: dispatched.ok, x: point.x, y: point.y, scrollBefore: Number.isFinite(before) ? before : null, scrollAfter: Number.isFinite(after) ? after : null, moved: Number.isFinite(before) && Number.isFinite(after) ? before !== after : null, scrollTargetRef: target.scrollTargetRef, scrollScope: target.scrollScope };
		}
	};
	const raced = await Promise.race([
		dispatchAction().then(() => ({ settled: true })),
		(async () => {
			for (let attempt = 0; attempt < 120; attempt += 1) {
				const dialog = dialogState.get(item.tabId);
				if (dialog !== undefined) return { dialog };
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return { settled: true };
		})(),
	]);
	if (raced.dialog !== undefined) {
		await assertOwned(item);
		const tab = await chrome.tabs.get(item.tabId);
		assertOperation();
		return {
			schemaVersion: 1,
			kind: "rotom-browser-interaction-result",
			actionId: safeString(payload.actionId, "actionId", 128),
			action: target.action,
			acknowledged: true,
			effect: { ...(effect ?? {}), dispatchSettled: false, dialogOpened: true, dialog: { type: raced.dialog.type, message: raced.dialog.message, ...(raced.dialog.sensitive ? { sensitive: true } : {}) } },
			// The tree is unreadable while suspended: explicitly empty, not stale.
			readback: observationValue(name, item, tab, [], true),
		};
	}
	if (target.action !== "scroll") {
		await new Promise((resolve) => setTimeout(resolve, 150));
		assertOperation();
		const stateAfter = await interactionTargetState(target.debuggee, stateObjectId, assertOperation);
		const change = interactionTargetChange(stateBefore, stateAfter);
		const expectationResult = evaluateInteractionExpectation(expectation, stateAfter);
		effect = {
			...(effect ?? {}),
			target: { observed: stateAfter !== undefined, changed: change.changed, ...(change.transitions.length ? { transitions: change.transitions } : {}) },
			...(expectationResult ? { expectation: expectationResult } : {}),
		};
	}
	assertOperation();
	let readback;
	try { readback = await boundedInteractionReadback(name, item, assertOperation); }
	catch {
		const tab = await chrome.tabs.get(item.tabId);
		assertOperation();
		readback = observationValue(name, item, tab, [], true);
	}
	assertOperation();
	return {
		schemaVersion: 1,
		kind: "rotom-browser-interaction-result",
		actionId: safeString(payload.actionId, "actionId", 128),
		action: target.action,
		acknowledged: true,
		...(effect ? { effect } : {}),
		readback,
	};
}
/**
 * Resolve where a history navigation would land, so a child agent's lease can be
 * checked before the tab leaves the sites it was granted.
 */
async function navigationDestinationV1(debuggee, payload) {
	if (payload.url !== undefined) return { kind: "url", url: safeUrl(payload.url) };
	const history = await globalThis.chrome.debugger.sendCommand(debuggee, "Page.getNavigationHistory");
	const entries = Array.isArray(history?.entries) ? history.entries : [];
	const index = Number.isInteger(history?.currentIndex) ? history.currentIndex : -1;
	if (index < 0 || index >= entries.length) throw new Error("browser navigate history unavailable");
	if (payload.history === "reload") {
		const current = entries[index];
		if (typeof current?.url !== "string") throw new Error("browser navigate history unavailable");
		return { kind: "reload", url: safeUrl(current.url) };
	}
	const target = payload.history === "back" ? entries[index - 1] : payload.history === "forward" ? entries[index + 1] : undefined;
	if (!target) throw new Error(payload.history === "back" ? "没有可后退的历史记录" : "没有可前进的历史记录");
	if (typeof target.url !== "string") throw new Error("browser navigate history unavailable");
	return { kind: "history", url: safeUrl(target.url), entryId: target.id };
}
/** The lease is client-side, so the client sends the origins it may reach. */
function navigationAllowedV1(allowedOrigins, url) {
	if (allowedOrigins === undefined) return { ok: true };
	let origin;
	try { origin = new URL(url).origin; } catch { return { ok: false, origin: "" }; }
	return allowedOrigins.includes(origin) ? { ok: true } : { ok: false, origin };
}
async function navigateOwned(name, item, payload, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const allowedOrigins = payload.allowedOrigins === undefined ? undefined : payload.allowedOrigins;
	if (allowedOrigins !== undefined && (!Array.isArray(allowedOrigins) || allowedOrigins.length > 64 || allowedOrigins.some((origin) => typeof origin !== "string" || origin.length > 256))) throw new Error("navigate allowedOrigins invalid");
	await attach(item, assertOperation);
	await assertOwnedWithin(item, assertOperation);
	const debuggee = { tabId: item.tabId };
	const destination = await navigationDestinationV1(debuggee, payload);
	assertOperation();
	const allowed = navigationAllowedV1(allowedOrigins, destination.url);
	if (!allowed.ok) return { schemaVersion: 1, kind: "needs-approval", origin: allowed.origin, capability: "open", reason: "origin", message: `当前 lease 未授权导航到 ${allowed.origin || "(未知来源)"}；该操作没有发出请求，需要父 agent 更新 lease 后重试。` };
	// Bump here, and record the destination before dispatching, so tabs.onUpdated does not
	// count the same navigation a second time. Refs and coordinates from the old document
	// are invalid from this point on; reload changes no URL and needs our own bump.
	item.documentGeneration = Number.isSafeInteger(item.documentGeneration) && item.documentGeneration > 0 ? item.documentGeneration + 1 : 2;
	invalidateCoordinateObservation(item);
	item.url = destination.url;
	item.status = "loading";
	if (destination.kind === "url") await chrome.debugger.sendCommand(debuggee, "Page.navigate", { url: destination.url });
	else if (destination.kind === "reload") await chrome.debugger.sendCommand(debuggee, "Page.reload", { ignoreCache: false });
	else await chrome.debugger.sendCommand(debuggee, "Page.navigateToHistoryEntry", { entryId: destination.entryId });
	assertOperation();
	const timeoutMs = Number.isInteger(payload.timeoutMs) && payload.timeoutMs >= 0 && payload.timeoutMs <= 300_000 ? payload.timeoutMs : 30_000;
	try { return await waitForTab(name, item, { status: "complete", timeoutMs }, assertOperation); }
	catch (error) {
		// The command was accepted; a slow page is a timeout, not a refusal.
		if (error instanceof Error && error.message === "browser wait timeout") throw new Error("browser navigate 后页面未在超时内到 complete；documentGeneration 已更新，请用只读 snapshot/read_full 核对当前页面");
		throw error;
	}
}
async function waitForTab(name, item, payload, assertSession) {
	const chrome = operationChrome(globalThis.chrome, assertSession);
	const timeoutMs = Number.isInteger(payload.timeoutMs) && payload.timeoutMs >= 0 && payload.timeoutMs <= 300_000 ? payload.timeoutMs : 30_000;
	const expectedStatus = payload.status === undefined ? "complete" : payload.status;
	if (expectedStatus !== "complete" && expectedStatus !== "loading") throw new Error("wait status invalid");
	const expectedUrl = payload.url === undefined ? undefined : safeUrl(payload.url);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		assertSession();
		const tab = await chrome.tabs.get(item.tabId);
		if (!tab) throw new Error("owned tab lost");
		const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
		if (!target || typeof target.url !== "string") throw new Error("owned debugger target identity changed");
		const statusMatches = (tab.status === "complete" ? "complete" : "loading") === expectedStatus;
		const urlMatches = expectedUrl === undefined || reportableRelayUrl(target.url) === expectedUrl;
		if (statusMatches && urlMatches) {
			assertSession();
			const result = await observation(name, item, assertSession);
			assertSession();
			return result;
		}
		if (Date.now() >= deadline) throw new Error("browser wait timeout");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
async function tabStatusValue(state, name, item, targets, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	const target = targets.find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
	let targetUrl;
	if (target && typeof target.url === "string") {
		try { targetUrl = safeUrl(target.url); } catch { /* unsupported navigation remains owned but detached */ }
	}
	const listed = listedOwnedTabStatus({ name, item, tab, targetUrl, targetAttached: target?.attached, currentTabName: state.currentTabName });
	assertOperation();
	Object.assign(item, listed.state);
	if (targetUrl === undefined) childSessionsByTabId.delete(item.tabId);
	return listed.value;
}
/**
 * A suspended tab cannot answer anything except the operations that can resolve the
 * dialog or leave the tab. Checked here, before any CDP command is dispatched.
 */
function dialogGateV1(state, operation, payload) {
	if (operation === "interact" && payload?.action === "dialog") return undefined;
	let tabId;
	let name;
	try {
		name = typeof payload?.tabName === "string" ? payload.tabName
			: DIALOG_CURRENT_TAB_OPERATIONS_V1.includes(operation) ? state.currentTabName : undefined;
		if (typeof name !== "string") return undefined;
		tabId = owned(state, name).item.tabId;
	} catch { return undefined; }
	const blocked = dialogState.blocking(operation, tabId);
	return blocked === undefined ? undefined : { ...blocked, tabName: name };
}
async function handleOperation(state, operation, payload, expectedEpoch, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const assertOwned = (item) => assertOwnedWithin(item, assertOperation);
	assertOperation();
	if (!record(payload)) throw new Error("payload invalid");
	const dialogBlocked = dialogGateV1(state, operation, payload);
	if (dialogBlocked !== undefined) return dialogBlocked;
	if (operation === "hello") {
		const nonce = safeString(payload.nonce, "nonce", 128);
		Object.assign(state, sessionPrincipalFromHello(payload, state.sessionId));
		// Lease-driven in T9; until then the launcher passes it through the environment.
		state.keepTabs = payload.keepTabs === true;
		// Downloads: the main agent may always; a child only after it declared a lease that
		// allows it (see the interact path). Persisted so a page-initiated download that
		// arrives before the next interact still follows the last known answer.
		if (state.leaseToken === undefined) state.allowDownload = true;
		// Never trust the client's numbers: an unusable value falls back to the defaults.
		state.tabQuotas = sanitizeBrowserTabQuotasV1(payload.tabQuotas) ?? { ...DEFAULT_BROWSER_TAB_QUOTAS_V1 };
		await persistState();
		return { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 21, nonce, ...sessionPrincipalValue(state), capabilities: ["tab-control", "claim-user-tabs", "handoff-user-tabs", "agent-tab-groups", "accessibility-snapshot", "rendered-document-text", "full-document-read", "virtualized-frame-scroll", "content-coverage", "oopif-accessibility", "screenshot", "direct-interaction", "cdp-mouse", "coordinate-click", "targeted-scroll", "interaction-target-state", "page-alert-readback", "targeted-keypress", "snapshot-query", "operation-deadline", "non-destructive-timeout", "in-place-recovery", "multi-client-multiplex", "cross-agent-transfer"] };
	}
	if (operation === "open") {
		const name = safeName(payload.tabName);
		if (state.tabsByName.has(name)) throw new Error("owned tab name already exists");
		const url = safeUrl(payload.url);
		if (payload.placement !== undefined && payload.placement !== "background-tab" && payload.placement !== "agent-window") throw new Error("open placement invalid");
		// Counted here because only the service worker sees every session.
		assertTabQuotaAllowed(state, itemOriginV1(url));
		// Capture a newly created ID even if its request retires while Chrome is
		// creating it. It has not yet been made available for any other owner.
		assertOperation();
		const tab = payload.placement === "agent-window" ? await createAgentWindowTab(state, url) : await globalThis.chrome.tabs.create({ url, active: false });
		if (!Number.isInteger(tab.id)) throw new Error("tab creation failed");
		try { assertOperation(); } catch (error) {
			if (!allSessionItems().some((item) => item.tabId === tab.id) && !tabReservations.has(tab.id)) {
				tabReservations.add(tab.id);
				try { await globalThis.chrome.tabs.remove(tab.id); }
				finally { tabReservations.delete(tab.id); }
			}
			throw error;
		}
		const item = { tabId: tab.id, documentGeneration: 1, url, status: tab.status === "complete" ? "complete" : "loading", ownership: "agent", attached: false, detached: false, restoreAutoDiscardable: await protectFromDiscard(globalThis.chrome, tab.id) };
		state.tabsByName.set(name, item);
		state.currentTabName = name;
		try {
			await placeInSharedAgentGroup(tab, assertOperation);
			await attach(item, assertOperation);
			// The agent's own tab captures console from the start; a claimed user tab
			// only starts when someone asks for it.
			await enableConsoleCapture(item, assertOperation);
			await enableNetworkCapture(item, assertOperation);
			assertOperation();
			if (state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay session changed during tab creation");
			await persistState();
			if (state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay session changed during tab persistence");
		}
		catch (error) {
			// Grouping/attach fail with unrelated-looking errors when something else closed the
			// tab (e.g. a duplicate-tab extension when the URL is already open). Name that case.
			const vanished = await globalThis.chrome.tabs.get(tab.id).then(() => false, isMissingChromeTabError);
			await closeOwnedIdentity(state, name, tab.id, item, assertOperation);
			if (vanished) throw new Error("Chrome closed the new tab right after it was created; another extension (for example a duplicate-tab manager, if this URL is already open) may have closed it", { cause: error });
			throw error;
		}
		return observation(name, item, assertOperation);
	}
	if (operation === "discover") {
		const ownedIds = new Set([...allSessionItems().map((item) => item.tabId), ...tabReservations]);
		const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((tab) => Number.isInteger(tab.id) && !ownedIds.has(tab.id) && typeof tab.url === "string" && reportableRelayUrl(tab.url) !== undefined).slice(0, 50).map((tab) => {
			const openerTabId = recordedOpenerTabId(spawnedTabOpeners, tab);
			return { tabId: tab.id, url: safeUrl(tab.url), title: boundedText(tab.title, 512), status: tab.status === "complete" ? "complete" : "loading", browserActive: tab.active === true, ...(openerTabId === undefined ? {} : { openerOwnedByYou: sessionOwnsTabId(state, openerTabId) }) };
		});
		return { schemaVersion: 1, kind: "rotom-browser-discovered-tabs", tabs };
	}
	if (operation === "claim") {
		const name = safeName(payload.tabName);
		if (state.tabsByName.has(name)) throw new Error("owned tab name already exists");
		if (!Number.isInteger(payload.tabId) || payload.tabId < 0) throw new Error("tabId invalid");
		if (tabReservations.has(payload.tabId) || allSessionItems().some((item) => item.tabId === payload.tabId)) throw new Error("tab already owned by another relay session");
		tabReservations.add(payload.tabId);
		try {
			const tab = await chrome.tabs.get(payload.tabId);
			if (!tab || typeof tab.url !== "string") throw new Error("claim tab unavailable");
			const openerTabId = recordedOpenerTabId(spawnedTabOpeners, tab);
			const openerOwner = openerTabId === undefined ? undefined : sessionOwningTabId(openerTabId);
			if (openerOwner !== undefined && openerOwner !== state) throw new Error("tab was opened from another relay session's tab; only its opener may claim it");
			const url = safeUrl(tab.url);
			// A claimed tab also occupies a slot: per-agent and global limits would be
			// meaningless if only `open` respected them.
			assertTabQuotaAllowed(state, itemOriginV1(url));
			const item = { tabId: tab.id, documentGeneration: 1, url, status: tab.status === "complete" ? "complete" : "loading", ownership: "claimed", attached: false, detached: false, restoreAutoDiscardable: await protectFromDiscard(globalThis.chrome, tab.id) };
			assertOperation();
			state.tabsByName.set(name, item);
			state.currentTabName = name;
			try { await attach(item, assertOperation); await persistState(); assertOperation(); }
			catch (error) { await closeOwnedIdentity(state, name, tab.id, item, assertOperation); throw error; }
			return observation(name, item, assertOperation);
		} finally { tabReservations.delete(payload.tabId); }
	}
	if (operation === "transfer") {
		const { name, item } = owned(state, payload.tabName);
		const target = transferTargetSessionV1(sessionStates.values(), { rootSessionId: state.rootSessionId, toAgentId: payload.toAgentId });
		if (target === state) throw new Error("cannot transfer a tab to its current session");
		const nextName = transferredTabNameV1(name, state.agentId);
		if (target.tabsByName.has(nextName)) throw new Error("target relay session already owns that tab name");
		assertOperation();
		state.tabsByName.delete(name);
		if (state.currentTabName === name) state.currentTabName = state.tabsByName.keys().next().value;
		// Ownership history survives the move: T5 hands transferred tabs back to the
		// root session's main agent, and a claimed user tab must never be closed.
		item.transferredFrom = state.agentId;
		resetTransferredItemV1(item);
		forgetConsoleTabV1(item.tabId);
		target.tabsByName.set(nextName, item);
		await persistState();
		assertOperation();
		return { schemaVersion: 1, kind: "rotom-browser-transfer", tabName: nextName, from: state.agentId, to: target.agentId, documentGeneration: item.documentGeneration, observationEpoch: item.observationEpoch };
	}
	if (operation === "tabs") {
		const tabs = await collectListedOwnedTabs({
			entries: [...state.tabsByName],
			assertOperation,
			currentTabName: state.currentTabName,
			getTargets: () => chrome.debugger.getTargets(),
			getTab: (tabId) => chrome.tabs.get(tabId),
			normalizeUrl: safeUrl,
			onDetached: (item) => childSessionsByTabId.delete(item.tabId),
		});
		await persistState();
		// A dialog is tab state the client cannot see otherwise; `tabs` stays exempt so
		// the agent can always find out which tabs are blocked.
		const withDialogs = tabs.map((tab) => {
			const dialog = dialogState.get(tab.tabId);
			return dialog === undefined ? tab : { ...tab, dialog };
		});
		return { schemaVersion: 1, kind: "rotom-browser-tabs", ...sessionPrincipalValue(state), tabs: withDialogs };
	}
	if (operation === "switch") {
		const { name, item } = owned(state, payload.tabName);
		state.currentTabName = name;
		await persistState();
		assertOperation();
		return observation(name, item, assertOperation);
	}
	if (operation === "snapshot") { const { name, item } = owned(state, payload.tabName); return observation(name, item, assertOperation, payload); }
	if (operation === "read_full") { const { name, item } = owned(state, payload.tabName); return fullObservation(name, item, assertOperation); }
	if (operation === "console") {
		const { name, item } = owned(state, payload.tabName);
		const level = payload.level === undefined ? undefined : sanitizeConsoleLevelV1(payload.level);
		if (payload.level !== undefined && level === undefined) throw new Error("console level invalid");
		const pattern = payload.pattern === undefined ? undefined : sanitizeConsolePatternV1(payload.pattern);
		if (payload.pattern !== undefined && pattern === undefined) throw new Error("console pattern invalid");
		const limit = sanitizeConsoleLimitV1(payload.limit);
		if (limit === undefined) throw new Error("console limit invalid");
		const sinceCursor = parseConsoleCursorV1(payload.sinceCursor);
		if (sinceCursor === undefined) throw new Error("console sinceCursor invalid");
		// A claimed tab starts capturing on the first console call, not on claim.
		await attach(item, assertOperation);
		await enableConsoleCapture(item, assertOperation);
		const page = consoleCapture.read(item.tabId, { level, pattern, limit, sinceCursor });
		return {
			schemaVersion: 1,
			kind: "rotom-browser-console",
			tabName: name,
			tabId: item.tabId,
			documentGeneration: item.documentGeneration,
			captureSince: new Date(page.captureSince).toISOString(),
			dropped: page.dropped,
			retained: page.retained,
			entries: page.entries,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		};
	}
	if (operation === "network") {
		const { name, item } = owned(state, payload.tabName);
		if (payload.failedOnly !== undefined && typeof payload.failedOnly !== "boolean") throw new Error("network failedOnly invalid");
		const pattern = payload.pattern === undefined ? undefined : sanitizeNetworkPatternV1(payload.pattern);
		if (payload.pattern !== undefined && pattern === undefined) throw new Error("network pattern invalid");
		const resourceType = payload.resourceType === undefined ? undefined : sanitizeNetworkResourceTypeV1(payload.resourceType);
		if (payload.resourceType !== undefined && resourceType === undefined) throw new Error("network resourceType invalid");
		const limit = sanitizeNetworkLimitV1(payload.limit);
		if (limit === undefined) throw new Error("network limit invalid");
		const sinceCursor = parseNetworkCursorV1(payload.sinceCursor);
		if (sinceCursor === undefined) throw new Error("network sinceCursor invalid");
		await attach(item, assertOperation);
		await enableNetworkCapture(item, assertOperation);
		const page = networkCapture.read(item.tabId, { failedOnly: payload.failedOnly === true, pattern, resourceType, limit, sinceCursor });
		return {
			schemaVersion: 1,
			kind: "rotom-browser-network",
			tabName: name,
			tabId: item.tabId,
			captureSince: new Date(page.captureSince).toISOString(),
			dropped: page.dropped,
			retained: page.retained,
			entries: page.entries,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		};
	}
	if (operation === "wait") {
		const { name, item } = owned(state, payload.tabName);
		return waitForTab(name, item, payload, assertOperation);
	}
	if (operation === "navigate") {
		const { name, item } = owned(state, payload.tabName);
		if (payload.url !== undefined && payload.history !== undefined) throw new Error("navigate 只能给 url 或 history 之一");
		if (payload.url === undefined && payload.history !== "back" && payload.history !== "forward" && payload.history !== "reload") throw new Error("navigate 需要 url 或 history: back/forward/reload");
		return navigateOwned(name, item, payload, assertOperation);
	}
	if (operation === "screenshot") {
		const { name, item } = owned(state, payload.tabName);
		await attach(item, assertOperation);
		await assertOwned(item);
		const debuggee = { tabId: item.tabId };
		const metricsBefore = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
		const captured = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", { format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false });
		const metricsAfter = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
		if (typeof captured?.data !== "string" || Math.ceil(captured.data.length * 3 / 4) > MAX_SCREENSHOT_BYTES) throw new Error("screenshot exceeds relay limit");
		const beforeViewport = coordinateViewport(metricsBefore);
		const afterViewport = coordinateViewport(metricsAfter);
		for (const key of ["width", "height", "pageX", "pageY", "scale"]) if (Math.abs(beforeViewport[key] - afterViewport[key]) > 0.5) throw new Error("screenshot viewport changed during capture");
		assertOperation();
		const binding = mintCoordinateObservation(item, metricsAfter);
		return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: name, tabId: item.tabId, documentGeneration: item.documentGeneration, observationEpoch: binding.observationEpoch, viewport: binding.viewport, mimeType: "image/jpeg", data: captured.data };
	}
	if (operation === "downloads") {
		// Read from Chrome, not from an in-memory buffer: a download outlives the worker.
		const agentId = state.agentId ?? DEFAULT_AGENT_ID;
		// Newest first, sorted here because Chrome rejects an `id` orderBy field.
		const found = await chrome.downloads.search({ limit: 200 });
		if (Array.isArray(found)) found.sort((left, right) => (right?.id ?? 0) - (left?.id ?? 0));
		assertOperation();
		const records = [];
		for (const item of Array.isArray(found) ? found : []) {
			const record = downloadRecordV1(item, agentId);
			if (record !== undefined) records.push(record);
			if (records.length >= MAX_DOWNLOAD_RECORDS_V1) break;
		}
		const blocked = (blockedDownloadsByAgentId.get(agentId) ?? []).slice(-MAX_DOWNLOAD_RECORDS_V1);
		return { schemaVersion: 1, kind: "rotom-browser-downloads", agentId, downloads: records, blocked };
	}
	if (operation === "devtools") {
		const { name, item } = owned(state, payload.tabName);
		const devtools = payload.devtools;
		const DEVTOOLS_OPERATIONS = ["evaluate", "viewport", "screenshot_export", "network_body", "trace_start", "trace_stop"];
		if (!DEVTOOLS_OPERATIONS.includes(devtools)) throw new Error("devtools operation invalid");
		const expression = devtools === "evaluate" ? sanitizeDevtoolsExpressionV1(payload.expression) : undefined;
		if (devtools === "evaluate" && expression === undefined) throw new Error("devtools expression invalid");
		const world = devtools === "evaluate" ? sanitizeDevtoolsWorldV1(payload.world) : undefined;
		if (devtools === "evaluate" && world === undefined) throw new Error("devtools world invalid");
		const viewport = devtools === "viewport" ? sanitizeViewportOverrideV1(payload.viewport) : undefined;
		if (devtools === "viewport" && viewport === undefined) throw new Error("devtools viewport invalid");
		const exportRequest = devtools === "screenshot_export" ? sanitizeExportRequestV1(payload) : undefined;
		if (devtools === "screenshot_export" && exportRequest === undefined) throw new Error("devtools screenshot request invalid");
		await attach(item, assertOperation);
		await assertOwned(item);
		const debuggee = { tabId: item.tabId };
		if (devtools === "evaluate") {
			// The isolated world is created per document; the main world is the default
			// execution context of the frame, so it needs no contextId.
			let contextId;
			if (world === "isolated") {
				await chrome.debugger.sendCommand(debuggee, "Page.enable");
				const tree = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Page.getFrameTree"), 4_000);
				const frameId = tree.ok ? tree.value?.frameTree?.frame?.id : undefined;
				if (typeof frameId !== "string") throw new Error("devtools frame unavailable");
				const created = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", { frameId, worldName: "rotom-devtools" }), 4_000);
				if (!created.ok || !Number.isInteger(created.value?.executionContextId)) throw new Error("devtools isolated world unavailable");
				contextId = created.value.executionContextId;
			}
			const evaluatedReply = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
				expression,
				...(contextId === undefined ? {} : { contextId }),
				returnByValue: true,
				awaitPromise: payload.awaitPromise !== false,
				userGesture: false,
			}), 12_000);
			// A timed-out evaluate may still have run: report it as unknown, not as empty.
			if (!evaluatedReply.ok) throw new Error("devtools evaluate timed out");
			assertOperation();
			const evaluated = devtoolsEvaluateRecordV1(evaluatedReply.value);
			return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "evaluate", tabName: name, tabId: item.tabId, documentGeneration: item.documentGeneration, world, ...evaluated };
		}
		if (devtools === "trace_start") {
			// A trace whose tab is gone can no longer be stopped: drop it instead of
			// blocking every later start for the rest of the worker's life.
			if (traceState.tabId !== undefined && !allSessionItems().some((candidate) => candidate.tabId === traceState.tabId)) {
				traceState.tabId = undefined;
				traceState.complete = undefined;
				traceState.stream = undefined;
			}
			if (traceState.tabId !== undefined) throw new Error(`devtools trace already running on tab ${traceState.tabId}`);
			await attach(item, assertOperation);
			await assertOwned(item);
			// Chrome rejects categories together with traceConfig: send only the config.
			await chrome.debugger.sendCommand(debuggee, "Tracing.start", { traceConfig: { includedCategories: TRACE_START_CATEGORIES, recordMode: "recordAsMuchAsPossible" }, transferMode: "ReturnAsStream" });
			assertOperation();
			traceState.tabId = item.tabId;
			traceState.startedAt = Date.now();
			traceState.stream = undefined;
			return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_start", tabName: name, tabId: item.tabId, startedAt: new Date(traceState.startedAt).toISOString(), categories: TRACE_START_CATEGORIES };
		}
		if (devtools === "trace_stop") {
			if (traceState.tabId !== item.tabId) throw new Error("devtools trace not running on this tab");
			const completed = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("devtools trace completion timed out")), 30_000);
				traceState.complete = (params) => { clearTimeout(timer); resolve(params); };
			});
			await chrome.debugger.sendCommand(debuggee, "Tracing.end");
			const params = await completed;
			traceState.tabId = undefined;
			traceState.complete = undefined;
			const handle = traceState.stream;
			traceState.stream = undefined;
			if (typeof handle !== "string") throw new Error("devtools trace stream missing");
			// Read the stream in bounded chunks; one IO.read of a 30 MB trace would be one
			// unbounded command.
			const parts = [];
			let total = 0;
			const encoder = new TextEncoder();
			for (;;) {
				const chunk = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "IO.read", { handle, size: TRACE_CHUNK_BYTES }), 10_000);
				if (!chunk.ok) throw new Error("devtools trace read timed out");
				const data = typeof chunk.value?.data === "string" ? chunk.value.data : "";
				const bytes = chunk.value?.base64Encoded === true ? bytesFromBase64V1(data) : encoder.encode(data);
				if (bytes.length > 0) { parts.push(bytes); total += bytes.length; }
				if (total > MAX_TRACE_BYTES) { await chrome.debugger.sendCommand(debuggee, "IO.close", { handle }).catch(() => undefined); throw new Error("devtools trace too large"); }
				if (chunk.value?.eof === true || bytes.length === 0) break;
			}
			await chrome.debugger.sendCommand(debuggee, "IO.close", { handle }).catch(() => undefined);
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const part of parts) { merged.set(part, offset); offset += part.length; }
			assertOperation();
			return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_stop", tabName: name, tabId: item.tabId, documentGeneration: item.documentGeneration, bytes: total, dataLossOccurred: params?.dataLossOccurred === true, traceBase64: base64FromBytesV1(merged) };
		}
		if (devtools === "network_body") {
			const requestId = safeString(payload.requestId, "network requestId", 256);
			await enableNetworkBodyCapture(item, assertOperation);
			const capture = networkCapture.read(item.tabId, { limit: 200 });
			const entry = capture.entries.find((candidate) => candidate.requestId === requestId);
			if (entry === undefined) throw new Error("network body unavailable: 只能读取启用 network_body 之后发出的请求，先从 network 取新的 requestId");
			const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : "";
			if (!NETWORK_BODY_TEXT_MIME.test(mimeType) && mimeType.length > 0) throw new Error(`network body not text: ${mimeType.slice(0, 64)}`);
			const fetched = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Network.getResponseBody", { requestId }), 6_000);
			if (!fetched.ok) throw new Error("network body unavailable: 响应体已不在缓冲区里");
			const body = fetched.value?.body;
			if (typeof body !== "string") throw new Error("network body unavailable: 响应体为空");
			if (fetched.value?.base64Encoded === true) throw new Error("network body not text: 响应体是二进制编码");
			if (body.includes("\u0000")) throw new Error("network body not text: 响应体含 NUL 字节");
			const bounded = boundDevtoolsTextV1(body, MAX_DEVTOOLS_RESULT_BYTES_V1);
			assertOperation();
			return {
				schemaVersion: 1,
				kind: "rotom-browser-devtools",
				devtools: "network_body",
				tabName: name,
				tabId: item.tabId,
				documentGeneration: item.documentGeneration,
				requestId,
				url: entry.url,
				status: entry.status,
				mimeType,
				resourceType: entry.resourceType,
				bodyText: bounded.text,
				truncated: bounded.truncated,
				bytes: bounded.bytes,
				captureSince: new Date(capture.captureSince).toISOString(),
				note: "only requests issued after network_body was first enabled can be read",
			};
		}
		if (devtools === "screenshot_export") {
			let clip;
			if (exportRequest.fullPage) {
				const metrics = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics"), 4_000);
				const size = metrics.ok ? metrics.value?.cssContentSize : undefined;
				const width = Math.ceil(size?.width ?? 0);
				const height = Math.ceil(size?.height ?? 0);
				if (!(width > 0 && height > 0)) throw new Error("devtools screenshot size unavailable");
				if (width > MAX_EXPORT_WIDTH_V1 || height > MAX_EXPORT_HEIGHT_V1) throw new Error("devtools screenshot too large");
				clip = { x: 0, y: 0, width, height, scale: 1 };
			}
			const captured = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
				format: exportRequest.format,
				...(exportRequest.format === "jpeg" ? { quality: exportRequest.quality } : {}),
				fromSurface: true,
				captureBeyondViewport: exportRequest.fullPage,
				...(clip === undefined ? {} : { clip }),
			}), 15_000);
			if (!captured.ok) throw new Error("devtools screenshot timed out");
			const data = captured.value?.data;
			if (typeof data !== "string" || data.length === 0) throw new Error("devtools screenshot data missing");
			// Exact decoded size: ceil(len*3/4) over-counts the base64 padding.
			const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
			const bytes = data.length / 4 * 3 - padding;
			if (bytes > MAX_SCREENSHOT_BYTES) throw new Error("devtools screenshot exceeds relay limit");
			assertOperation();
			return {
				schemaVersion: 1,
				kind: "rotom-browser-devtools",
				devtools: "screenshot_export",
				tabName: name,
				tabId: item.tabId,
				documentGeneration: item.documentGeneration,
				format: exportRequest.format,
				fullPage: exportRequest.fullPage,
				bytes,
				...(clip === undefined ? {} : { width: clip.width, height: clip.height }),
				data,
			};
		}
		if (viewport === "reset") {
			// width/height 0 is the documented way to disable the override; clearing alone
			// left the last size in place on this Chrome.
			await chrome.debugger.sendCommand(debuggee, "Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
			await chrome.debugger.sendCommand(debuggee, "Emulation.clearDeviceMetricsOverride").catch(() => undefined);
			await chrome.debugger.sendCommand(debuggee, "Emulation.setTouchEmulationEnabled", { enabled: false });
			// Chrome has no "clear UA" command; restore the browser's own UA instead of
			// sending an empty string, which it rejects as invalid.
			const version = await valueWithinRelayDeadline(chrome.debugger.sendCommand(debuggee, "Browser.getVersion"), 2_000);
			if (version.ok && typeof version.value?.userAgent === "string") await chrome.debugger.sendCommand(debuggee, "Emulation.setUserAgentOverride", { userAgent: version.value.userAgent });
		} else {
			await chrome.debugger.sendCommand(debuggee, "Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: viewport.mobile });
			await chrome.debugger.sendCommand(debuggee, "Emulation.setTouchEmulationEnabled", viewport.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
			if (viewport.userAgent !== undefined) await chrome.debugger.sendCommand(debuggee, "Emulation.setUserAgentOverride", { userAgent: viewport.userAgent });
		}
		// Every coordinate and viewport measurement taken before this call is void.
		invalidateCoordinateObservation(item);
		assertOperation();
		return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "viewport", tabName: name, tabId: item.tabId, documentGeneration: item.documentGeneration, observationEpoch: item.observationEpoch, ...viewportRecordV1(viewport) };
	}
	if (operation === "interact") { const { name, item } = owned(state, payload.tabName); return performInteraction(name, item, payload, assertOperation); }
	if (operation === "close") {
		if (payload.all === true) { const count = state.tabsByName.size; await closeAllOwned(state, assertOperation); return { schemaVersion: 1, kind: "rotom-browser-close", closed: count }; }
		const name = payload.tabName === undefined ? state.currentTabName : safeName(payload.tabName);
		if (!name) return { schemaVersion: 1, kind: "rotom-browser-close", closed: 0 };
		return { schemaVersion: 1, kind: "rotom-browser-close", closed: await closeOwned(state, name, assertOperation) ? 1 : 0 };
	}
	if (operation === "handoff") {
		const { name, item } = owned(state, payload.tabName);
		const tabId = item.tabId;
		if (item.ownership === "claimed") await releaseDiscardProtection(globalThis.chrome, item);
		const preserved = item.ownership === "claimed";
		await closeOwned(state, name, assertOperation);
		return { schemaVersion: 1, kind: "rotom-browser-handoff", tabName: name, tabId, preserved };
	}
	if (operation === "recover") {
		const { name, item } = owned(state, payload.tabName);
		try { await attach(item, assertOperation); assertOperation(); }
		catch (error) {
			assertOperation();
			item.attached = false;
			item.detached = true;
			await persistState();
			throw new Error(`browser recover failed for tab ${name}: ${publicError(error)}`);
		}
		const target = await tabStatusValue(state, name, item, await chrome.debugger.getTargets(), assertOperation);
		assertOperation();
		await persistState();
		assertOperation();
		return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [target] };
	}
	throw new Error("operation denied");
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function settleWithin(promise, timeoutMs = RELAY_SETTLE_MS) {
	await Promise.race([Promise.resolve(promise).catch(() => undefined), delay(timeoutMs)]);
}
async function detachItemsPreservingState(items) {
	for (const item of items) { childSessionsByTabId.delete(item.tabId); forgetConsoleTabV1(item.tabId); item.attached = false; item.detached = true; }
	await Promise.all(items.map(async (item) => {
		await settleWithin(chrome.debugger.detach({ tabId: item.tabId }));
	}));
	await settleWithin(persistState());
}
async function retireDisconnectedSession(state) {
	if (state.agentId === DEFAULT_AGENT_ID) { await detachAllOwnedPreservingState(state); return; }
	const main = connectedMainSessionForRoot(state.rootSessionId);
	const plan = sessionCleanupPlanV1({
		agentId: state.agentId,
		keepTabs: state.keepTabs === true,
		hasMainAgent: main !== undefined,
		tabs: [...state.tabsByName].map(([name, item]) => ({ name, item })),
		mainTaken: new Set(main?.tabsByName.keys() ?? []),
	});
	for (const { name } of plan.closes) await closeOwned(state, name);
	for (const { name, toName, item } of plan.handBacks) {
		state.tabsByName.delete(name);
		if (state.currentTabName === name) state.currentTabName = undefined;
		// Ownership history and fresh refs, exactly like an explicit transfer.
		item.transferredFrom = state.agentId;
		resetTransferredItemV1(item);
		// Console history belongs to the previous owner's document, not to the receiver.
		forgetConsoleTabV1(item.tabId);
		main.tabsByName.set(toName, item);
	}
	// Whatever stays open is detached and no longer claimed by this session, so the
	// tab becomes discoverable again instead of staying invisible forever.
	const detachItems = [];
	for (const { name } of plan.detaches) {
		const item = state.tabsByName.get(name);
		if (!item) continue;
		state.tabsByName.delete(name);
		if (state.currentTabName === name) state.currentTabName = undefined;
		detachItems.push(item);
	}
	for (const item of detachItems) await releaseDiscardProtection(globalThis.chrome, item);
	await detachItemsPreservingState(detachItems);
	state.keepTabs = false;
	await persistState();
}
async function detachAllOwnedPreservingState(state) { await detachItemsPreservingState([...state.tabsByName.values()]); }
async function resetAfterOperationTimeout(state, operation, targetItem) {
	if ((operation === "interact" || operation === "recover") && targetItem) {
		await detachItemsPreservingState([targetItem]);
		return;
	}
	await detachAllOwnedPreservingState(state);
}
async function handleOperationWithDeadline(state, operation, payload, expectedEpoch, scopeKey) {
	let targetItem;
	if (operation === "interact" || operation === "recover") {
		try { targetItem = owned(state, payload.tabName).item; } catch { /* handleOperation returns the authoritative error */ }
	}
	const operationGuard = createOperationGuard(state, expectedEpoch, scopeKey);
	const operationPromise = handleOperation(state, operation, payload, expectedEpoch, operationGuard.assert);
	const onTimeout = async () => {
		operationGuard.invalidate();
		await resetAfterOperationTimeout(state, operation, targetItem);
	};
	try { return await runWithRelayDeadline(operation, operationPromise, onTimeout, relayOperationDeadlineMs(operation, payload)); }
	finally { operationGuard.invalidate(); } // Retire bounded readback continuations even on success.
}
async function handleRequest(message, state, scopeKey) {
	if (message.operation === "hello") {
		if (state.generation && state.generation !== message.generation) {
			state.epoch += 1;
			await detachAllOwnedPreservingState(state);
		}
		state.generation = message.generation;
		await persistState();
	} else if (state.generation !== message.generation) {
		post({ schemaVersion: 1, kind: "response", id: message.id, sessionId: message.sessionId, generation: message.generation, ok: false, error: "session binding invalid" });
		return;
	}
	try {
		const expectedEpoch = state.epoch;
		const result = await handleOperationWithDeadline(state, message.operation, message.payload, expectedEpoch, scopeKey);
		if (state.epoch !== expectedEpoch || state.generation !== message.generation) throw new Error("session binding changed during operation");
		await postResponse({ schemaVersion: 1, kind: "response", id: message.id, sessionId: message.sessionId, generation: message.generation, ok: true, result });
	} catch (error) {
		post({ schemaVersion: 1, kind: "response", id: message.id, sessionId: message.sessionId, generation: message.generation, ok: false, error: publicError(error) });
	}
}
function runRelayRequest(state, message) {
	if (isSessionScopedOperationV1(message.operation)) return state.lock.write(() => handleRequest(message, state, "session")).catch(() => undefined);
	return state.lock.read(() => {
		// The lock scope doubles as the operation revision scope: concurrent reads of
		// different tabs must not retire each other.
		const scopeKey = `tab:${tabLockKeyV1(message.payload, state.currentTabName)}`;
		return state.tabLocks.run(scopeKey, () => handleRequest(message, state, scopeKey));
	}).catch(() => undefined);
}
function queueRelayRequest(message) {
	if (!record(message) || message.schemaVersion !== 1 || message.kind !== "request" || typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.generation !== "string" || typeof message.operation !== "string") return;
	let state = sessionStates.get(message.sessionId);
	if (!state) { state = createSessionState(message.sessionId); sessionStates.set(state.sessionId, state); }
	void runRelayRequest(state, message);
}
function clearReconnectSchedule() {
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
	void chrome.alarms.clear(NATIVE_RECONNECT_ALARM).catch(() => undefined);
}
function queueRelaySessionCleanup(sessionId, generation) {
	const state = sessionStates.get(sessionId);
	if (!state) return;
	const preInvalidated = state.generation === generation;
	if (preInvalidated) { state.epoch += 1; state.generation = undefined; }
	// Structural: it changes what the session owns, so it queues behind in-flight
	// tab operations and blocks the ones that would race with the detach.
	void state.lock.write(async () => {
		if (state.generation === generation) { state.epoch += 1; state.generation = undefined; }
		else if (!preInvalidated || state.generation !== undefined) return;
		await retireDisconnectedSession(state);
	}).catch(() => undefined);
}
function queueAllRelaySessionCleanup() {
	for (const state of sessionStates.values()) if (state.generation) queueRelaySessionCleanup(state.sessionId, state.generation);
}
function connectNative() {
	if (nativePort) return;
	try { nativePort = chrome.runtime.connectNative(HOST_NAME); }
	catch { scheduleReconnect(); return; }
	clearReconnectSchedule();
	nativePort.onMessage.addListener((message) => {
		if (message?.kind === "control" && message.operation === "client-disconnected" && typeof message.sessionId === "string" && typeof message.generation === "string") {
			queueRelaySessionCleanup(message.sessionId, message.generation);
			return;
		}
		queueRelayRequest(message);
	});
	nativePort.onDisconnect.addListener(() => {
		void chrome.runtime.lastError;
		nativePort = undefined;
		queueAllRelaySessionCleanup();
		scheduleReconnect();
	});
}
function scheduleReconnect() {
	if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connectNative(); }, 2_000);
	void chrome.alarms.create(NATIVE_RECONNECT_ALARM, { delayInMinutes: 0.5 }).catch(() => undefined);
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === NATIVE_RECONNECT_ALARM) connectNative(); });
// These two listeners are the only source of "user focus"; agent-caused changes are
// filtered out by the activity window above.
chrome.tabs.onActivated.addListener((info) => { focusCoordinator.recordActivation({ tabId: info?.tabId, windowId: info?.windowId }); });
chrome.windows.onFocusChanged.addListener((windowId) => { focusCoordinator.recordWindowFocus(windowId); });
chrome.tabs.onRemoved.addListener((tabId) => {
	childSessionsByTabId.delete(tabId);
	forgetConsoleTabV1(tabId);
	forgetSpawnedTab(spawnedTabOpeners, tabId);
	for (const state of sessionStates.values()) for (const [name, item] of state.tabsByName) if (item.tabId === tabId) {
		state.tabsByName.delete(name);
		retireOwnedTabName(state.retiredTabNames, name, "Chrome closed the tab (user, page script or browser)");
		if (state.currentTabName === name) state.currentTabName = undefined;
	}
	void persistState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	for (const item of allSessionItems()) {
		if (item.tabId !== tabId) continue;
		if (applyOwnedTabUpdate(item, changeInfo)) invalidateCoordinateObservation(item);
	}
	void persistState();
});
// One trace at a time for the whole browser: Chrome's tracing is a browser-wide session,
// so two agents asking for overlapping traces would silently mix their events.
const traceState = { tabId: undefined, startedAt: 0, complete: undefined, stream: undefined };
const TRACE_CHUNK_BYTES = 1024 * 1024;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const TRACE_START_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing", "loading", "v8.execute"];
chrome.debugger.onEvent.addListener((source, method, params) => {
	if (!Number.isInteger(source.tabId)) return;
	if (method === "Tracing.tracingComplete") {
		if (traceState.tabId === source.tabId && traceState.complete !== undefined) {
			traceState.stream = typeof params?.stream === "string" ? params.stream : undefined;
			traceState.complete(params);
			traceState.complete = undefined;
		}
	}
	if (method === "Page.windowOpen") {
		const guard = windowOpenGuardsByTabId.get(source.tabId);
		if (guard) guard.signals.push({ timestamp: Date.now(), url: typeof params?.url === "string" ? params.url : "", used: false });
	}
	if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown" || method === "Log.entryAdded") recordConsoleEvent(source.tabId, method, params);
	if (method === "Input.dragIntercepted") {
		const slot = dragInterceptionByTabId.get(source.tabId);
		if (slot && params?.data !== undefined) slot.data = params.data;
	}
	if (method === "Network.requestWillBeSent" || method === "Network.responseReceived" || method === "Network.loadingFinished" || method === "Network.loadingFailed") recordNetworkEvent(source.tabId, method, params);
	if (method === "Page.javascriptDialogOpening") dialogState.opened(source.tabId, params);
	if (method === "Page.javascriptDialogClosed") {
		const closed = dialogState.closed(source.tabId);
		if (closed) dialogLastClosedByTabId.set(source.tabId, { ...closed, accepted: params?.result === true, userInput: typeof params?.userInput === "string" ? params.userInput : "" });
	}
	if (method === "Target.attachedToTarget") registerChildSession(source.tabId, params);
	if (method === "Target.detachedFromTarget") removeChildSession(source.tabId, params?.sessionId);
	if (method === "Page.frameNavigated" && typeof source.sessionId === "string") rotateChildSessionScope(source.tabId, source.sessionId);
});
chrome.debugger.onDetach.addListener((source) => {
	if (!Number.isInteger(source.tabId)) return;
	childSessionsByTabId.delete(source.tabId);
	for (const item of allSessionItems()) if (item.tabId === source.tabId) { item.detached = true; item.attached = false; invalidateCoordinateObservation(item); }
});
// Downloads refused because the child lease has no `allow.download`. Memory-only: the
// refusal is a signal for the current session, not a history to resurrect.
const blockedDownloadsByAgentId = new Map();
function recordBlockedDownloadV1(agentId, reason) {
	const list = blockedDownloadsByAgentId.get(agentId) ?? [];
	list.push({ reason, at: Date.now() });
	if (list.length > MAX_DOWNLOAD_RECORDS_V1) list.splice(0, list.length - MAX_DOWNLOAD_RECORDS_V1);
	blockedDownloadsByAgentId.set(agentId, list);
}
/**
 * Redirect only downloads started by an agent-owned tab into `rotom/<agentId>/`.
 *
 * Anything ambiguous or foreign is left alone: the listener returns without calling
 * `suggest()`, so Chrome keeps the page's suggested name and the user's own layout.
 */
async function onDeterminingFilenameV1(item, suggest) {
	try {
		// Claimed tabs are included so the owner lookup can see that the page is the user's.
		const ownedTabs = [...sessionStates.values()].flatMap((state) => [...state.tabsByName.values()].map((ownedItem) => ({
			ownership: ownedItem.ownership,
			tabId: ownedItem.tabId,
			url: ownedItem.url,
			agentId: state.agentId ?? DEFAULT_AGENT_ID,
			// The main agent always may download; a child may only after it declared a lease
			// that allows it, so an undeclared child is a refusal, not a default yes.
			allowDownload: state.leaseToken === undefined ? true : state.allowDownload === true,
		})));
		const agentId = downloadOwnerAgentIdV1({ tabId: item?.tabId, referrer: item?.referrer }, ownedTabs);
		if (agentId === undefined) return;
		const owner = ownedTabs.find((candidate) => candidate.agentId === agentId);
		if (owner && owner.allowDownload === false) {
			recordBlockedDownloadV1(agentId, "download");
			try { await chrome.downloads.cancel(item.id); } catch { /* already gone */ }
			return;
		}
		const filename = downloadRelativeFilenameV1({ agentId, suggestedFilename: typeof item?.filename === "string" ? item.filename : "" });
		if (filename === undefined) return;
		suggest({ filename, conflictAction: "uniquify" });
	} catch { /* never block a download because our own bookkeeping failed */ }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
	if (!item || item.byExtensionId === chrome.runtime.id) return false;
	// Must answer synchronously; the async work below resolves before Chrome gives up.
	void onDeterminingFilenameV1(item, suggest);
	return true;
});
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
chrome.action.onClicked.addListener(connectNative);

async function startRelay() {
	try { await restoreState(); }
	catch { /* invalid or unavailable session state starts from an empty relay */ }
	connectNative();
}

void startRelay();
