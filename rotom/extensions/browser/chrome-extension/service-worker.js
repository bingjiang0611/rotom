import { observedInteractionNode } from "./interaction-observation.js";
import { coordinateViewport, invalidateCoordinateObservation, mintCoordinateObservation, validateCoordinateBinding, validateCoordinateHit } from "./coordinate-click.js";
import { interactionScrollTarget } from "./interaction-scroll-target.js";
import { createOperationGuard } from "./operation-guard.js";
import { operationChrome } from "./operation-chrome.js";
import { consumeMatchingWindowOpenSignal } from "./window-open-correlation.js";
import { relayOperationDeadlineMs, runWithRelayDeadline, valueWithinRelayDeadline } from "./relay-deadline.js";
import { mergeRenderedText, scrollableTextTargets, scrollTargetState, scrollTargetTo } from "./full-read.js";
import { collectRenderedText, utf8TextChunks } from "./rendered-text.js";
import { collectPageAlerts, MAX_PAGE_ALERTS, pageAlertNodes } from "./page-alerts.js";
import { evaluateInteractionExpectation, interactionTargetChange, parseInteractionExpectation, readInteractionTargetState } from "./interaction-target-state.js";
import { formatScopedAxRef, parseScopedAxRef } from "./scoped-ax-ref.js";
import { placeAgentTabsInSharedGroup } from "./shared-tab-group.js";
import { collectListedOwnedTabs, isMissingChromeTabError, listedOwnedTabStatus } from "./tab-list-status.js";

const HOST_NAME = "dev.rotom.browser_relay";
const MAX_NATIVE_BYTES = 1024 * 1024;
const MAX_AX_NODES = 600;
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
let nativePort;
let reconnectTimer;
let persistChain = Promise.resolve();
let tabGroupChain = Promise.resolve();

function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeString(value, name, max = 256) {
	if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) throw new Error(`${name} invalid`);
	return value;
}
function safeName(value) {
	const name = safeString(value, "tabName", 64);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error("tabName format invalid");
	return name;
}
function safeUrl(value) {
	const raw = safeString(value, "url", 4096);
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url scheme denied");
	if (url.username || url.password) throw new Error("url userinfo denied");
	return url.href;
}
function boundedText(value, max = MAX_NAME_CHARS) {
	return typeof value === "string" ? value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "") : "";
}
function publicError(error) {
	if (error instanceof Error) {
		if (/tab|url|session|timeout|debugger|navigation|relay|screenshot|snapshot|operation|owned|interaction|target|ref|download/iu.test(error.message)) return error.message.slice(0, 512);
	}
	return "browser relay operation failed";
}
function post(message) {
	const encoded = JSON.stringify(message);
	if (new TextEncoder().encode(encoded).length > MAX_NATIVE_BYTES) throw new Error("native message too large");
	nativePort?.postMessage(message);
}
function createSessionState(sessionId) {
	return { sessionId: safeString(sessionId, "sessionId", 512), generation: undefined, epoch: 0, operationRevision: 0, currentTabName: undefined, tabsByName: new Map(), operationChain: Promise.resolve() };
}
function allSessionItems() {
	return [...sessionStates.values()].flatMap((state) => [...state.tabsByName.values()]);
}
function findSessionItemByTabId(tabId) {
	for (const state of sessionStates.values()) for (const item of state.tabsByName.values()) if (item.tabId === tabId) return item;
}
async function placeInSharedAgentGroup(tab, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const pending = tabGroupChain.catch(() => undefined).then(() => placeAgentTabsInSharedGroup({
		createdTab: tab,
		items: allSessionItems(),
		queryTabs: (query) => chrome.tabs.query(query),
		groupTabs: (options) => chrome.tabs.group(options),
		updateGroup: (groupId, options) => chrome.tabGroups.update(groupId, options),
	}));
	tabGroupChain = pending.catch(() => undefined);
	await pending;
}
async function persistState() {
	persistChain = persistChain.catch(() => undefined).then(() => chrome.storage.session.set({
		browserRelayStateV2: {
			schemaVersion: 2,
			sessions: [...sessionStates.values()].map((state) => ({
				sessionId: state.sessionId,
				generation: state.generation,
				currentTabName: state.currentTabName,
				tabs: [...state.tabsByName.entries()].map(([name, item]) => ({ name, tabId: item.tabId, targetId: item.targetId, documentGeneration: item.documentGeneration, url: item.url, status: item.status, ownership: item.ownership })),
			})),
		},
	}));
	await persistChain;
}
async function restoreState() {
	const storedValues = await chrome.storage.session.get(["browserRelayStateV2", "browserRelayStateV1"]);
	const storedV2 = storedValues.browserRelayStateV2;
	const storedV1 = storedValues.browserRelayStateV1;
	let storedSessions = [];
	if (record(storedV2) && storedV2.schemaVersion === 2 && Array.isArray(storedV2.sessions)) storedSessions = storedV2.sessions;
	else if (record(storedV1) && storedV1.schemaVersion === 1 && Array.isArray(storedV1.tabs) && record(storedV1.activeSession) && typeof storedV1.activeSession.sessionId === "string") {
		storedSessions = [{ sessionId: storedV1.activeSession.sessionId, currentTabName: storedV1.currentTabName, tabs: storedV1.tabs }];
	}
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
		for (const candidate of stored.tabs) {
			if (!record(candidate) || !Number.isInteger(candidate.tabId) || typeof candidate.targetId !== "string" || seenTabIds.has(candidate.tabId)) continue;
			let name; let cachedUrl;
			try { name = safeName(candidate.name); cachedUrl = safeUrl(candidate.url); } catch { continue; }
			let tab;
			try { tab = await chrome.tabs.get(candidate.tabId); }
			catch (error) { if (isMissingChromeTabError(error)) continue; }
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
				attached: false,
				detached: true,
			});
			seenTabIds.add(candidate.tabId);
		}
		if (state.currentTabName && !state.tabsByName.has(state.currentTabName)) state.currentTabName = undefined;
		sessionStates.set(state.sessionId, state);
	}
	await persistState();
	await chrome.storage.session.remove("browserRelayStateV1");
}

async function attach(item, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	assertOperation();
	const targets = await chrome.debugger.getTargets();
	assertOperation();
	if (typeof item.targetId === "string") {
		const target = targets.find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
		if (!target) throw new Error("owned debugger target identity changed");
		if (item.attached === true && item.detached !== true && target.attached === true) return;
		assertOperation();
		item.attached = false;
		item.detached = true;
		if (target.attached === true) {
			try {
				await chrome.debugger.sendCommand({ tabId: item.tabId }, "Page.enable");
				await chrome.debugger.sendCommand({ tabId: item.tabId }, "Accessibility.enable");
				await enableChildFrameSessions({ tabId: item.tabId }, assertOperation);
				assertOperation();
				item.attached = true; item.detached = false; await persistState(); assertOperation(); return;
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
async function closeOwned(state, name, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	assertOperation();
	const item = state.tabsByName.get(name);
	if (!item) return false;
	// Keep a retiring ID unavailable to concurrent sessions until cleanup settles.
	tabReservations.add(item.tabId);
	state.tabsByName.delete(name);
	childSessionsByTabId.delete(item.tabId);
	if (state.currentTabName === name) state.currentTabName = undefined;
	try {
		try { await chrome.debugger.detach({ tabId: item.tabId }); } catch { /* already detached or retired */ }
		if (item.ownership !== "claimed") try { await chrome.tabs.remove(item.tabId); } catch { /* already closed or retired */ }
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
	if (!item) throw new Error("owned tab not found");
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
function observationValue(name, item, tab, nodes, truncated, coverage = {}) {
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
	return evaluated.filter((entry) => typeof entry.value === "string" && entry.value).map((entry) => ({ scopeId: entry.scopeId, text: entry.value }));
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
async function observation(name, item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	await attach(item, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	if (!tab || tab.id !== item.tabId) throw new Error("owned tab lost");
	await delay(50);
	const target = (await chrome.debugger.getTargets()).find((candidate) => candidate.tabId === item.tabId && candidate.id === item.targetId && candidate.type === "page");
	if (!target || typeof target.url !== "string") throw new Error("owned debugger target identity changed");
	assertOperation();
	item.url = safeUrl(target.url);
	const rootTreePromise = valueWithinRelayDeadline(chrome.debugger.sendCommand({ tabId: item.tabId }, "Accessibility.getFullAXTree", { depth: 64 }), 8_000);
	const childTreesPromise = Promise.all(childSessionEntries(item.tabId).map(async (entry) => {
		const ready = await valueWithinRelayDeadline(entry.ready, 1_000);
		if (!ready.ok) return undefined;
		const tree = await valueWithinRelayDeadline(chrome.debugger.sendCommand({ tabId: item.tabId, sessionId: entry.sessionId }, "Accessibility.getFullAXTree", { depth: 64 }), 2_000);
		return tree.ok ? { scopeId: entry.scopeId, nodes: Array.isArray(tree.value?.nodes) ? tree.value.nodes : [] } : undefined;
	}));
	const [rootTree, childTrees, textSources] = await Promise.all([rootTreePromise, childTreesPromise, renderedTextSources(item, assertOperation)]);
	assertOperation();
	const rawNodes = (rootTree.ok && Array.isArray(rootTree.value?.nodes) ? rootTree.value.nodes : []).map((node) => ({ node, scopeId: "r" }));
	for (const child of childTrees) if (child) for (const node of child.nodes) rawNodes.push({ node, scopeId: child.scopeId });
	const nodes = [];
	const seenBackendNodeIds = new Set();
	for (const { node, scopeId } of rawNodes) {
		if (nodes.length >= MAX_AX_NODES) break;
		if (node?.ignored === true || !Number.isInteger(node?.backendDOMNodeId)) continue;
		const scopedBackendNodeId = `${scopeId}:${node.backendDOMNodeId}`;
		if (seenBackendNodeIds.has(scopedBackendNodeId)) continue;
		const role = axValue(node, "role");
		const nameValue = axValue(node, "name");
		if (!role && !nameValue) continue;
		seenBackendNodeIds.add(scopedBackendNodeId);
		const ref = formatScopedAxRef(item.documentGeneration, scopeId, node.backendDOMNodeId);
		nodes.push({ ref, role, name: nameValue, states: axStates(node) });
	}
	const text = renderedTextNodes(item, textSources, MAX_TEXT_NODES);
	nodes.push(...text.nodes);
	item.lastObservationNodes = nodes;
	return observationValue(name, item, tab, nodes, (rawNodes.length > MAX_AX_NODES) || text.truncated || !rootTree.ok);
}
async function interactionReadback(name, item, assertOperation) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const tab = await chrome.tabs.get(item.tabId);
	const [textSources, alertSources] = await Promise.all([renderedTextSources(item, assertOperation), pageAlertSources(item, assertOperation)]);
	assertOperation();
	const text = renderedTextNodes(item, textSources, MAX_INTERACTION_TEXT_NODES);
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
			functionDeclaration: "function(){return this.length;}",
			returnByValue: true,
		});
		const targetCount = Math.max(0, Math.min(Number(lengthResult?.result?.value) || 0, FULL_READ_MAX_TARGETS));
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
			await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: 0 }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true });
			await delay(FULL_READ_RENDER_WAIT_MS);
			scannedContainers += 1;
			let targetComplete = false;
			let targetMoved = false;
			let targetScrollable = false;
			let stableEndPasses = 0;
			let previousHeight = -1;
			let previousTop = -1;
			for (;;) {
				if (scanSteps >= remainingSteps) break;
				const stateResult = await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, functionDeclaration: scrollTargetState.toString(), returnByValue: true });
				const state = stateResult?.result?.value;
				if (!record(state)) break;
				scanSteps += 1;
				const merged = mergeRenderedText(text, typeof state.text === "string" ? state.text : "", FULL_READ_MAX_CHARACTERS);
				text = merged.text;
				truncated ||= merged.truncated;
				const top = Number(state.top) || 0;
				const clientHeight = Number(state.clientHeight) || 0;
				const scrollHeight = Number(state.scrollHeight) || 0;
				targetScrollable ||= scrollHeight - clientHeight > 2;
				targetMoved ||= previousTop >= 0 && top > previousTop + 1;
				const atEnd = clientHeight <= 0 || top + clientHeight >= scrollHeight - 2;
				if (atEnd) {
					stableEndPasses = scrollHeight === previousHeight ? stableEndPasses + 1 : 0;
					if (stableEndPasses >= 2) { targetComplete = !targetScrollable || targetMoved; break; }
				} else stableEndPasses = 0;
				const step = Math.max(240, Math.floor(clientHeight * 0.75));
				const nextTop = Math.min(Math.max(0, scrollHeight - clientHeight), top + step);
				if (!atEnd && (nextTop <= top + 1 || top === previousTop)) break;
				previousHeight = scrollHeight;
				previousTop = top;
				await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: nextTop }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true });
				await delay(FULL_READ_RENDER_WAIT_MS);
			}
			if (targetMoved) scrolledContainers += 1;
			endReached &&= targetComplete;
			await debuggerCommandWithin(debuggee, "Runtime.callFunctionOn", { objectId: targetObjectId, arguments: [{ value: originalTop }], functionDeclaration: scrollTargetTo.toString(), returnByValue: true });
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
	const root = await fullRenderedTextSource({ tabId: item.tabId }, "r", FULL_READ_MAX_STEPS, assertOperation);
	let remainingSteps = Math.max(0, FULL_READ_MAX_STEPS - root.scanSteps);
	const sources = [root];
	for (const entry of childSessionEntries(item.tabId)) {
		if (remainingSteps <= 0) break;
		const ready = await valueWithinRelayDeadline(entry.ready, 500);
		if (!ready.ok) continue;
		const child = await fullRenderedTextSource({ tabId: item.tabId, sessionId: entry.sessionId }, entry.scopeId, remainingSteps, assertOperation);
		remainingSteps = Math.max(0, remainingSteps - child.scanSteps);
		if (child.text) sources.push(child);
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
	const scanSteps = sources.reduce((sum, source) => sum + source.scanSteps, 0);
	const scannedContainers = sources.reduce((sum, source) => sum + source.scannedContainers, 0);
	const scrolledContainers = sources.reduce((sum, source) => sum + source.scrolledContainers, 0);
	const contentComplete = sources.length > 0 && sources.every((source) => source.endReached) && !truncated && scanSteps < FULL_READ_MAX_STEPS;
	return observationValue(name, item, tab, text.nodes, truncated, { contentCoverage: "scroll-end", contentComplete, scanSteps, scannedContainers, scrolledContainers });
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
	if (!["click", "type", "scroll", "select", "keypress"].includes(action)) throw new Error("interaction action invalid");
	if (action === "keypress") {
		if (!["Enter", "Tab", "Escape"].includes(payload.key)) throw new Error("interaction keypress key invalid");
		if (["x", "y", "observationEpoch", "text", "replace", "option", "direction", "amount"].some((field) => payload[field] !== undefined)) throw new Error("interaction keypress parameters invalid");
	} else if (payload.key !== undefined) throw new Error("interaction key requires keypress");
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
	const sourceWindowId = sourceTab.windowId;
	const tabsBefore = await chrome.tabs.query({});
	const knownTabIds = new Set(tabsBefore.map((tab) => tab.id).filter(Number.isInteger));
	const activeBefore = tabsBefore.find((tab) => tab.active === true && tab.windowId === sourceWindowId);
	const sourceWindow = await chrome.windows.get(sourceWindowId);
	const spawned = new Map();
	const windowOpenGuard = { signals: [] };
	assertOperation();
	windowOpenGuardsByTabId.set(item.tabId, windowOpenGuard);
	let restorationChain = Promise.resolve();
	const restore = async () => {
		if (Number.isInteger(activeBefore?.id)) {
			try { await chrome.tabs.update(activeBefore.id, { active: true }); } catch { /* original active tab may have closed */ }
		}
		const relatedWindowIds = new Set([sourceWindowId, ...[...spawned.values()].map((tab) => tab.windowId).filter(Number.isInteger)]);
		if (sourceWindow?.focused === true) {
			try { await chrome.windows.update(sourceWindowId, { focused: true }); } catch { /* source window may have closed */ }
			return;
		}
		for (const windowId of relatedWindowIds) {
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
		queueRestore();
	};
	chrome.tabs.onCreated.addListener(onCreated);
	try {
		const value = await action();
		await delay(BACKGROUND_ACTIVATION_GUARD_MS);
		for (const tab of await chrome.tabs.query({})) if (Number.isInteger(tab.id) && !knownTabIds.has(tab.id) && (tab.openerTabId === item.tabId || consumeWindowOpenSignal(tab))) spawned.set(tab.id, tab);
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
async function performInteraction(name, item, payload, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const assertOwned = (item) => assertOwnedWithin(item, assertOperation);
	assertOperation();
	await attach(item, assertOperation);
	await assertOwned(item);
	assertOperation();
	const target = await interactionTarget(name, item, payload, assertOperation);
	assertOperation();
	const expectation = parseInteractionExpectation(payload.expect);
	if (expectation && (target.action === "scroll" || target.coordinate === true)) throw new Error("interaction expect requires a targetRef click, type, select, or keypress");
	const stateObjectId = target.action === "scroll" ? undefined : await interactionTargetObjectId(target, assertOperation);
	const stateBefore = await interactionTargetState(target.debuggee, stateObjectId, assertOperation);
	assertOperation();
	let effect;
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
	} else if (target.action === "keypress") {
		if (stateObjectId === undefined) throw new Error("interaction keypress target could not be resolved");
		const key = payload.key;
		const keyCode = { Enter: 13, Tab: 9, Escape: 27 }[key];
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
			const parameters = { key, code: key, windowsVirtualKeyCode: keyCode, modifiers: 0 };
			// Enter needs a real CDP key event, not insertText("\\n") or a synthetic DOM
			// KeyboardEvent. One keyDown carries the character; do not add a second char.
			await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchKeyEvent", { ...parameters, type: key === "Enter" ? "keyDown" : "rawKeyDown", ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
			assertKeyTarget();
			await chrome.debugger.sendCommand(target.debuggee, "Input.dispatchKeyEvent", { ...parameters, type: "keyUp" });
		}, assertOperation), assertOperation);
		assertOperation();
		effect = { dispatch: "keyboard", key, focusVerified: true, focusEmulated: true, backgroundPreserved: guarded.restored, spawnedTabs: guarded.spawnedTabs };
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
		const urlMatches = expectedUrl === undefined || safeUrl(target.url) === expectedUrl;
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
async function handleOperation(state, operation, payload, expectedEpoch, assertOperation = () => undefined) {
	const chrome = operationChrome(globalThis.chrome, assertOperation);
	const assertOwned = (item) => assertOwnedWithin(item, assertOperation);
	assertOperation();
	if (!record(payload)) throw new Error("payload invalid");
	if (operation === "hello") {
		const nonce = safeString(payload.nonce, "nonce", 128);
		return { schemaVersion: 1, kind: "rotom-browser-relay-ready", protocolRevision: 17, nonce, capabilities: ["tab-control", "claim-user-tabs", "handoff-user-tabs", "agent-tab-groups", "accessibility-snapshot", "rendered-document-text", "full-document-read", "virtualized-frame-scroll", "content-coverage", "oopif-accessibility", "screenshot", "direct-interaction", "cdp-mouse", "coordinate-click", "targeted-scroll", "interaction-target-state", "page-alert-readback", "targeted-keypress", "operation-deadline", "non-destructive-timeout", "in-place-recovery", "multi-client-multiplex"] };
	}
	if (operation === "open") {
		const name = safeName(payload.tabName);
		if (state.tabsByName.has(name)) throw new Error("owned tab name already exists");
		const url = safeUrl(payload.url);
		// Capture a newly created ID even if its request retires while Chrome is
		// creating it. It has not yet been made available for any other owner.
		assertOperation();
		const tab = await globalThis.chrome.tabs.create({ url, active: false });
		if (!Number.isInteger(tab.id)) throw new Error("tab creation failed");
		try { assertOperation(); } catch (error) {
			if (!allSessionItems().some((item) => item.tabId === tab.id) && !tabReservations.has(tab.id)) {
				tabReservations.add(tab.id);
				try { await globalThis.chrome.tabs.remove(tab.id); }
				finally { tabReservations.delete(tab.id); }
			}
			throw error;
		}
		const item = { tabId: tab.id, documentGeneration: 1, url, status: tab.status === "complete" ? "complete" : "loading", ownership: "agent", attached: false, detached: false };
		state.tabsByName.set(name, item);
		state.currentTabName = name;
		try {
			await placeInSharedAgentGroup(tab, assertOperation);
			await attach(item, assertOperation);
			if (state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay session changed during tab creation");
			await persistState();
			if (state.epoch !== expectedEpoch || state.generation === undefined) throw new Error("browser relay session changed during tab persistence");
		}
		catch (error) { await closeOwnedIdentity(state, name, tab.id, item, assertOperation); throw error; }
		return observation(name, item, assertOperation);
	}
	if (operation === "discover") {
		const ownedIds = new Set([...allSessionItems().map((item) => item.tabId), ...tabReservations]);
		const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((tab) => Number.isInteger(tab.id) && !ownedIds.has(tab.id) && typeof tab.url === "string" && /^(https?):/u.test(tab.url)).slice(0, 50).map((tab) => ({ tabId: tab.id, url: safeUrl(tab.url), title: boundedText(tab.title, 512), status: tab.status === "complete" ? "complete" : "loading", browserActive: tab.active === true }));
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
			const url = safeUrl(tab.url);
			const item = { tabId: tab.id, documentGeneration: 1, url, status: tab.status === "complete" ? "complete" : "loading", ownership: "claimed", attached: false, detached: false };
			assertOperation();
			state.tabsByName.set(name, item);
			state.currentTabName = name;
			try { await attach(item, assertOperation); await persistState(); assertOperation(); }
			catch (error) { await closeOwnedIdentity(state, name, tab.id, item, assertOperation); throw error; }
			return observation(name, item, assertOperation);
		} finally { tabReservations.delete(payload.tabId); }
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
		return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs };
	}
	if (operation === "switch") {
		const { name, item } = owned(state, payload.tabName);
		state.currentTabName = name;
		await persistState();
		assertOperation();
		return observation(name, item, assertOperation);
	}
	if (operation === "snapshot") { const { name, item } = owned(state, payload.tabName); return observation(name, item, assertOperation); }
	if (operation === "read_full") { const { name, item } = owned(state, payload.tabName); return fullObservation(name, item, assertOperation); }
	if (operation === "wait") {
		const { name, item } = owned(state, payload.tabName);
		return waitForTab(name, item, payload, assertOperation);
	}
	if (operation === "screenshot") {
		const { name, item } = owned(state, payload.tabName);
		await attach(item, assertOperation);
		await assertOwned(item);
		const debuggee = { tabId: item.tabId };
		const metricsBefore = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
		const captured = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", { format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false });
		const metricsAfter = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
		if (typeof captured?.data !== "string" || captured.data.length > 950_000) throw new Error("screenshot exceeds relay limit");
		const beforeViewport = coordinateViewport(metricsBefore);
		const afterViewport = coordinateViewport(metricsAfter);
		for (const key of ["width", "height", "pageX", "pageY", "scale"]) if (Math.abs(beforeViewport[key] - afterViewport[key]) > 0.5) throw new Error("screenshot viewport changed during capture");
		assertOperation();
		const binding = mintCoordinateObservation(item, metricsAfter);
		return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: name, tabId: item.tabId, documentGeneration: item.documentGeneration, observationEpoch: binding.observationEpoch, viewport: binding.viewport, mimeType: "image/jpeg", data: captured.data };
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
async function settleWithin(promise, timeoutMs = 1_000) {
	await Promise.race([Promise.resolve(promise).catch(() => undefined), delay(timeoutMs)]);
}
async function detachItemsPreservingState(items) {
	for (const item of items) { childSessionsByTabId.delete(item.tabId); item.attached = false; item.detached = true; }
	await Promise.all(items.map(async (item) => {
		await settleWithin(chrome.debugger.detach({ tabId: item.tabId }));
	}));
	await settleWithin(persistState());
}
async function detachAllOwnedPreservingState(state) { await detachItemsPreservingState([...state.tabsByName.values()]); }
async function resetAfterOperationTimeout(state, operation, targetItem) {
	if ((operation === "interact" || operation === "recover") && targetItem) {
		await detachItemsPreservingState([targetItem]);
		return;
	}
	await detachAllOwnedPreservingState(state);
}
async function handleOperationWithDeadline(state, operation, payload, expectedEpoch) {
	let targetItem;
	if (operation === "interact" || operation === "recover") {
		try { targetItem = owned(state, payload.tabName).item; } catch { /* handleOperation returns the authoritative error */ }
	}
	const operationGuard = createOperationGuard(state, expectedEpoch);
	const operationPromise = handleOperation(state, operation, payload, expectedEpoch, operationGuard.assert);
	const onTimeout = async () => {
		operationGuard.invalidate();
		await resetAfterOperationTimeout(state, operation, targetItem);
	};
	try { return await runWithRelayDeadline(operation, operationPromise, onTimeout, relayOperationDeadlineMs(operation, payload)); }
	finally { operationGuard.invalidate(); } // Retire bounded readback continuations even on success.
}
async function handleRequest(message, state) {
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
		const result = await handleOperationWithDeadline(state, message.operation, message.payload, expectedEpoch);
		if (state.epoch !== expectedEpoch || state.generation !== message.generation) throw new Error("session binding changed during operation");
		post({ schemaVersion: 1, kind: "response", id: message.id, sessionId: message.sessionId, generation: message.generation, ok: true, result });
	} catch (error) {
		post({ schemaVersion: 1, kind: "response", id: message.id, sessionId: message.sessionId, generation: message.generation, ok: false, error: publicError(error) });
	}
}
function queueRelayRequest(message) {
	if (!record(message) || message.schemaVersion !== 1 || message.kind !== "request" || typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.generation !== "string" || typeof message.operation !== "string") return;
	let state = sessionStates.get(message.sessionId);
	if (!state) { state = createSessionState(message.sessionId); sessionStates.set(state.sessionId, state); }
	state.operationChain = state.operationChain.then(() => handleRequest(message, state)).catch(() => undefined);
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
	state.operationChain = state.operationChain.then(async () => {
		if (state.generation === generation) { state.epoch += 1; state.generation = undefined; }
		else if (!preInvalidated || state.generation !== undefined) return;
		await detachAllOwnedPreservingState(state);
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
chrome.tabs.onRemoved.addListener((tabId) => {
	childSessionsByTabId.delete(tabId);
	for (const state of sessionStates.values()) for (const [name, item] of state.tabsByName) if (item.tabId === tabId) {
		state.tabsByName.delete(name);
		if (state.currentTabName === name) state.currentTabName = undefined;
	}
	void persistState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	for (const item of allSessionItems()) {
		if (item.tabId !== tabId) continue;
		const nextUrl = typeof changeInfo.url === "string" ? changeInfo.url : undefined;
		const startsNavigation = changeInfo.status === "loading" && item.status !== "loading";
		if ((nextUrl && nextUrl !== item.url) || startsNavigation) { item.documentGeneration += 1; invalidateCoordinateObservation(item); }
		if (nextUrl) item.url = nextUrl;
		if (changeInfo.status === "complete" || changeInfo.status === "loading") item.status = changeInfo.status;
	}
	void persistState();
});
chrome.debugger.onEvent.addListener((source, method, params) => {
	if (!Number.isInteger(source.tabId)) return;
	if (method === "Page.windowOpen") {
		const guard = windowOpenGuardsByTabId.get(source.tabId);
		if (guard) guard.signals.push({ timestamp: Date.now(), url: typeof params?.url === "string" ? params.url : "", used: false });
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
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
chrome.action.onClicked.addListener(connectNative);

async function startRelay() {
	try { await restoreState(); }
	catch { /* invalid or unavailable session state starts from an empty relay */ }
	connectNative();
}

void startRelay();
