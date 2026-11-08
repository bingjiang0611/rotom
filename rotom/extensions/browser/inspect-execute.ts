import { safeString, safeTabName, safeInteger, safeAgentId, browserResult, record, validateDiscoveredTabs, safeDisplayUrl, targetTab, publicTabs, validateTabs, screenshotResult } from "./tool-results.ts";
import { BROWSER_INSPECT_OPERATIONS_V1, BROWSER_NETWORK_DEFAULT_LIMIT_V1, BROWSER_CONSOLE_DEFAULT_LIMIT_V1, BROWSER_NETWORK_MAX_LIMIT_V1, BROWSER_CONSOLE_MAX_LIMIT_V1, BROWSER_CONSOLE_LEVELS_V1, BROWSER_NETWORK_RESOURCE_TYPES_V1, BROWSER_NAVIGATE_HISTORY_V1, canonicalBrowserUrlV1, dialogBlockingV1, sanitizeBrowserObservationV1, BROWSER_OPEN_PLACEMENTS_V1, browserOriginV1, BROWSER_RELAY_TRANSFER_CAPABILITY_V1, validateBrowserScreenshotV1 } from "./browser-relay.ts";
import { leaseOriginV1 } from "./browser-lease.ts";
import { relayClientTimeoutMs } from "./chrome-extension/relay-deadline.js";
import { policyOriginV1 } from "./browser-policy.ts";
import { validateBrowserConsoleV1, validateBrowserNetworkV1, validateBrowserDownloadsV1 } from "./capture-results.ts";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export const BROWSER_POLICY_READ_OPERATIONS_V1 = ["snapshot", "snapshot_visible", "read_full", "screenshot", "console", "network", "wait"] as const;
export async function executeBrowserInspectV1(runtime: BrowserRuntimeV1, rawParams: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext) {
	const { bindSession, client, textBaselines, makeSnapshotPage, leaseDenial, policyDenial, authorizedOrigins, leaseRefusal, readTabs, publishLeaseScope, artifactStore } = runtime;
	runtime.browserRouteActive = true;
	const params = rawParams as Record<string, unknown>;
	const operation = safeString(params.operation, "operation", 64);
	if (!BROWSER_INSPECT_OPERATIONS_V1.includes(operation as any))
		throw new Error("browser_inspect operation 无效");
	const tabName = params.tabName === undefined ? undefined : safeTabName(params.tabName);
	const limit = params.limit === undefined ? Number.MAX_SAFE_INTEGER : safeInteger(params.limit, "limit", 1, Number.MAX_SAFE_INTEGER);
	const text = params.text === undefined ? undefined : safeString(params.text, "text", 256);
	const role = params.role === undefined ? undefined : safeString(params.role, "role", 128);
	// console takes its own bounded filters; reject them locally so a bad value
	// never becomes a dispatched request.
	const consoleLevel = params.level === undefined ? undefined : safeString(params.level, "level", 16);
	const consolePattern = params.pattern === undefined ? undefined : safeString(params.pattern, "pattern", 128);
	const consoleSinceCursor = params.sinceCursor === undefined ? undefined : safeString(params.sinceCursor, "sinceCursor", 32);
	const networkResourceType = params.resourceType === undefined ? undefined : safeString(params.resourceType, "resourceType", 32);
	if (params.failedOnly !== undefined && params.failedOnly !== true && params.failedOnly !== false)
		throw new Error("failedOnly 必须是布尔值");
	const failedOnly = params.failedOnly === true;
	// console/network default to 50 entries, not to "as many as fit": these are log
	// tails, and unbounded would mean paging by accident on every call.
	const logLimit = params.limit === undefined
		? (operation === "network" ? BROWSER_NETWORK_DEFAULT_LIMIT_V1 : BROWSER_CONSOLE_DEFAULT_LIMIT_V1)
		: safeInteger(params.limit, "limit", 1, BROWSER_NETWORK_MAX_LIMIT_V1);
	if (operation === "console") {
		if (logLimit > BROWSER_CONSOLE_MAX_LIMIT_V1)
			throw new Error(`console limit 最大 ${BROWSER_CONSOLE_MAX_LIMIT_V1}`);
		if (consoleLevel !== undefined && !BROWSER_CONSOLE_LEVELS_V1.includes(consoleLevel as never))
			throw new Error("console level 必须是 verbose/info/warning/error");
		if (consolePattern !== undefined && (consolePattern.length === 0 || consolePattern.length > 128))
			throw new Error("console pattern 需要 1–128 字符");
		if (consoleSinceCursor !== undefined && !/^c\d{1,12}$/u.test(consoleSinceCursor))
			throw new Error("console sinceCursor 无效");
		if (params.failedOnly !== undefined || networkResourceType !== undefined)
			throw new Error("failedOnly/resourceType 仅允许 network");
	}
	else if (operation === "network") {
		if (networkResourceType !== undefined && !BROWSER_NETWORK_RESOURCE_TYPES_V1.includes(networkResourceType as never))
			throw new Error("network resourceType 无效");
		if (consolePattern !== undefined && consolePattern.length > 256)
			throw new Error("network pattern 最长 256 字符");
		if (consoleSinceCursor !== undefined && !/^n\d{1,12}$/u.test(consoleSinceCursor))
			throw new Error("network sinceCursor 无效");
		if (consoleLevel !== undefined)
			throw new Error("level 仅允许 console");
	}
	else if (consoleLevel !== undefined || consolePattern !== undefined || consoleSinceCursor !== undefined || params.failedOnly !== undefined || networkResourceType !== undefined)
		throw new Error("level/pattern/sinceCursor/failedOnly/resourceType 仅允许 console 或 network");
	const filtered = text !== undefined || role !== undefined;
	if (filtered && (operation !== "snapshot_visible" || params.cursor !== undefined))
		throw new Error("text/role 仅允许首次 snapshot_visible；cursor 已固定查询结果，请勿重复过滤");
	// Invalid local input must neither contact Relay nor grant fallback permission.
	if ((operation === "open" || operation === "claim" || operation === "transfer") && !tabName)
		throw new Error(`${operation} 需要 tabName`);
	const navigateHistory = operation === "navigate" && params.history !== undefined ? BROWSER_NAVIGATE_HISTORY_V1.find((value) => value === params.history) : undefined;
	if (operation === "navigate") {
		if (params.history !== undefined && navigateHistory === undefined)
			throw new Error("navigate history 必须是 back/forward/reload");
		if ((params.url === undefined) === (navigateHistory === undefined))
			throw new Error("navigate 需要 url 或 history 之一");
		if (params.url !== undefined && navigateHistory !== undefined)
			throw new Error("navigate 的 url 与 history 互斥");
	}
	else if (params.history !== undefined)
		throw new Error("history 仅允许 navigate");
	const toAgentId = operation === "transfer" ? safeAgentId(params.toAgentId) : undefined;
	const openUrl = operation === "open" ? canonicalBrowserUrlV1(params.url) : undefined;
	const claimTabId = operation === "claim" ? safeInteger(params.tabId, "tabId", 0, Number.MAX_SAFE_INTEGER) : undefined;
	const assertOwner = await bindSession(ctx, signal);
	const relayClient = await client(ctx, assertOwner);
	// A tab suspended by a JS dialog answers every operation with the same refusal;
	// surface it as a structured result instead of letting a payload validator
	// turn it into "schema 无效".
	const boundedResult = (value: unknown) => {
		assertOwner();
		const blocked = dialogBlockingV1(value);
		return browserResult(blocked ?? value);
	};
	// Cursor mutation and result construction share one synchronous publication boundary.
	const snapshotResult = (value: unknown, limit: number, cursor?: string) => {
		assertOwner();
		const blocked = dialogBlockingV1(value);
		if (blocked)
			return browserResult(blocked);
		// Explicit reads can be paginated; never assume their omitted pages
		// reached the model. Start the next interaction with a full readback.
		textBaselines.clear();
		// `undefined` is the cursor continuation: no fresh observation by design.
		return browserResult(makeSnapshotPage(value === undefined ? undefined : sanitizeBrowserObservationV1(value), limit, cursor));
	};
	// A suspended tab refuses before dispatching, so a refusal can arrive in place of
	// any observation. Narrowing here keeps every caller honest: it either gets a
	// validated observation or the structured refusal, never a schema error.
	const readOutcome = (value: unknown) => {
		const blocked = dialogBlockingV1(value);
		return blocked === undefined ? { observation: sanitizeBrowserObservationV1(value) } : { blocked };
	};
	if (["recover", "close", "handoff"].includes(operation))
		textBaselines.clear();
	const pagedObservation = operation === "snapshot" || operation === "snapshot_visible" || operation === "read_full";
	if (params.cursor !== undefined && !pagedObservation)
		throw new Error("cursor 仅允许 snapshot、snapshot_visible 或 read_full");
	if (pagedObservation && params.cursor !== undefined)
		return snapshotResult(undefined, limit, params.cursor as string);
	if (operation === "open") {
		const placement = params.placement === undefined ? undefined : safeString(params.placement, "placement", 32);
		if (placement !== undefined && !BROWSER_OPEN_PLACEMENTS_V1.includes(placement as never))
			throw new Error("open placement 无效");
		// A child may only open origins its lease covers; the refusal is local,
		// so no open request reaches the relay or the site.
		const denied = await leaseDenial(relayClient, "interact", leaseOriginV1(openUrl));
		if (denied)
			return denied;
		const policyDenied = await policyDenial(relayClient, "interact", leaseOriginV1(openUrl));
		if (policyDenied)
			return policyDenied;
		const opened = readOutcome(await relayClient.request("open", { tabName, url: openUrl, ...(placement === undefined ? {} : { placement }) }, { signal }));
		if ("blocked" in opened)
			return boundedResult(opened.blocked);
		authorizedOrigins.add(leaseOriginV1(openUrl) ?? "");
		return snapshotResult(opened.observation, limit);
	}
	if (operation === "navigate") {
		const navigateUrl = params.url === undefined ? undefined : canonicalBrowserUrlV1(params.url);
		const target = navigateUrl !== undefined
			? { url: navigateUrl }
			: { history: navigateHistory };
		// A child may only navigate where its lease reaches. A URL target is checked
		// here; a history target is resolved inside the relay, so the lease origins
		// travel with the request and the refusal happens before the tab moves.
		if (navigateUrl !== undefined) {
			const denied = await leaseDenial(relayClient, "interact", leaseOriginV1(navigateUrl));
			if (denied)
				return denied;
			const policyDenied = await policyDenial(relayClient, "interact", leaseOriginV1(navigateUrl));
			if (policyDenied)
				return policyDenied;
		}
		const leaseOrigins = relayClient.leaseToken === undefined ? undefined : [...authorizedOrigins];
		const requested = await relayClient.request("navigate", {
			tabName,
			...target,
			timeoutMs: params.timeoutMs === undefined ? undefined : safeInteger(params.timeoutMs, "timeoutMs", 0, 300000),
			...(leaseOrigins === undefined ? {} : { allowedOrigins: leaseOrigins }),
		}, { signal, timeoutMs: relayClientTimeoutMs("navigate", { timeoutMs: params.timeoutMs }) });
		// History navigation is resolved inside the relay; the lease decision comes back
		// as a refusal instead of an observation, and nothing was dispatched.
		if (record(requested) && requested.kind === "needs-approval") {
			return leaseRefusal({ origin: typeof requested.origin === "string" ? requested.origin : "", capability: "interact", reason: typeof requested.reason === "string" ? requested.reason : "origin" });
		}
		// The target tab may already be suspended by a dialog (beforeunload is the
		// common case): the relay refuses before moving the tab.
		const moved = readOutcome(requested);
		if ("blocked" in moved)
			return boundedResult(moved.blocked);
		if (navigateUrl !== undefined)
			authorizedOrigins.add(leaseOriginV1(navigateUrl) ?? "");
		return snapshotResult(moved.observation, limit);
	}
	if (operation === "discover") {
		const discovered = validateDiscoveredTabs(await relayClient.request("discover", {}, { signal }));
		return boundedResult({ kind: "discovered-tabs", tabs: discovered.tabs.map((tab) => ({ ...tab, url: safeDisplayUrl(tab.url), origin: browserOriginV1(tab.url) })) });
	}
	if (operation === "claim") {
		const tabId = claimTabId!;
		const discovered = validateDiscoveredTabs(await relayClient.request("discover", {}, { signal }));
		const candidate = discovered.tabs.find((tab) => tab.tabId === tabId);
		if (!candidate)
			throw new Error("claim 目标不在当前可用标签列表");
		const claimed = readOutcome(await relayClient.request("claim", { tabName, tabId }, { signal }));
		if ("blocked" in claimed)
			return boundedResult(claimed.blocked);
		return snapshotResult(claimed.observation, limit);
	}
	if (operation === "transfer") {
		relayClient.requireCapability(BROWSER_RELAY_TRANSFER_CAPABILITY_V1, "browser relay 不支持跨 agent 移交；请在 chrome://extensions 重载 Rotom Browser Relay");
		const transferred = await relayClient.request("transfer", { tabName, toAgentId }, { signal });
		textBaselines.clear();
		return boundedResult(transferred);
	}
	if (operation === "recover") {
		const target = targetTab(await readTabs(relayClient, signal), tabName);
		return boundedResult({ kind: "tabs", tabs: publicTabs(validateTabs(await relayClient.request("recover", { tabName: target.name }, { signal, timeoutMs: relayClientTimeoutMs("recover", {}) }))) });
	}
	const tabs = await readTabs(relayClient, signal);
	publishLeaseScope(relayClient);
	if (operation === "tabs")
		return boundedResult({ kind: "tabs", tabs: publicTabs(tabs) });
	if (BROWSER_POLICY_READ_OPERATIONS_V1.includes(operation as never)) {
		// Full access still honors explicit site blocks before reading page content.
		const readDenied = await policyDenial(relayClient, "read", policyOriginV1(targetTab(tabs, tabName).url));
		if (readDenied)
			return readDenied;
	}
	if (operation === "close")
		return boundedResult(await relayClient.request("close", { ...(params.all === true ? { all: true } : { tabName }) }, { signal }));
	if (operation === "handoff")
		return boundedResult(await relayClient.request("handoff", { tabName }, { signal }));
	if (operation === "console") {
		const raw = await relayClient.request("console", {
			tabName,
			...(consoleLevel === undefined ? {} : { level: consoleLevel }),
			...(consolePattern === undefined ? {} : { pattern: consolePattern }),
			...(consoleSinceCursor === undefined ? {} : { sinceCursor: consoleSinceCursor }),
			limit: logLimit,
		}, { signal, timeoutMs: relayClientTimeoutMs("console", {}) });
		return boundedResult(validateBrowserConsoleV1(raw, logLimit));
	}
	if (operation === "network") {
		const raw = await relayClient.request("network", {
			tabName,
			...(failedOnly ? { failedOnly: true } : {}),
			...(consolePattern === undefined ? {} : { pattern: consolePattern }),
			...(networkResourceType === undefined ? {} : { resourceType: networkResourceType }),
			...(consoleSinceCursor === undefined ? {} : { sinceCursor: consoleSinceCursor }),
			limit: logLimit,
		}, { signal, timeoutMs: relayClientTimeoutMs("network", {}) });
		return boundedResult(validateBrowserNetworkV1(raw, logLimit));
	}
	if (operation === "downloads") {
		if (tabName !== undefined || filtered || params.cursor !== undefined)
			throw new Error("downloads 不接受 tabName、过滤或 cursor");
		const raw = await relayClient.request("downloads", {}, { signal, timeoutMs: relayClientTimeoutMs("downloads", {}) });
		const blocked = dialogBlockingV1(raw);
		if (blocked)
			return boundedResult(blocked);
		const listed = await validateBrowserDownloadsV1(raw);
		assertOwner();
		// A child whose lease has no `allow.download` gets a refusal instead of a
		// silent listing: the relay already cancelled that download.
		if (listed.blocked.length > 0) {
			return browserResult({
				kind: "needs-approval",
				origin: "",
				capability: "download",
				reason: "download",
				message: `这次下载来自未授权 download 的会话，relay 已取消（${listed.blocked.length} 次）；需要父 agent 在 lease 里打开 allow.download 后重新触发下载。`,
			});
		}
		return boundedResult(listed);
	}
	if (operation === "screenshot") {
		const rawScreenshot = await relayClient.request("screenshot", { tabName }, { signal });
		const blockedScreenshot = dialogBlockingV1(rawScreenshot);
		if (blockedScreenshot)
			return boundedResult(blockedScreenshot);
		const screenshot = validateBrowserScreenshotV1(rawScreenshot);
		const artifact = await (await artifactStore(assertOwner)).storeScreenshot(screenshot);
		assertOwner();
		return screenshotResult(screenshot, artifact);
	}
	if (operation === "wait") {
		const status = params.status === undefined ? "complete" : params.status;
		if (status !== "loading" && status !== "complete")
			throw new Error("wait status 无效");
		const timeoutMs = params.timeoutMs === undefined ? 30000 : safeInteger(params.timeoutMs, "timeoutMs", 0, 300000);
		return snapshotResult(await relayClient.request("wait", { tabName, status, timeoutMs }, { signal, timeoutMs: relayClientTimeoutMs("wait", { timeoutMs }) }), limit);
	}
	if (operation === "snapshot" || operation === "read_full") {
		return snapshotResult(await relayClient.request("read_full", { tabName }, { signal, timeoutMs: relayClientTimeoutMs("read_full", {}) }), limit);
	}
	if (operation === "snapshot_visible") {
		const query = { ...(text !== undefined ? { text } : {}), ...(role !== undefined ? { role } : {}) };
		const outcome = readOutcome(await relayClient.request("snapshot", { tabName, ...query }, { signal }));
		if ("blocked" in outcome)
			return boundedResult(outcome.blocked);
		// Never silently fall back to filtering an already-truncated snapshot.
		if (filtered && (!outcome.observation.selection || outcome.observation.selection.text !== text || outcome.observation.selection.role !== role))
			throw new Error("browser relay query 回执缺失或不匹配；请重载 Chrome 扩展");
		return snapshotResult(outcome.observation, limit);
	}
	if (operation === "switch")
		return snapshotResult(await relayClient.request("switch", { tabName }, { signal }), limit);
	throw new Error("browser_inspect operation 未实现");
}
