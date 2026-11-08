import { devtoolsEnabledByEnvironment, BROWSER_DEVTOOLS_TOOL_V1, DEVTOOLS_OPERATIONS_V1, MAX_DEVTOOLS_EXPRESSION_CHARS_V1, DEVTOOLS_WORLDS_V1, MAX_NETWORK_REQUEST_ID_CHARS_V1, sanitizeDevtoolsOperationV1, sanitizeDevtoolsExpressionV1, sanitizeDevtoolsWorldV1, resolveViewportV1, viewportPresetNamesV1, sanitizeExportQualityV1, RECORD_MAX_FRAMES_V1, RECORD_MAX_BYTES_V1, RECORD_FPS_V1, MAX_TRACE_BYTES_V1, boundDevtoolsTextV1 } from "./devtools.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isDeferredByDefault } from "../third-party/deferred-tools/register.ts";
import { BROWSER_SHARED_PROMPT_GUIDELINES, BROWSER_INTERACTION_AUDIT_ENTRY } from "./tool-contract.ts";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { EXPORT_FORMATS_V1, type ExportTargetV1, resolveExportTargetV1, MAX_EXPORT_BYTES_V1 } from "./export-guard.ts";
import { safeTabName, safeString, targetTab, browserResult, record, writeExportFileV1 } from "./tool-results.ts";
import { join } from "node:path";
import { leaseOriginV1 } from "./browser-lease.ts";
import { policyOriginV1 } from "./browser-policy.ts";
import { browserActionDigestV1, browserOriginV1, dialogBlockingV1 } from "./browser-relay.ts";
import { sensitiveAutoApprovedV1, SENSITIVE_CONFIRM_ENV_V1 } from "./sensitive-actions.ts";
import { randomUUID } from "node:crypto";
import { relayClientTimeoutMs } from "./chrome-extension/relay-deadline.js";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { composeGifV1 } from "./gif-encoder.ts";
import { summarizeTraceV1 } from "./trace-summary.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
export function registerBrowserDevtoolsV1(pi: ExtensionAPI, runtime: BrowserRuntimeV1) {
	const { bindSession, client, readTabs, publishLeaseScope, leaseDenial, policyDenial, policyAuthorizedOrigins } = runtime;
	if (devtoolsEnabledByEnvironment())
		pi.registerTool(defineTool({
			name: BROWSER_DEVTOOLS_TOOL_V1,
			exposure: "model-only",
			// Pi restores never-mentioned default-active extension tools on tree navigation.
			// Without this the devtools tool comes back by itself, which also makes the
			// deferred precondition demand the deferred Subagent tools on a fork.
			defaultActive: !isDeferredByDefault(BROWSER_DEVTOOLS_TOOL_V1),
			label: "Browser Devtools",
			description: "Run page code or emulate a device viewport on a relay tab.",
			promptSnippet: "Run code in a tab (isolated world by default) or emulate a device viewport",
			promptGuidelines: [
				...BROWSER_SHARED_PROMPT_GUIDELINES,
				"evaluate defaults to an isolated world; world:\"main\" accesses page globals. Main agents need no confirmation; children need a lease.",
				"viewport changes invalidate every earlier coordinate and viewport measurement: take a fresh screenshot before the next coordinate click.",
			],
			executionMode: "sequential",
			parameters: Type.Object({
				operation: StringEnum(DEVTOOLS_OPERATIONS_V1),
				tabName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
				expression: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DEVTOOLS_EXPRESSION_CHARS_V1 })),
				world: Type.Optional(StringEnum(DEVTOOLS_WORLDS_V1)),
				awaitPromise: Type.Optional(Type.Boolean()),
				path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
				fullPage: Type.Optional(Type.Boolean()),
				format: Type.Optional(StringEnum(EXPORT_FORMATS_V1)),
				quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				requestId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_NETWORK_REQUEST_ID_CHARS_V1 })),
				viewport: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Object({
						width: Type.Integer({ minimum: 200, maximum: 5000 }),
						height: Type.Integer({ minimum: 200, maximum: 5000 }),
						deviceScaleFactor: Type.Number({ minimum: 0.1, maximum: 4 }),
						mobile: Type.Boolean(),
						touch: Type.Boolean(),
						userAgent: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
					}, { additionalProperties: false })])),
			}, { additionalProperties: false }),
			async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
				const params = rawParams as Record<string, unknown>;
				const operation = sanitizeDevtoolsOperationV1(params.operation);
				if (operation === undefined)
					throw new Error("browser_devtools operation 无效");
				const tabName = params.tabName === undefined ? undefined : safeTabName(params.tabName);
				// Reject invalid local arguments before listing tabs or reaching the relay.
				const expression = operation === "evaluate" ? sanitizeDevtoolsExpressionV1(params.expression) : undefined;
				if (operation === "evaluate" && expression === undefined)
					throw new Error(`evaluate 需要 1-${MAX_DEVTOOLS_EXPRESSION_CHARS_V1} 字符的 expression`);
				const world = operation === "evaluate" ? sanitizeDevtoolsWorldV1(params.world) : undefined;
				if (operation === "evaluate" && world === undefined)
					throw new Error("world 只能是 isolated 或 main");
				const resolvedViewport = operation === "viewport" ? resolveViewportV1(params.viewport) : undefined;
				if (operation === "viewport" && resolvedViewport === undefined)
					throw new Error(`viewport 需要 ${["reset", ...viewportPresetNamesV1()].join("/")} 或完整覆盖对象`);
				if (operation === "evaluate" && params.viewport !== undefined)
					throw new Error("viewport 不能与 evaluate 同时使用");
				if (operation === "viewport" && (params.expression !== undefined || params.world !== undefined))
					throw new Error("evaluate 参数不能与 viewport 同时使用");
				if (operation !== "screenshot_export" && (params.path !== undefined || params.fullPage !== undefined || params.format !== undefined || params.quality !== undefined))
					throw new Error("path/fullPage/format/quality 只用于 screenshot_export");
				if (operation !== "evaluate" && operation !== "viewport" && (params.expression !== undefined || params.world !== undefined))
					throw new Error("expression/world 只用于 evaluate");
				const requestId = operation === "network_body" ? safeString(params.requestId, "requestId", MAX_NETWORK_REQUEST_ID_CHARS_V1) : undefined;
				if (operation !== "network_body" && params.requestId !== undefined)
					throw new Error("requestId 只用于 network_body");
				const exportQuality = operation === "screenshot_export" ? sanitizeExportQualityV1(params.quality) : undefined;
				if (operation === "screenshot_export" && exportQuality === undefined)
					throw new Error("quality 必须是 1-100 的整数");
				const assertOwner = await bindSession(ctx, signal);
				const relayClient = await client(ctx, assertOwner);
				const listedTabs = await readTabs(relayClient, signal);
				const tab = targetTab(listedTabs, tabName);
				publishLeaseScope(relayClient);
				// Page code and page emulation are devtools: a child needs that capability in its
				// lease; the main agent only needs the site to pass its explicit blocklist.
				const denied = await leaseDenial(relayClient, "devtools", leaseOriginV1(tab.url));
				if (denied)
					return denied;
				const policyDenied = await policyDenial(relayClient, "devtools", policyOriginV1(tab.url));
				if (policyDenied)
					return policyDenied;
				const codeDigest = expression === undefined ? undefined : browserActionDigestV1(expression);
				if (operation === "evaluate" && world === "main" && relayClient.leaseToken !== undefined
					&& !sensitiveAutoApprovedV1({ origin: policyOriginV1(tab.url) ?? "", env: process.env[SENSITIVE_CONFIRM_ENV_V1] })) {
					return browserResult({ kind: "needs-approval", reason: "main-world", origin: policyOriginV1(tab.url) ?? "", message: "子 agent 不能在主世界执行代码；需要主 agent 授权。" });
				}
				let exportTarget: ExportTargetV1 | undefined;
				if (operation === "screenshot_export") {
					// Where the bytes land is decided before anything is captured, so a bad path
					// never leaves a screenshot in hand with nowhere allowed to put it.
					const resolved = await resolveExportTargetV1({ path: params.path, cwd: ctx.cwd, format: params.format });
					if (!resolved.ok)
						throw new Error(resolved.reason);
					exportTarget = resolved.target;
				}
				const actionId = `pi1_browser_devtools_${randomUUID()}`;
				pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-intent", actionId, sessionId: ctx.sessionManager.getSessionId(), branchLeafId: ctx.sessionManager.getLeafId() ?? null, toolCallId, action: `devtools:${operation}`, ...(codeDigest === undefined ? {} : { actionDigest: codeDigest }), targetDigest: browserActionDigestV1({ tabName: tab.name, tabId: tab.tabId, documentGeneration: tab.documentGeneration }), originDigest: browserActionDigestV1(browserOriginV1(tab.url)), timestamp: new Date().toISOString() });
				let raw: unknown;
				try {
					raw = await relayClient.request("devtools", {
						devtools: operation,
						tabName: tab.name,
						...{ allowedOrigins: [...policyAuthorizedOrigins] },
						...(expression === undefined ? {} : { expression, world, awaitPromise: params.awaitPromise !== false }),
						...(resolvedViewport === undefined ? {} : { viewport: resolvedViewport }),
						...(exportTarget === undefined ? {} : { format: exportTarget.format, fullPage: params.fullPage === true, quality: exportQuality }),
						...(requestId === undefined ? {} : { requestId }),
					}, { signal, timeoutMs: relayClientTimeoutMs("devtools", {}) });
				}
				catch (error) {
					// Dispatched but unproven: report unknown instead of inviting a replay.
					pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "unknown", actionAcknowledged: false, businessOutcome: "unknown", timestamp: new Date().toISOString() });
					throw new Error(`browser_devtools ${operation} 结果未知（可能已执行），不要重放：${error instanceof Error ? error.message : String(error)}`);
				}
				assertOwner();
				if (exportTarget !== undefined) {
					const data = record(raw) ? raw.data : undefined;
					if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data))
						throw new Error("browser_devtools screenshot 缺少有效数据");
					const bytes = Buffer.from(data, "base64");
					if (bytes.length === 0 || bytes.length > MAX_EXPORT_BYTES_V1)
						throw new Error(`browser_devtools screenshot 字节数超出上限（${bytes.length}）`);
					await writeExportFileV1(exportTarget.path, bytes);
					assertOwner();
					pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "ok", actionAcknowledged: true, businessOutcome: operation, timestamp: new Date().toISOString() });
					// Only the relative path reaches the model; the absolute one stays local.
					return browserResult({
						kind: "browser-export",
						relativePath: exportTarget.relativePath,
						bytes: bytes.length,
						format: exportTarget.format,
						fullPage: record(raw) && raw.fullPage === true,
						overwrote: exportTarget.exists,
						...(record(raw) && typeof raw.width === "number" ? { width: raw.width, height: raw.height } : {}),
					});
				}
				if (operation === "record_stop") {
					const rawFrames = record(raw) && Array.isArray(raw.frames) ? raw.frames : undefined;
					if (rawFrames === undefined || rawFrames.length === 0)
						throw new Error("browser_devtools record 没有帧");
					if (rawFrames.length > RECORD_MAX_FRAMES_V1)
						throw new Error(`browser_devtools record 帧数超出上限（${rawFrames.length}）`);
					const pngFrames: Buffer[] = [];
					let total = 0;
					for (const frame of rawFrames) {
						const data = record(frame) ? frame.data : undefined;
						if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data))
							throw new Error("browser_devtools record 帧数据无效");
						const bytes = Buffer.from(data, "base64");
						total += bytes.length;
						if (total > RECORD_MAX_BYTES_V1)
							throw new Error(`browser_devtools record 字节数超出上限（${total}）`);
						pngFrames.push(bytes);
					}
					// Frames and the composed GIF live in a private temp directory: a recording can
					// contain whatever the page showed.
					const recordingDir = join(tmpdir(), "rotom-recordings", `rec-${randomUUID()}`);
					await mkdir(recordingDir, { recursive: true, mode: 0o700 });
					for (const [index, bytes] of pngFrames.entries())
						await writeExportFileV1(join(recordingDir, `frame-${String(index).padStart(3, "0")}.png`), bytes);
					const composed = composeGifV1(pngFrames, { delayMs: Math.round(1000 / RECORD_FPS_V1), maxWidth: 320, maxHeight: 240 });
					const gifPath = join(recordingDir, "recording.gif");
					await writeExportFileV1(gifPath, composed.gif);
					assertOwner();
					pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "ok", actionAcknowledged: true, businessOutcome: operation, timestamp: new Date().toISOString() });
					return browserResult({
						kind: "browser-recording",
						directory: recordingDir,
						gifPath,
						frames: composed.frames,
						width: composed.width,
						height: composed.height,
						gifBytes: composed.gif.length,
						sourceBytes: total,
						fps: RECORD_FPS_V1,
						truncated: record(raw) && raw.truncated === true,
						durationMs: record(raw) && typeof raw.durationMs === "number" ? raw.durationMs : undefined,
						note: "帧与 GIF 都在私有临时目录；GIF 用 3-3-2 调色板与最近邻缩放合成",
					});
				}
				if (operation === "trace_stop") {
					const encoded = record(raw) ? raw.traceBase64 : undefined;
					if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
						throw new Error("browser_devtools trace 数据无效");
					const bytes = Buffer.from(encoded, "base64");
					if (bytes.length === 0 || bytes.length > MAX_TRACE_BYTES_V1)
						throw new Error(`browser_devtools trace 字节数超出上限（${bytes.length}）`);
					// Private temp directory: a trace can contain page URLs and script sources.
					const traceDir = join(tmpdir(), "rotom-traces");
					await mkdir(traceDir, { recursive: true, mode: 0o700 });
					const tracePath = join(traceDir, `trace-${randomUUID()}.json`);
					await writeExportFileV1(tracePath, bytes);
					const summary = summarizeTraceV1(bytes.toString("utf8"));
					assertOwner();
					pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "ok", actionAcknowledged: true, businessOutcome: operation, timestamp: new Date().toISOString() });
					return browserResult({
						kind: "browser-trace",
						path: tracePath,
						bytes: bytes.length,
						dataLossOccurred: record(raw) && raw.dataLossOccurred === true,
						...summary,
					});
				}
				pi.appendEntry(BROWSER_INTERACTION_AUDIT_ENTRY, { schemaVersion: 1, kind: "rotom-browser-interaction-terminal", actionId, status: "ok", actionAcknowledged: true, businessOutcome: operation, timestamp: new Date().toISOString() });
				const blocked = dialogBlockingV1(raw);
				if (blocked)
					return browserResult(blocked);
				const bounded = boundDevtoolsTextV1(JSON.stringify(raw ?? null));
				if (bounded.truncated)
					throw new Error("browser_devtools result 超过 64 KiB");
				return browserResult(raw);
			},
		}));
}
