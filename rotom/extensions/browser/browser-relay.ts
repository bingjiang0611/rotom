import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { RESPONSE_MAX_BYTES } from "./chrome-extension/response-chunks.js";
import { browserTabQuotasFromEnvV1 } from "./chrome-extension/tab-quotas.js";

export const BROWSER_RELAY_PROTOCOL_REVISION_V1 = 20 as const;
export const BROWSER_RELAY_FULL_READ_CAPABILITY_V1 = "virtualized-frame-scroll" as const;
export const BROWSER_RELAY_MULTI_CLIENT_CAPABILITY_V1 = "multi-client-multiplex" as const;
export const BROWSER_RELAY_COORDINATE_CLICK_CAPABILITY_V1 = "coordinate-click" as const;
export const BROWSER_RELAY_TARGET_STATE_CAPABILITY_V1 = "interaction-target-state" as const;
export const BROWSER_RELAY_PAGE_ALERT_CAPABILITY_V1 = "page-alert-readback" as const;
export const BROWSER_RELAY_KEYPRESS_CAPABILITY_V1 = "targeted-keypress" as const;
export const BROWSER_RELAY_QUERY_CAPABILITY_V1 = "snapshot-query" as const;
/** Optional capability: required only by the operations that need it, so an
 *  extension that predates cross-agent transfer still serves everything else. */
export const BROWSER_RELAY_TRANSFER_CAPABILITY_V1 = "cross-agent-transfer" as const;
export const BROWSER_MAIN_AGENT_ID_V1 = "main" as const;
/** Env vars a subagent process inherits so its relay session is attributable. */
export const ROTOM_BROWSER_AGENT_ID_ENV_V1 = "ROTOM_BROWSER_AGENT_ID" as const;
export const ROTOM_BROWSER_ROOT_SESSION_ENV_V1 = "ROTOM_BROWSER_ROOT_SESSION" as const;
export const ROTOM_BROWSER_LEASE_ENV_V1 = "ROTOM_BROWSER_LEASE" as const;
/** Interim lease knob until T9 reads keepTabs from the signed lease file. */
export const ROTOM_BROWSER_KEEP_TABS_ENV_V1 = "ROTOM_BROWSER_KEEP_TABS" as const;
const MAX_PRINCIPAL_TOKEN_CHARS = 512;

export interface BrowserPrincipalV1 {
	agentId: string;
	rootSessionId: string;
	leaseToken?: string;
	keepTabs?: boolean;
}

function principalTokenV1(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > MAX_PRINCIPAL_TOKEN_CHARS || !/^[\x21-\x7e]+$/u.test(value)) throw new Error(`${name} 不是有界的可打印 ASCII token`);
	return value;
}

/**
 * Browser principal for this process. A subagent launcher sets the three env vars;
 * everything else is the main agent of its own Pi session.
 */
export function browserPrincipalV1(sessionId: string, overrides: Partial<BrowserPrincipalV1> = {}, env: NodeJS.ProcessEnv = process.env): BrowserPrincipalV1 {
	const agentId = overrides.agentId ?? (env[ROTOM_BROWSER_AGENT_ID_ENV_V1] || undefined) ?? BROWSER_MAIN_AGENT_ID_V1;
	const rootSessionId = overrides.rootSessionId ?? (env[ROTOM_BROWSER_ROOT_SESSION_ENV_V1] || undefined) ?? sessionId;
	const leaseToken = overrides.leaseToken ?? (env[ROTOM_BROWSER_LEASE_ENV_V1] || undefined);
	const keepTabs = overrides.keepTabs ?? env[ROTOM_BROWSER_KEEP_TABS_ENV_V1] === "1";
	return {
		agentId: principalTokenV1(agentId, "agentId"),
		rootSessionId: principalTokenV1(rootSessionId, "rootSessionId"),
		...(leaseToken === undefined ? {} : { leaseToken: principalTokenV1(leaseToken, "leaseToken") }),
		...(keepTabs ? { keepTabs: true } : {}),
	};
}

export const BROWSER_INSPECT_TOOL_V1 = "browser_inspect" as const;
/** How `open` places a new tab. */
export const BROWSER_OPEN_PLACEMENTS_V1 = ["background-tab", "agent-window"] as const;
export const BROWSER_INSPECT_OPERATIONS_V1 = ["open", "discover", "claim", "transfer", "handoff", "tabs", "switch", "snapshot", "snapshot_visible", "read_full", "screenshot", "wait", "close", "recover"] as const;
export const BROWSER_INTERACT_TOOL_V1 = "browser_interact" as const;
export const BROWSER_INTERACT_OPERATIONS_V1 = ["execute"] as const;
export const BROWSER_INTERACTION_ACTIONS_V1 = ["click", "type", "scroll", "select", "keypress"] as const;
export const BROWSER_INTERACTION_KEYS_V1 = ["Enter", "Tab", "Escape"] as const;
export type BrowserInteractionActionV1 = (typeof BROWSER_INTERACTION_ACTIONS_V1)[number];

const MAX_WIRE_BYTES = 1024 * 1024;
/** Model-facing bound for a screenshot payload, before base64 decoding. */
const MAX_MODEL_SCREENSHOT_BYTES = 768 * 1024;
/** Protocol bound for a screenshot payload; a full-page capture may reach it. */
export const MAX_RELAY_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_NODES = 1_000;
const MAX_STRING_BYTES = 4_096;

export function browserRelaySocketPathV1(): string {
	return join(homedir(), "Library", "Application Support", "rotom", "browser-relay", "relay.sock");
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, name: string, maxBytes = MAX_STRING_BYTES): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${name} 不是有界非 NUL 字符串`);
	return value;
}

export function canonicalBrowserUrlV1(value: unknown): string {
	const input = safeString(value, "url", MAX_STRING_BYTES);
	const url = new URL(input);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("browser relay 仅允许 http/https URL；本地 HTML 请通过本地 HTTP 服务访问，URL 错误不授权浏览器回退");
	if (url.username || url.password) throw new Error("browser relay URL 拒绝 userinfo");
	url.username = "";
	url.password = "";
	return url.href;
}

export function browserOriginV1(value: string): string {
	return new URL(canonicalBrowserUrlV1(value)).origin;
}

export function browserActionDigestV1(value: unknown): string {
	return createHash("sha256").update(stableJsonV1(value)).digest("hex");
}

function stableJsonV1(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJsonV1).join(",")}]`;
	if (!record(value)) throw new Error("browser digest 输入必须可序列化");
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonV1(value[key])}`).join(",")}}`;
}

function safeDisplayUrlV1(value: string): string {
	try {
		const url = new URL(value);
		if (url.search) url.search = "?<redacted>";
		if (url.hash) url.hash = "#<redacted>";
		return url.href;
	} catch {
		return "[INVALID URL]";
	}
}

function safeModelTextV1(value: unknown, maxBytes = 1_024): string {
	if (typeof value !== "string") return "";
	const bounded = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
	return bounded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

export interface BrowserObservationNodeV1 {
	ref: string;
	role: string;
	name: string;
	states?: readonly string[];
}

export interface BrowserObservationV1 {
	schemaVersion: 1;
	kind: "rotom-browser-observation";
	tabName: string;
	tabId: number;
	documentGeneration: number;
	observationEpoch: number;
	url: string;
	origin: string;
	title: string;
	status: "loading" | "complete";
	nodes: BrowserObservationNodeV1[];
	truncated: boolean;
	contentCoverage: "rendered-dom" | "scroll-end";
	contentComplete: boolean;
	visibilityState?: "visible" | "hidden";
	omittedUnchangedTextNodes?: number;
	textBaselineEpoch?: number;
	scanSteps?: number;
	scannedContainers?: number;
	scrolledContainers?: number;
	selection?: { text?: string; role?: string; sourceNodes: number; scannedAxNodes: number; scanTruncated: boolean; matchesTruncated: boolean };
	digest: string;
}

export function sanitizeBrowserObservationV1(value: unknown): BrowserObservationV1 {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-observation") throw new Error("browser observation schema 无效");
	const tabName = safeString(value.tabName, "tabName", 128);
	if (!Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0) throw new Error("browser observation tabId 无效");
	if (!Number.isSafeInteger(value.documentGeneration) || (value.documentGeneration as number) < 1) throw new Error("browser observation documentGeneration 无效");
	if (!Number.isSafeInteger(value.observationEpoch) || (value.observationEpoch as number) < 1) throw new Error("browser observation observationEpoch 无效；请重载 Chrome 扩展");
	const canonicalUrl = canonicalBrowserUrlV1(value.url);
	const status = value.status === "loading" || value.status === "complete" ? value.status : undefined;
	if (!status || !Array.isArray(value.nodes)) throw new Error("browser observation status/nodes 无效");
	const contentCoverage = value.contentCoverage === "rendered-dom" || value.contentCoverage === "scroll-end" ? value.contentCoverage : undefined;
	if (!contentCoverage || typeof value.contentComplete !== "boolean") throw new Error("browser observation coverage 无效；请重载 Chrome 扩展");
	if (value.contentComplete === true && contentCoverage !== "scroll-end") throw new Error("browser observation complete 缺少 scroll-end 证据");
	const hasTextDelta = value.omittedUnchangedTextNodes !== undefined || value.textBaselineEpoch !== undefined;
	if (hasTextDelta && (!Number.isSafeInteger(value.omittedUnchangedTextNodes) || (value.omittedUnchangedTextNodes as number) < 1
		|| !Number.isSafeInteger(value.textBaselineEpoch) || (value.textBaselineEpoch as number) < 1 || (value.textBaselineEpoch as number) >= (value.observationEpoch as number)
		|| contentCoverage !== "rendered-dom" || value.contentComplete !== false)) throw new Error("browser observation text delta 无效");
	const visibilityState = value.visibilityState === "visible" || value.visibilityState === "hidden" ? value.visibilityState : undefined;
	if (value.visibilityState !== undefined && visibilityState === undefined) throw new Error("browser observation visibilityState 无效；请重载 Chrome 扩展");
	const scanSteps = value.scanSteps === undefined ? undefined : (Number.isSafeInteger(value.scanSteps) && (value.scanSteps as number) >= 0 ? value.scanSteps as number : undefined);
	const scannedContainers = value.scannedContainers === undefined ? undefined : (Number.isSafeInteger(value.scannedContainers) && (value.scannedContainers as number) >= 0 ? value.scannedContainers as number : undefined);
	const scrolledContainers = value.scrolledContainers === undefined ? undefined : (Number.isSafeInteger(value.scrolledContainers) && (value.scrolledContainers as number) >= 0 ? value.scrolledContainers as number : undefined);
	if ((value.scanSteps !== undefined && scanSteps === undefined) || (value.scannedContainers !== undefined && scannedContainers === undefined) || (value.scrolledContainers !== undefined && scrolledContainers === undefined)) throw new Error("browser observation scan evidence 无效");
	let selection: BrowserObservationV1["selection"];
	if (value.selection !== undefined) {
		const query = value.selection;
		if (!record(query) || (query.text === undefined && query.role === undefined)
			|| !Number.isSafeInteger(query.sourceNodes) || (query.sourceNodes as number) < value.nodes.length
			|| !Number.isSafeInteger(query.scannedAxNodes) || (query.scannedAxNodes as number) < 0
			|| typeof query.scanTruncated !== "boolean" || typeof query.matchesTruncated !== "boolean"
			|| ((query.scanTruncated || query.matchesTruncated) && value.truncated !== true)
			|| contentCoverage !== "rendered-dom" || value.contentComplete !== false || hasTextDelta) throw new Error("browser observation selection evidence 无效");
		for (const [key, max] of [["text", 256], ["role", 128]] as const) {
			const input = query[key];
			if (input !== undefined && (typeof input !== "string" || input.length < 1 || input.length > max || input.includes("\0"))) throw new Error(`browser observation selection.${key} 无效`);
		}
		selection = { ...(query.text === undefined ? {} : { text: query.text as string }), ...(query.role === undefined ? {} : { role: query.role as string }),
			sourceNodes: query.sourceNodes as number, scannedAxNodes: query.scannedAxNodes as number, scanTruncated: query.scanTruncated,
			matchesTruncated: query.matchesTruncated || value.nodes.length > MAX_MODEL_NODES };
	}
	const nodes = value.nodes.slice(0, MAX_MODEL_NODES).map((node, index) => {
		if (!record(node)) throw new Error(`browser observation node ${index} 无效`);
		const ref = safeString(node.ref, `node[${index}].ref`, 128);
		const role = safeModelTextV1(node.role, 128);
		const name = safeModelTextV1(node.name, 1_024);
		const states = Array.isArray(node.states) ? node.states.slice(0, 16).map((item) => safeModelTextV1(item, 128)).filter(Boolean) : [];
		return { ref, role, name, ...(states.length ? { states } : {}) };
	});
	const publicValue = {
		schemaVersion: 1 as const,
		kind: "rotom-browser-observation" as const,
		tabName,
		tabId: value.tabId as number,
		documentGeneration: value.documentGeneration as number,
		observationEpoch: value.observationEpoch as number,
		url: safeDisplayUrlV1(canonicalUrl),
		origin: new URL(canonicalUrl).origin,
		title: safeModelTextV1(value.title, 1_024),
		status,
		nodes,
		truncated: value.truncated === true || value.nodes.length > MAX_MODEL_NODES,
		contentCoverage,
		contentComplete: value.contentComplete === true && value.truncated !== true && value.nodes.length <= MAX_MODEL_NODES,
		...(hasTextDelta ? { omittedUnchangedTextNodes: value.omittedUnchangedTextNodes as number, textBaselineEpoch: value.textBaselineEpoch as number } : {}),
		...(visibilityState === undefined ? {} : { visibilityState }),
		...(scanSteps === undefined ? {} : { scanSteps }),
		...(scannedContainers === undefined ? {} : { scannedContainers }),
		...(scrolledContainers === undefined ? {} : { scrolledContainers }),
		...(selection ? { selection } : {}),
	};
	return { ...publicValue, digest: browserActionDigestV1(publicValue) };
}

// effect 里有一部分字段源于页面（hit 节点名、目标状态迁移），跟 observation node 一样
// 只限制长度并清理控制字符，不扫描或替换凭据形状文本。形状越界则 fail closed——那说明 extension 与
// 宣告的 protocol revision 不一致，不应静默当成普通结果。
const MAX_EFFECT_KEYS = 16;
const MAX_EFFECT_ITEMS = 16;

function sanitizeEffectLeafV1(value: unknown, depth: number): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("browser interaction effect 含非有限数字"); return value; }
	if (typeof value === "string") return safeModelTextV1(value, 256);
	if (Array.isArray(value)) {
		if (value.length > MAX_EFFECT_ITEMS) throw new Error("browser interaction effect 数组超限");
		return value.map((item) => sanitizeEffectLeafV1(item, depth));
	}
	if (record(value)) {
		// Date、Map 之类宿主对象的 own keys 为空，静默归一会把它们平成 `{}`，把契约漂移伪装成空证据。
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error("browser interaction effect 含非 plain object");
		if (depth <= 0) throw new Error("browser interaction effect 嵌套过深");
		const keys = Object.keys(value);
		if (keys.length > MAX_EFFECT_KEYS) throw new Error("browser interaction effect 字段过多");
		const result: Record<string, unknown> = {};
		for (const key of keys) {
			if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(key)) throw new Error("browser interaction effect 字段名无效");
			result[key] = sanitizeEffectLeafV1(value[key], depth - 1);
		}
		return result;
	}
	throw new Error("browser interaction effect 含不可读取的值");
}

export function sanitizeBrowserInteractionEffectV1(value: unknown): Record<string, unknown> {
	if (!record(value)) throw new Error("browser interaction effect 无效");
	return sanitizeEffectLeafV1(value, 2) as Record<string, unknown>;
}

export function browserInteractionExpectationOutcomeV1(effect: Record<string, unknown> | undefined): "met" | "unmet" | "unknown" | undefined {
	const expectation = effect?.expectation;
	if (!record(expectation)) return undefined;
	return expectation.outcome === "met" || expectation.outcome === "unmet" ? expectation.outcome : "unknown";
}

export interface BrowserScreenshotV1 {
	schemaVersion: 1;
	kind: "rotom-browser-screenshot";
	tabName: string;
	tabId: number;
	documentGeneration: number;
	observationEpoch: number;
	viewport: { width: number; height: number; pageX: number; pageY: number; scale: number };
	mimeType: "image/jpeg";
	data: string;
}

export function validateBrowserScreenshotV1(value: unknown, maxBytes = MAX_MODEL_SCREENSHOT_BYTES): BrowserScreenshotV1 {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-screenshot" || value.mimeType !== "image/jpeg" || typeof value.data !== "string") throw new Error("browser screenshot schema 无效");
	const tabName = safeString(value.tabName, "tabName", 128);
	if (!Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0 || !Number.isSafeInteger(value.documentGeneration) || (value.documentGeneration as number) < 1 || !Number.isSafeInteger(value.observationEpoch) || (value.observationEpoch as number) < 1) throw new Error("browser screenshot identity 无效");
	if (!record(value.viewport)) throw new Error("browser screenshot viewport 无效");
	const rawViewport = value.viewport;
	if (!["width", "height", "pageX", "pageY", "scale"].every((key) => typeof rawViewport[key] === "number" && Number.isFinite(rawViewport[key]))) throw new Error("browser screenshot viewport 无效");
	const viewport = { width: rawViewport.width as number, height: rawViewport.height as number, pageX: rawViewport.pageX as number, pageY: rawViewport.pageY as number, scale: rawViewport.scale as number };
	if (viewport.width <= 2 || viewport.height <= 2 || viewport.scale <= 0) throw new Error("browser screenshot viewport 无效");
	const plain = Buffer.from(value.data, "base64");
	if (plain.length < 4 || plain.length > maxBytes || plain[0] !== 0xff || plain[1] !== 0xd8) throw new Error("browser screenshot payload 无效或超限");
	return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName, tabId: value.tabId as number, documentGeneration: value.documentGeneration as number, observationEpoch: value.observationEpoch as number, viewport, mimeType: "image/jpeg", data: value.data };
}

export interface BrowserScreenshotArtifactV1 {
	schemaVersion: 1;
	kind: "rotom-browser-screenshot-artifact";
	artifactId: string;
	mimeType: "image/jpeg";
	bytes: number;
	sha256: string;
	encryptedAtRest: true;
}

export class BrowserArtifactStoreV1 {
	readonly rootDir: string;
	#key = randomBytes(32);
	#files = new Map<string, string>();
	#closed = false;
	#pending = new Set<Promise<BrowserScreenshotArtifactV1>>();
	#closing?: Promise<void>;

	private constructor(rootDir: string) { this.rootDir = rootDir; }

	static async open(): Promise<BrowserArtifactStoreV1> {
		const root = await mkdtemp(join(tmpdir(), "rotom-browser-artifacts-"));
		await chmod(root, 0o700);
		const info = await lstat(root);
		if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("browser artifact root 不是 private directory");
		return new BrowserArtifactStoreV1(root);
	}

	async storeScreenshot(value: unknown): Promise<BrowserScreenshotArtifactV1> {
		if (this.#closed) throw new Error("browser artifact store 已关闭");
		const pending = this.#storeScreenshot(value);
		this.#pending.add(pending);
		try { return await pending; } finally { this.#pending.delete(pending); }
	}

	async #storeScreenshot(value: unknown): Promise<BrowserScreenshotArtifactV1> {
		const screenshot = validateBrowserScreenshotV1(value);
		const plain = Buffer.from(screenshot.data, "base64");
		const artifactId = `pi1_browser_artifact_${randomUUID()}`;
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		const aad = Buffer.from(`${artifactId}\0image/jpeg\0${plain.length}`, "utf8");
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
		const tag = cipher.getAuthTag();
		const path = join(this.rootDir, `${artifactId}.bin`);
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		this.#files.set(artifactId, path);
		try {
			await handle.writeFile(Buffer.concat([Buffer.from("PIBRART1", "ascii"), iv, tag, ciphertext]));
			await handle.sync();
		} finally { await handle.close(); }
		if (this.#closed) throw new Error("browser artifact store 已关闭; screenshot publication retired");
		return { schemaVersion: 1, kind: "rotom-browser-screenshot-artifact", artifactId, mimeType: "image/jpeg", bytes: plain.length, sha256: createHash("sha256").update(plain).digest("hex"), encryptedAtRest: true };
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		return this.#closing = this.#cleanup();
	}

	async #cleanup(): Promise<void> {
		// Drain only this store's admitted I/O; close is not cancellation of writes.
		await Promise.allSettled([...this.#pending]);
		const errors: unknown[] = [];
		for (const path of this.#files.values()) {
			try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("browser artifact identity 漂移"); await unlink(path); }
			catch (error) { errors.push(error); }
		}
		this.#files.clear();
		try { await rmdir(this.rootDir); } catch (error) { errors.push(error); }
		this.#key.fill(0);
		if (errors.length) throw new AggregateError(errors, "browser artifact cleanup 未完整确认");
	}
}

type ReassemblingResponseV1 = {
	count: number;
	sha256: string;
	parts: Map<number, string>;
	bytes: number;
};

type PendingRequestV1 = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	abort?: () => void;
};

export interface BrowserRelayConnectInputV1 {
	sessionId: string;
	generation?: string;
	socketPath?: string;
	timeoutMs?: number;
	principal?: Partial<BrowserPrincipalV1>;
	/** Test-only override; production reads ROTOM_BROWSER_MAX_* from the environment. */
	tabQuotas?: ReturnType<typeof browserTabQuotasFromEnvV1>;
}

// Only a missing/refused local socket proves Relay unavailable before any request.
// Timeouts, permissions, handshake/identity errors and page text are not fallback evidence.
export class BrowserRelayUnavailableErrorV1 extends Error {
	constructor(cause: Error) {
		const code = (cause as NodeJS.ErrnoException).code;
		const reason = code === "ENOENT" ? "本机 socket 缺失（ENOENT）" : code === "ECONNREFUSED" ? "本机 socket 拒绝连接（ECONNREFUSED）" : "本机 socket 缺失或拒绝连接";
		super(`browser relay 不可用：${reason}；这不证明未安装，请用 /browser status 只读核对连接状态`, { cause });
		this.name = "BrowserRelayUnavailableErrorV1";
	}
}

export class BrowserRelayClientV1 {
	readonly sessionId: string;
	readonly agentId: string;
	readonly rootSessionId: string;
	readonly generation: string;
	readonly socketPath: string;
	/** Operator overrides for the tab quotas; sent once per handshake. */
	readonly tabQuotas: ReturnType<typeof browserTabQuotasFromEnvV1>;
	#socket: Socket;
	#leaseToken: string | undefined;
	#keepTabs = false;
	#capabilities: string[] = [];
	#buffer = "";
	#pending = new Map<string, PendingRequestV1>();
	#chunks = new Map<string, ReassemblingResponseV1>();
	#closed = false;

	private constructor(socket: Socket, input: BrowserRelayConnectInputV1) {
		this.#socket = socket;
		this.sessionId = safeString(input.sessionId, "sessionId", 512);
		const principal = browserPrincipalV1(this.sessionId, input.principal);
		this.agentId = principal.agentId;
		this.rootSessionId = principal.rootSessionId;
		this.#leaseToken = principal.leaseToken;
		this.#keepTabs = principal.keepTabs === true;
		this.generation = input.generation ?? randomUUID();
		this.socketPath = input.socketPath ?? browserRelaySocketPathV1();
		this.tabQuotas = input.tabQuotas ?? browserTabQuotasFromEnvV1(process.env);
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => this.#onData(chunk));
		socket.on("error", (error) => this.#fail(error));
		socket.on("close", () => this.#fail(new Error("browser relay socket 已关闭")));
	}

	static async connect(input: BrowserRelayConnectInputV1): Promise<BrowserRelayClientV1> {
		const socketPath = input.socketPath ?? browserRelaySocketPathV1();
		const timeoutMs = input.timeoutMs ?? 30_000;
		const deadline = Date.now() + timeoutMs;
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = connect(socketPath);
			const timer = setTimeout(() => { candidate.destroy(); reject(new Error("browser relay 连接超时；请确认 Chrome 扩展已启用")); }, Math.max(1, Math.min(3_000, timeoutMs)));
			candidate.once("connect", () => { clearTimeout(timer); resolve(candidate); });
			candidate.once("error", (error: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				reject(error.code === "ENOENT" || error.code === "ECONNREFUSED"
					? new BrowserRelayUnavailableErrorV1(error)
					: new Error("browser relay 连接失败；请检查本机配置与权限", { cause: error }));
			});
		});
		const client = new BrowserRelayClientV1(socket, { ...input, socketPath });
		try {
			const handshakeRemainingMs = deadline - Date.now();
			if (handshakeRemainingMs <= 0) throw new Error("browser relay 连接超时；请确认 Chrome 扩展已启用");
			const nonce = randomUUID();
			const ready = await client.request("hello", {
				nonce,
				agentId: client.agentId,
				rootSessionId: client.rootSessionId,
				...(client.#leaseToken === undefined ? {} : { leaseToken: client.#leaseToken }),
				...(client.#keepTabs ? { keepTabs: true } : {}),
				tabQuotas: client.tabQuotas,
			}, { timeoutMs: Math.max(1, handshakeRemainingMs) });
			if (!record(ready) || ready.schemaVersion !== 1 || ready.kind !== "rotom-browser-relay-ready" || ready.nonce !== nonce || !Number.isSafeInteger(ready.protocolRevision) || (ready.protocolRevision as number) < BROWSER_RELAY_PROTOCOL_REVISION_V1 || !Array.isArray(ready.capabilities) || !ready.capabilities.includes(BROWSER_RELAY_FULL_READ_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_MULTI_CLIENT_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_COORDINATE_CLICK_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_TARGET_STATE_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_PAGE_ALERT_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_KEYPRESS_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_QUERY_CAPABILITY_V1)) throw new Error("browser relay 版本过旧；请在 chrome://extensions 重载 Rotom Browser Relay");
			// An older extension ignores the principal fields, so absence stays compatible;
			// a different reported identity means this handshake landed on another principal.
			if ((ready.agentId !== undefined && ready.agentId !== client.agentId) || (ready.rootSessionId !== undefined && ready.rootSessionId !== client.rootSessionId)) throw new Error("browser relay 返回的 browser principal 与本进程不一致；请重载 Rotom Browser Relay");
			client.#capabilities = (ready.capabilities as unknown[]).filter((value): value is string => typeof value === "string");
			return client;
		} catch (error) {
			client.close();
			const failure = error instanceof Error ? error : new Error(String(error));
			if (/browser relay busy; another operation is active/iu.test(failure.message)) throw new Error("browser relay 协议过旧且仍使用单 client busy 仲裁；请在 chrome://extensions 重载 Rotom Browser Relay", { cause: failure });
			throw failure;
		}
	}

	get closed(): boolean { return this.#closed; }
	/** Lease token this session was started with; absent for the main agent. */
	get leaseToken(): string | undefined { return this.#leaseToken; }
	get keepTabs(): boolean { return this.#keepTabs; }

	/** Refuse an operation locally when the installed extension cannot serve it. */
	requireCapability(capability: string, message: string): void {
		if (!this.#capabilities.includes(capability)) throw new Error(message);
	}

	async request(operation: string, payload: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
		if (this.#closed) throw new Error("browser relay client 已关闭");
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("browser relay request aborted");
		const id = randomUUID();
		const message = { schemaVersion: 1, kind: "request", id, sessionId: this.sessionId, generation: this.generation, operation: safeString(operation, "operation", 128), payload };
		const encoded = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(encoded, "utf8") > MAX_WIRE_BYTES) throw new Error("browser relay request 超过 1 MiB");
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new Error(`browser relay ${operation} timeout`);
				this.#pending.delete(id);
				reject(error);
				this.#fail(error);
			}, options.timeoutMs ?? 30_000);
			const pending: PendingRequestV1 = { resolve, reject, timer };
			if (options.signal) {
				const abort = () => {
					const error = options.signal!.reason instanceof Error ? options.signal!.reason : new Error("browser relay request aborted");
					this.#pending.delete(id);
					clearTimeout(timer);
					options.signal!.removeEventListener("abort", abort);
					reject(error);
					this.#fail(error);
				};
				options.signal.addEventListener("abort", abort, { once: true });
				pending.abort = () => options.signal!.removeEventListener("abort", abort);
			}
			this.#pending.set(id, pending);
		});
		const write = new Promise<void>((resolve, reject) => {
			this.#socket.write(encoded, (error) => error ? reject(error) : resolve());
		});
		try { await write; }
		catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const pending = this.#pending.get(id);
			if (pending) { this.#pending.delete(id); clearTimeout(pending.timer); pending.abort?.(); pending.reject(failure); }
			this.#fail(failure);
		}
		return result;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.destroy();
		this.#fail(new Error("browser relay client closed"));
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		if (Buffer.byteLength(this.#buffer, "utf8") > MAX_WIRE_BYTES * 2) return this.#fail(new Error("browser relay response buffer 超限"));
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			let frame: unknown;
			try { frame = JSON.parse(line); } catch { return this.#fail(new Error("browser relay response JSON 无效")); }
			if (!record(frame) || frame.schemaVersion !== 1 || (frame.kind !== "response" && frame.kind !== "response-chunk")
				|| typeof frame.id !== "string" || frame.sessionId !== this.sessionId || frame.generation !== this.generation) return this.#fail(new Error("browser relay response binding 无效"));
			if (frame.kind === "response-chunk") {
				let message: { id: string; text: string } | undefined;
				try { message = this.#acceptChunk(frame.id, frame.chunk); } catch (error) { return this.#fail(error instanceof Error ? error : new Error(String(error))); }
				if (!message) continue;
				let reassembled: unknown;
				try { reassembled = JSON.parse(message.text); } catch { return this.#fail(new Error("browser relay response JSON 无效")); }
				if (!record(reassembled) || reassembled.kind !== "response" || reassembled.id !== message.id || typeof reassembled.ok !== "boolean") return this.#fail(new Error("browser relay response binding 无效"));
				frame = reassembled;
			} else if (typeof frame.ok !== "boolean") return this.#fail(new Error("browser relay response binding 无效"));
			const pending = this.#pending.get(frame.id as string);
			if (!pending) continue;
			this.#pending.delete(frame.id as string);
			clearTimeout(pending.timer);
			pending.abort?.();
			if (frame.ok) pending.resolve(frame.result);
			else pending.reject(new Error(typeof frame.error === "string" ? safeModelTextV1(frame.error, 1_024) : "browser relay request failed"));
		}
	}

	/** Collect one chunk; returns the verified message only after the last one. */
	#acceptChunk(id: string, raw: unknown): { id: string; text: string } | undefined {
		if (!record(raw) || !Number.isSafeInteger(raw.index) || !Number.isSafeInteger(raw.count) || typeof raw.data !== "string" || typeof raw.sha256 !== "string") throw new Error("browser relay response chunk 无效");
		const index = raw.index as number; const count = raw.count as number;
		if (index < 0 || count < 1 || index >= count) throw new Error("browser relay response chunk 无效");
		let partial = this.#chunks.get(id);
		if (!partial) {
			// The first chunk of an unknown response must be index 0; anything else
			// means the head was lost on the way here.
			if (index !== 0) throw new Error("browser relay response chunk 顺序无效");
			partial = { count, sha256: raw.sha256, parts: new Map(), bytes: 0 };
			this.#chunks.set(id, partial);
		}
		if (partial.count !== count || partial.sha256 !== raw.sha256) throw new Error("browser relay response chunk 契约不一致");
		if (index !== partial.parts.size) throw new Error(partial.parts.has(index) ? "browser relay response chunk 重复" : "browser relay response chunk 缺失或乱序");
		partial.parts.set(index, raw.data);
		partial.bytes += Buffer.byteLength(raw.data, "utf8");
		if (partial.bytes > RESPONSE_MAX_BYTES) throw new Error("browser relay response 超过上限");
		if (partial.parts.size < count) return undefined;
		this.#chunks.delete(id);
		let text = "";
		for (let position = 0; position < count; position += 1) text += partial.parts.get(position) ?? "";
		// The digest covers the exact text the service worker hashed; a mismatch means
		// corrupted or substituted content, never a usable result.
		if (createHash("sha256").update(text, "utf8").digest("hex") !== partial.sha256) throw new Error("browser relay response 摘要不匹配");
		return { id, text };
	}

	#fail(error: Error): void {
		if (!this.#closed) { this.#closed = true; this.#socket.destroy(); }
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.abort?.(); pending.reject(error); }
		this.#pending.clear();
	}
}
