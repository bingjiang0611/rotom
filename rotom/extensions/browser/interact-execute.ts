import { safeString, interactionAction, safeTabName, safeNumber, safeInteger, normalizeInteractionModifiers, targetTab, browserResult, interactionResult, record } from "./tool-results.ts";
import { BROWSER_INTERACT_OPERATIONS_V1, BROWSER_INTERACTION_KEYS_V1, MAX_DIALOG_PROMPT_CHARS_V1, BROWSER_INTERACTION_MODIFIERS_V1, browserActionDigestV1, browserOriginV1, dialogBlockingV1, browserInteractionExpectationOutcomeV1, sanitizeBrowserObservationV1 } from "./browser-relay.ts";
import { parseInteractionExpectation } from "./chrome-extension/interaction-target-state.js";
import { leaseOriginV1 } from "./browser-lease.ts";
import { policyOriginV1 } from "./browser-policy.ts";
import { validateUploadPathsV1 } from "./upload-guard.ts";
import { randomUUID } from "node:crypto";
import { preflightSensitiveReasonV1, sanitizeSensitiveConfirmationV1 } from "./sensitive-actions.ts";
import { BROWSER_INTERACTION_AUDIT_ENTRY, MAX_SNAPSHOT_CURSORS } from "./tool-contract.ts";
import { relayClientTimeoutMs } from "./chrome-extension/relay-deadline.js";
import { compactInteractionReadback, observationTextBaseline } from "./chrome-extension/interaction-observation.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
export async function executeBrowserInteractionV1(pi: ExtensionAPI, runtime: BrowserRuntimeV1, toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, ctx: any) {
	const { bindSession, client, readTabs, publishLeaseScope, leaseDenial, policyDenial, confirmSensitive, leaseAllowsDownload, policyAuthorizedOrigins, makeSnapshotPage, textBaselines } = runtime;
	runtime.browserRouteActive = true;
	const operation = safeString(params.operation, "operation", 64);
	if (!BROWSER_INTERACT_OPERATIONS_V1.includes(operation as any))
		throw new Error("browser_interact operation 无效");
	const action = interactionAction(params.action);
	const tabName = params.tabName === undefined ? undefined : safeTabName(params.tabName);
	const coordinateFieldsPresent = params.x !== undefined || params.y !== undefined || params.observationEpoch !== undefined;
	if (coordinateFieldsPresent && action !== "click")
		throw new Error("坐标参数仅允许 click");
	if (coordinateFieldsPresent && params.targetRef !== undefined)
		throw new Error("click 的 targetRef 与坐标模式互斥");
	const coordinateClick = action === "click" && coordinateFieldsPresent;
	// 期望判定靠目标自身的状态，所以它要求一个确定的 ref 目标：坐标点击和整页滚动
	// 没有可跟踪的元素，在那两条路上返回的任何「已满足」都是编的。
	const expectation = params.expect === undefined ? undefined : safeString(params.expect, "expect", 32);
	if (expectation !== undefined && (action === "scroll" || coordinateClick))
		throw new Error("expect 仅允许带 targetRef 的 click/type/select/keypress");
	parseInteractionExpectation(expectation);
	const targetRef = coordinateClick || action === "dialog" ? undefined : action === "scroll" && params.targetRef === undefined ? undefined : safeString(params.targetRef, "targetRef", 128);
	const x = coordinateClick ? safeNumber(params.x, "x", 0, 100000) : undefined;
	const y = coordinateClick ? safeNumber(params.y, "y", 0, 100000) : undefined;
	const observationEpoch = coordinateClick ? safeInteger(params.observationEpoch, "observationEpoch", 1, Number.MAX_SAFE_INTEGER) : undefined;
	let text: string | undefined;
	let option: string | undefined;
	let direction: "up" | "down" | undefined;
	let amount: number | undefined;
	let key: (typeof BROWSER_INTERACTION_KEYS_V1)[number] | undefined;
	if (params.key !== undefined && action !== "keypress")
		throw new Error("key 仅允许 keypress");
	const dropRef = params.dropRef === undefined ? undefined : safeString(params.dropRef, "dropRef", 128);
	let dialogAccept: boolean | undefined;
	let dialogPromptText: string | undefined;
	if (action === "dialog") {
		if (typeof params.accept !== "boolean")
			throw new Error("dialog 需要 accept: true|false");
		dialogAccept = params.accept;
		if (params.promptText !== undefined) {
			// 空字符串是合法答案（清空 prompt），因此不能走要求非空的 safeString。
			if (typeof params.promptText !== "string" || [...params.promptText].length > MAX_DIALOG_PROMPT_CHARS_V1)
				throw new Error(`dialog promptText 最长 ${MAX_DIALOG_PROMPT_CHARS_V1} 字符`);
			if (dialogAccept !== true)
				throw new Error("dialog 取消时不能带 promptText");
			dialogPromptText = params.promptText;
		}
		if (params.targetRef !== undefined || params.dropRef !== undefined || params.paths !== undefined || params.key !== undefined || params.modifiers !== undefined || params.text !== undefined || params.option !== undefined || params.direction !== undefined || params.amount !== undefined || expectation !== undefined)
			throw new Error("dialog 不接受其它参数");
	}
	else if (params.accept !== undefined || params.promptText !== undefined)
		throw new Error("accept/promptText 仅允许 dialog");
	let uploadPaths: string[] | undefined;
	let uploadFiles: {
		path: string;
		name: string;
		size: number;
	}[] | undefined;
	if (action === "upload") {
		if (params.targetRef === undefined)
			throw new Error("upload 需要 targetRef");
		if (!Array.isArray(params.paths) || params.paths.length === 0)
			throw new Error("upload 需要 paths");
		if (coordinateFieldsPresent || params.dropRef !== undefined || params.key !== undefined || params.modifiers !== undefined || params.text !== undefined)
			throw new Error("upload 参数组合无效");
	}
	else if (params.paths !== undefined)
		throw new Error("paths 仅允许 upload");
	if (action === "drag") {
		if (params.targetRef === undefined || dropRef === undefined)
			throw new Error("drag 需要 targetRef 与 dropRef");
		if (coordinateFieldsPresent)
			throw new Error("drag 不接受坐标参数");
		if (params.key !== undefined || params.modifiers !== undefined)
			throw new Error("drag 参数组合无效");
	}
	else if (params.dropRef !== undefined)
		throw new Error("dropRef 仅允许 drag");
	let modifiers: (typeof BROWSER_INTERACTION_MODIFIERS_V1)[number][] | undefined;
	if (action === "keypress") {
		key = BROWSER_INTERACTION_KEYS_V1.find((candidate) => candidate === params.key);
		if (!key)
			throw new Error("keypress key 必须是固定白名单里的键（Enter/Tab/Escape/方向键/字母/数字 等）");
		modifiers = params.modifiers === undefined ? [] : normalizeInteractionModifiers(params.modifiers);
		if (modifiers === undefined)
			throw new Error("keypress modifiers 只能是 Shift/Control/Alt/Meta 且不重复");
		if (params.text !== undefined || params.replace !== undefined || params.option !== undefined || params.direction !== undefined || params.amount !== undefined)
			throw new Error("keypress 参数组合无效");
	}
	else if (action === "type") {
		if (params.modifiers !== undefined)
			throw new Error("modifiers 仅允许 keypress");
		text = safeString(params.text, "text", 4096);
		if (Buffer.byteLength(text, "utf8") > 4096)
			throw new Error("browser type text 超过 4096 bytes");
		if (params.option !== undefined || params.direction !== undefined || params.amount !== undefined)
			throw new Error("type 参数组合无效");
	}
	else if (action === "select") {
		if (params.modifiers !== undefined)
			throw new Error("modifiers 仅允许 keypress");
		option = safeString(params.option, "option", 512);
		if (Buffer.byteLength(option, "utf8") > 512)
			throw new Error("browser select option 超过 512 bytes");
		if (params.text !== undefined || params.replace !== undefined || params.direction !== undefined || params.amount !== undefined)
			throw new Error("select 参数组合无效");
	}
	else if (action === "scroll") {
		if (params.modifiers !== undefined)
			throw new Error("modifiers 仅允许 keypress");
		direction = params.direction === "up" || params.direction === "down" ? params.direction : undefined;
		if (!direction)
			throw new Error("scroll 需要 direction");
		amount = params.amount === undefined ? 600 : safeInteger(params.amount, "amount", 1, 100000);
		if (params.text !== undefined || params.replace !== undefined || params.option !== undefined)
			throw new Error("scroll 参数组合无效");
	}
	else {
		if (params.modifiers !== undefined)
			throw new Error("modifiers 仅允许 keypress");
		if (params.text !== undefined || params.replace !== undefined || params.option !== undefined || params.direction !== undefined || params.amount !== undefined)
			throw new Error("click 参数组合无效");
	}
	// Reject invalid local arguments before even listing tabs. A schema mistake
	// must neither dispatch Relay requests nor change fallback eligibility.
	const assertOwner = await bindSession(ctx, signal);
	const relayClient = await client(ctx, assertOwner);
	const listedTabs = await readTabs(relayClient, signal);
	const tab = targetTab(listedTabs, tabName);
	publishLeaseScope(relayClient);
	// scroll only reads; every other action writes to the page and needs a lease
	// that covers the tab's current origin. Upload is its own capability: a child
	// that may click may still be forbidden from attaching local files.
	if (action !== "scroll") {
		const denied = await leaseDenial(relayClient, action === "upload" ? "upload" : "interact", leaseOriginV1(tab.url));
		if (denied)
			return denied;
		const policyDenied = await policyDenial(relayClient, action === "upload" ? "upload" : "interact", policyOriginV1(tab.url));
		if (policyDenied)
			return policyDenied;
	}
	if (action === "upload") {
		// Every path rule runs before the relay sees anything: absolute, real, not a
		// symlink or hard link, no secret-shaped component, 10 MB total.
		uploadFiles = await validateUploadPathsV1({ paths: params.paths, allowUpload: true });
		uploadPaths = uploadFiles.map((entry) => entry.path);
	}
	const actionFacts = {
		action, tabName: tab.name, tabId: tab.tabId, documentGeneration: tab.documentGeneration, url: tab.url,
		...(key ? { key } : {}),
		...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
		...(targetRef ? { targetRef } : {}),
		...(dropRef ? { dropRef } : {}),
		// Audit keeps name digests and sizes only, never file content or raw names.
		...(uploadFiles ? { uploadFiles: uploadFiles.map((entry) => ({ nameDigest: browserActionDigestV1(entry.name), size: entry.size })) } : {}),
		...(coordinateClick ? { x, y, observationEpoch } : {}),
		...(text ? { textBytes: Buffer.byteLength(text, "utf8"), textDigest: browserActionDigestV1(text), replace: params.replace === true } : {}),
		...(option ? { optionBytes: Buffer.byteLength(option, "utf8"), optionDigest: browserActionDigestV1(option) } : {}),
		...(direction ? { direction, amount } : {}),
		...(expectation ? { expect: expectation } : {}),
	};
	const actionDigest = browserActionDigestV1(actionFacts);
	const actionId = `pi1_browser_action_${randomUUID()}`;
	// Upload and leaving an unsaved page are known here, before any probe.
	const dialogType = tab.dialog?.type;
	const preflightReason = preflightSensitiveReasonV1({ action, dialogType });
	let confirmation: "auto-full-access" | "auto-localhost" | undefined;
	if (preflightReason !== undefined) {
		const decided = confirmSensitive(relayClient, { reason: preflightReason, origin: policyOriginV1(tab.url) ?? "" });
		if (!decided.confirmed) {
			pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "blocked", actionAcknowledged: false, businessOutcome: "not-executed", sensitiveReason: preflightReason, timestamp: new Date().toISOString() });
			return decided.result;
		}
		confirmation = decided.confirmation;
	}
	assertOwner();
	pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-intent", actionId, sessionId: ctx.sessionManager.getSessionId(), branchLeafId: ctx.sessionManager.getLeafId() ?? null, toolCallId, action, actionDigest, targetDigest: browserActionDigestV1({ tabName: tab.name, tabId: tab.tabId, documentGeneration: tab.documentGeneration, ...(targetRef ? { targetRef } : {}), ...(coordinateClick ? { x, y, observationEpoch } : {}) }), originDigest: browserActionDigestV1(browserOriginV1(tab.url)), timestamp: new Date().toISOString() });
	try {
		const payload = { actionId, tabName: tab.name, action, allowDownload: await leaseAllowsDownload(relayClient), ...(confirmation === undefined ? {} : { confirmed: true }), ...(action === "scroll" ? {} : { allowedOrigins: [...policyAuthorizedOrigins] }), ...(dialogAccept === undefined ? {} : { accept: dialogAccept }), ...(dialogPromptText === undefined ? {} : { promptText: dialogPromptText }), ...(key ? { key } : {}), ...(modifiers && modifiers.length > 0 ? { modifiers } : {}), ...(targetRef ? { targetRef } : {}), ...(dropRef ? { dropRef } : {}), ...(uploadPaths ? { paths: uploadPaths } : {}), ...(coordinateClick ? { x, y, observationEpoch, documentGeneration: tab.documentGeneration } : {}), ...(text ? { text, replace: params.replace === true } : {}), ...(option ? { option } : {}), ...(expectation ? { expect: expectation } : {}), ...(direction ? { direction, amount } : {}) };
		let raw = await relayClient.request("interact", payload, { signal, timeoutMs: relayClientTimeoutMs("interact", {}) });
		// The relay refused before dispatching. Full-access approval is not a replay:
		// nothing ran, and only one confirmed request may dispatch.
		const sensitiveRefusal = sanitizeSensitiveConfirmationV1(raw);
		if (sensitiveRefusal !== undefined) {
			const decided = confirmSensitive(relayClient, { reason: sensitiveRefusal.reason, matchedWord: sensitiveRefusal.matchedWord, origin: sensitiveRefusal.origin || (policyOriginV1(tab.url) ?? "") });
			if (!decided.confirmed) {
				assertOwner();
				pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "blocked", actionAcknowledged: false, businessOutcome: "not-executed", sensitiveReason: sensitiveRefusal.reason, timestamp: new Date().toISOString() });
				return decided.result;
			}
			confirmation = decided.confirmation;
			raw = await relayClient.request("interact", { ...payload, confirmed: true }, { signal, timeoutMs: relayClientTimeoutMs("interact", {}) });
		}
		// A suspended tab refuses before dispatching: nothing happened, so this is a
		// clean refusal, not an unknown outcome.
		const blocked = dialogBlockingV1(raw);
		if (blocked) {
			assertOwner();
			pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "blocked", actionAcknowledged: false, businessOutcome: "not-executed", timestamp: new Date().toISOString() });
			return browserResult(blocked);
		}
		const result = interactionResult(raw, { actionId, action });
		const expectationOutcome = browserInteractionExpectationOutcomeV1(result.effect);
		const targetChanged = record(result.effect?.target) ? (result.effect.target as Record<string, unknown>).changed : undefined;
		assertOwner();
		pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "ok", actionAcknowledged: true, businessOutcome: "unverified", ...(confirmation === undefined ? {} : { confirmation }), ...(expectationOutcome ? { expectationOutcome } : {}), ...(typeof targetChanged === "boolean" || targetChanged === null ? { targetChanged } : {}), readbackDigest: result.readback.digest, timestamp: new Date().toISOString() });
		const readback = makeSnapshotPage(sanitizeBrowserObservationV1(compactInteractionReadback(result.readback, textBaselines.get(result.readback.tabId))), Number.MAX_SAFE_INTEGER);
		const output = browserResult({ kind: "browser-interaction-result", actionId, acknowledged: true, businessOutcome: "unverified", ...(result.effect ? { effect: result.effect } : {}), readback });
		// Cache only text already delivered in a single result, after all
		// ownership/size checks. Never persist page content or cache deltas.
		textBaselines.delete(result.readback.tabId);
		if (!readback.nextCursor) {
			if (textBaselines.size >= MAX_SNAPSHOT_CURSORS)
				textBaselines.delete(textBaselines.keys().next().value!);
			textBaselines.set(result.readback.tabId, observationTextBaseline(result.readback));
		}
		return output;
	}
	catch (error) {
		// Leave the old intent unresolved for read-only recovery, never append
		// an old terminal into the replacement branch/session.
		assertOwner();
		pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "unknown", actionAcknowledged: false, businessOutcome: "unknown", timestamp: new Date().toISOString() });
		// 未知不等于未执行：dispatch 可能已经到页面。写动作重发就是第二次提交，
		// 所以 recover 只用于只读核对；scroll 本身幂等，才允许原动作重试一次。
		if (error instanceof Error && /timeout|debugger is not attached/iu.test(error.message)) {
			throw new Error(action === "scroll"
				? `${error.message}；请对原 tab 调用一次 browser_inspect recover 后最多重试一次，禁止 close/open 或 claim 新标签`
				: `${error.message}；${action} 结果 unknown，dispatch 可能已生效。请对原 tab 调用一次 browser_inspect recover 并只读核对页面状态，禁止重发该写动作、禁止 close/open 或 claim 新标签`);
		}
		throw error;
	}
}
