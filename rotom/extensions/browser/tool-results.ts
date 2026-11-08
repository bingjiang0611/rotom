import { type BrowserDialogBlockingV1, type BrowserScreenshotV1, canonicalBrowserUrlV1, sanitizeBrowserDialogV1, browserOriginV1, BROWSER_INTERACTION_MODIFIERS_V1, type BrowserInteractionActionV1, BROWSER_INTERACTION_ACTIONS_V1, sanitizeBrowserObservationV1, sanitizeBrowserInteractionEffectV1 } from "./browser-relay.ts";
import { MAX_RESULT_BYTES } from "./tool-contract.ts";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
export type BrowserRelayTabsV1 = {
	schemaVersion: 1;
	kind: "rotom-browser-tabs";
	tabs: Array<{
		name: string;
		tabId: number;
		documentGeneration: number;
		url: string;
		title: string;
		status: "loading" | "complete";
		current: boolean;
		browserActive: boolean;
		ownership: "agent" | "claimed";
		relayAttached: boolean;
		dialog?: BrowserDialogBlockingV1["dialog"];
	}>;
};
export type BrowserDiscoveredTabsV1 = {
	schemaVersion: 1;
	kind: "rotom-browser-discovered-tabs";
	tabs: Array<{
		tabId: number;
		url: string;
		title: string;
		status: "loading" | "complete";
		browserActive: boolean;
		openerOwnedByYou?: boolean;
	}>;
};
export function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function safeString(value: unknown, name: string, max = 4096): string { if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0"))
	throw new Error(`${name} 必须是有界非 NUL 字符串`); return value; }
export function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
	throw new Error(`${name} 必须是 ${minimum}-${maximum} 的安全整数`); return value as number; }
export function safeNumber(value: unknown, name: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
	throw new Error(`${name} 必须是 ${minimum}-${maximum} 的有限数字`); return value; }
export function safeTabName(value: unknown): string { const name = safeString(value, "tabName", 64); if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(name))
	throw new Error("tabName 格式无效"); return name; }
export function safeAgentId(value: unknown): string { const agentId = safeString(value, "toAgentId", 128); if (!/^[\x21-\x7e]+$/u.test(agentId))
	throw new Error("toAgentId 格式无效"); return agentId; }
export function safeDisplayUrl(value: string): string { const url = new URL(value); if (url.search)
	url.search = "?<redacted>"; if (url.hash)
	url.hash = "#<redacted>"; return url.href; }
export function browserResult(value: unknown) {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES)
		throw new Error("browser tool result 超过 128 KiB");
	return { content: [{ type: "text" as const, text }], details: value };
}
/**
 * Writes exported bytes without following a link: the path was checked before the relay
 * request, and `O_NOFOLLOW` keeps a swapped-in symlink from redirecting the write.
 */
export async function writeExportFileV1(path: string, bytes: Buffer): Promise<void> {
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
	try {
		await handle.writeFile(bytes);
	}
	finally {
		await handle.close();
	}
}
export function screenshotResult(screenshot: BrowserScreenshotV1, artifact: unknown) {
	const details = { kind: "browser-screenshot", tabName: screenshot.tabName, tabId: screenshot.tabId, documentGeneration: screenshot.documentGeneration, observationEpoch: screenshot.observationEpoch, viewport: screenshot.viewport, coordinateSpace: "css-viewport", artifact };
	const text = JSON.stringify(details);
	if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES)
		throw new Error("browser screenshot metadata 超过 128 KiB");
	return { content: [{ type: "text" as const, text }, { type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType }], details };
}
export function validateTabs(value: unknown): BrowserRelayTabsV1 {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-tabs" || !Array.isArray(value.tabs) || value.tabs.length > 64)
		throw new Error("browser tabs response 无效");
	const names = new Set<string>();
	const ids = new Set<number>();
	const tabs = value.tabs.map((candidate, index) => {
		if (!record(candidate))
			throw new Error(`browser tab ${index} 无效`);
		const name = safeTabName(candidate.name);
		if (!Number.isSafeInteger(candidate.tabId) || (candidate.tabId as number) < 0 || !Number.isSafeInteger(candidate.documentGeneration) || (candidate.documentGeneration as number) < 1)
			throw new Error(`browser tab ${index} identity 无效`);
		if (names.has(name) || ids.has(candidate.tabId as number))
			throw new Error("browser tabs 含重复 identity");
		names.add(name);
		ids.add(candidate.tabId as number);
		const url = canonicalBrowserUrlV1(candidate.url);
		const status = candidate.status === "loading" || candidate.status === "complete" ? candidate.status : undefined;
		const ownership = candidate.ownership === "agent" || candidate.ownership === "claimed" ? candidate.ownership : undefined;
		if (!status || !ownership || typeof candidate.title !== "string" || typeof candidate.current !== "boolean" || typeof candidate.browserActive !== "boolean" || typeof candidate.relayAttached !== "boolean")
			throw new Error(`browser tab ${index} fields 无效`);
		return { name, tabId: candidate.tabId as number, documentGeneration: candidate.documentGeneration as number, url, title: candidate.title.slice(0, 1024), status, current: candidate.current, browserActive: candidate.browserActive, ownership, relayAttached: candidate.relayAttached, ...(candidate.dialog === undefined ? {} : { dialog: sanitizeBrowserDialogV1(candidate.dialog) }) };
	});
	return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs };
}
export function publicTabs(value: BrowserRelayTabsV1) {
	// A page title is arbitrary page-controlled text and can contain credentials or
	// prompt injection. M7-A exposes only stable tab identity and navigation facts.
	return value.tabs.map((tab) => ({ name: tab.name, tabId: tab.tabId, documentGeneration: tab.documentGeneration, url: safeDisplayUrl(tab.url), origin: browserOriginV1(tab.url), status: tab.status, current: tab.current, browserActive: tab.browserActive, ownership: tab.ownership, relayAttached: tab.relayAttached }));
}
export function validateDiscoveredTabs(value: unknown): BrowserDiscoveredTabsV1 {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-discovered-tabs" || !Array.isArray(value.tabs) || value.tabs.length > 50)
		throw new Error("browser discovered tabs response 无效");
	const ids = new Set<number>();
	const tabs = value.tabs.map((candidate, index) => {
		if (!record(candidate) || !Number.isSafeInteger(candidate.tabId) || (candidate.tabId as number) < 0 || ids.has(candidate.tabId as number))
			throw new Error(`browser discovered tab ${index} identity 无效`);
		ids.add(candidate.tabId as number);
		const url = canonicalBrowserUrlV1(candidate.url);
		const status = candidate.status === "loading" || candidate.status === "complete" ? candidate.status : undefined;
		if (!status || typeof candidate.title !== "string" || typeof candidate.browserActive !== "boolean")
			throw new Error(`browser discovered tab ${index} fields 无效`);
		const openerOwnedByYou = candidate.openerOwnedByYou;
		if (openerOwnedByYou !== undefined && typeof openerOwnedByYou !== "boolean")
			throw new Error(`browser discovered tab ${index} opener 状态无效`);
		return { tabId: candidate.tabId as number, url, title: candidate.title.slice(0, 1024), status, browserActive: candidate.browserActive, ...(openerOwnedByYou === undefined ? {} : { openerOwnedByYou }) };
	});
	return { schemaVersion: 1, kind: "rotom-browser-discovered-tabs", tabs };
}
export function targetTab(value: BrowserRelayTabsV1, tabName?: string) {
	const tab = tabName === undefined ? value.tabs.find((candidate) => candidate.current) : value.tabs.find((candidate) => candidate.name === tabName);
	if (!tab)
		throw new Error(tabName === undefined ? "没有 current browser tab" : `browser tab 不存在：${tabName}`);
	return tab;
}
/** Canonical modifier order, or undefined when the list is invalid or repeats a key. */
export function normalizeInteractionModifiers(value: unknown) {
	if (!Array.isArray(value) || value.length > 4)
		return undefined;
	const seen = new Set<string>();
	for (const modifier of value) {
		if (!BROWSER_INTERACTION_MODIFIERS_V1.includes(modifier as never) || seen.has(modifier as string))
			return undefined;
		seen.add(modifier as string);
	}
	return BROWSER_INTERACTION_MODIFIERS_V1.filter((modifier) => seen.has(modifier));
}
export function interactionAction(value: unknown): BrowserInteractionActionV1 {
	if (typeof value !== "string" || !BROWSER_INTERACTION_ACTIONS_V1.includes(value as BrowserInteractionActionV1))
		throw new Error("browser interaction action 无效");
	return value as BrowserInteractionActionV1;
}
export function interactionResult(value: unknown, expected: {
	actionId: string;
	action: BrowserInteractionActionV1;
}) {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-interaction-result" || value.actionId !== expected.actionId || value.action !== expected.action || value.acknowledged !== true)
		throw new Error("browser interaction result binding 无效");
	return { readback: sanitizeBrowserObservationV1(value.readback), ...(value.effect === undefined ? {} : { effect: sanitizeBrowserInteractionEffectV1(value.effect) }) };
}
