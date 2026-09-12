import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";

export const BROWSER_RELAY_PROTOCOL_REVISION_V1 = 17 as const;
export const BROWSER_RELAY_FULL_READ_CAPABILITY_V1 = "virtualized-frame-scroll" as const;
export const BROWSER_RELAY_MULTI_CLIENT_CAPABILITY_V1 = "multi-client-multiplex" as const;
export const BROWSER_RELAY_COORDINATE_CLICK_CAPABILITY_V1 = "coordinate-click" as const;
export const BROWSER_RELAY_TARGET_STATE_CAPABILITY_V1 = "interaction-target-state" as const;
export const BROWSER_RELAY_PAGE_ALERT_CAPABILITY_V1 = "page-alert-readback" as const;
export const BROWSER_RELAY_KEYPRESS_CAPABILITY_V1 = "targeted-keypress" as const;
export const BROWSER_INSPECT_TOOL_V1 = "browser_inspect" as const;
export const BROWSER_INSPECT_OPERATIONS_V1 = ["open", "discover", "claim", "handoff", "tabs", "switch", "snapshot", "snapshot_visible", "read_full", "screenshot", "wait", "close", "recover"] as const;
export const BROWSER_INTERACT_TOOL_V1 = "browser_interact" as const;
export const BROWSER_INTERACT_OPERATIONS_V1 = ["execute"] as const;
export const BROWSER_INTERACTION_ACTIONS_V1 = ["click", "type", "scroll", "select", "keypress"] as const;
export const BROWSER_INTERACTION_KEYS_V1 = ["Enter", "Tab", "Escape"] as const;
export type BrowserInteractionActionV1 = (typeof BROWSER_INTERACTION_ACTIONS_V1)[number];

const MAX_WIRE_BYTES = 1024 * 1024;
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
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("browser relay 仅允许 http/https URL");
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
	scanSteps?: number;
	scannedContainers?: number;
	scrolledContainers?: number;
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
	const scanSteps = value.scanSteps === undefined ? undefined : (Number.isSafeInteger(value.scanSteps) && (value.scanSteps as number) >= 0 ? value.scanSteps as number : undefined);
	const scannedContainers = value.scannedContainers === undefined ? undefined : (Number.isSafeInteger(value.scannedContainers) && (value.scannedContainers as number) >= 0 ? value.scannedContainers as number : undefined);
	const scrolledContainers = value.scrolledContainers === undefined ? undefined : (Number.isSafeInteger(value.scrolledContainers) && (value.scrolledContainers as number) >= 0 ? value.scrolledContainers as number : undefined);
	if ((value.scanSteps !== undefined && scanSteps === undefined) || (value.scannedContainers !== undefined && scannedContainers === undefined) || (value.scrolledContainers !== undefined && scrolledContainers === undefined)) throw new Error("browser observation scan evidence 无效");
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
		...(scanSteps === undefined ? {} : { scanSteps }),
		...(scannedContainers === undefined ? {} : { scannedContainers }),
		...(scrolledContainers === undefined ? {} : { scrolledContainers }),
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

export function validateBrowserScreenshotV1(value: unknown): BrowserScreenshotV1 {
	if (!record(value) || value.schemaVersion !== 1 || value.kind !== "rotom-browser-screenshot" || value.mimeType !== "image/jpeg" || typeof value.data !== "string") throw new Error("browser screenshot schema 无效");
	const tabName = safeString(value.tabName, "tabName", 128);
	if (!Number.isSafeInteger(value.tabId) || (value.tabId as number) < 0 || !Number.isSafeInteger(value.documentGeneration) || (value.documentGeneration as number) < 1 || !Number.isSafeInteger(value.observationEpoch) || (value.observationEpoch as number) < 1) throw new Error("browser screenshot identity 无效");
	if (!record(value.viewport)) throw new Error("browser screenshot viewport 无效");
	const rawViewport = value.viewport;
	if (!["width", "height", "pageX", "pageY", "scale"].every((key) => typeof rawViewport[key] === "number" && Number.isFinite(rawViewport[key]))) throw new Error("browser screenshot viewport 无效");
	const viewport = { width: rawViewport.width as number, height: rawViewport.height as number, pageX: rawViewport.pageX as number, pageY: rawViewport.pageY as number, scale: rawViewport.scale as number };
	if (viewport.width <= 2 || viewport.height <= 2 || viewport.scale <= 0) throw new Error("browser screenshot viewport 无效");
	const plain = Buffer.from(value.data, "base64");
	if (plain.length < 4 || plain.length > 768 * 1024 || plain[0] !== 0xff || plain[1] !== 0xd8) throw new Error("browser screenshot payload 无效或超限");
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
}

// Only a missing/refused local socket proves Relay unavailable before any request.
// Timeouts, permissions, handshake/identity errors and page text are not fallback evidence.
export class BrowserRelayUnavailableErrorV1 extends Error {
	constructor(cause: Error) {
		super("browser relay 不可用；请确认 Chrome 扩展与 Native Messaging host 已安装", { cause });
		this.name = "BrowserRelayUnavailableErrorV1";
	}
}

export class BrowserRelayClientV1 {
	readonly sessionId: string;
	readonly generation: string;
	readonly socketPath: string;
	#socket: Socket;
	#buffer = "";
	#pending = new Map<string, PendingRequestV1>();
	#closed = false;

	private constructor(socket: Socket, input: BrowserRelayConnectInputV1) {
		this.#socket = socket;
		this.sessionId = safeString(input.sessionId, "sessionId", 512);
		this.generation = input.generation ?? randomUUID();
		this.socketPath = input.socketPath ?? browserRelaySocketPathV1();
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
			const ready = await client.request("hello", { nonce }, { timeoutMs: Math.max(1, handshakeRemainingMs) });
			if (!record(ready) || ready.schemaVersion !== 1 || ready.kind !== "rotom-browser-relay-ready" || ready.nonce !== nonce || !Number.isSafeInteger(ready.protocolRevision) || (ready.protocolRevision as number) < BROWSER_RELAY_PROTOCOL_REVISION_V1 || !Array.isArray(ready.capabilities) || !ready.capabilities.includes(BROWSER_RELAY_FULL_READ_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_MULTI_CLIENT_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_COORDINATE_CLICK_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_TARGET_STATE_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_PAGE_ALERT_CAPABILITY_V1) || !ready.capabilities.includes(BROWSER_RELAY_KEYPRESS_CAPABILITY_V1)) throw new Error("browser relay 版本过旧；请在 chrome://extensions 重载 Rotom Browser Relay");
			return client;
		} catch (error) {
			client.close();
			const failure = error instanceof Error ? error : new Error(String(error));
			if (/browser relay busy; another operation is active/iu.test(failure.message)) throw new Error("browser relay 协议过旧且仍使用单 client busy 仲裁；请在 chrome://extensions 重载 Rotom Browser Relay", { cause: failure });
			throw failure;
		}
	}

	get closed(): boolean { return this.#closed; }

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
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { return this.#fail(new Error("browser relay response JSON 无效")); }
			if (!record(parsed) || parsed.schemaVersion !== 1 || parsed.kind !== "response" || typeof parsed.id !== "string" || parsed.sessionId !== this.sessionId || parsed.generation !== this.generation || typeof parsed.ok !== "boolean") return this.#fail(new Error("browser relay response binding 无效"));
			const pending = this.#pending.get(parsed.id);
			if (!pending) continue;
			this.#pending.delete(parsed.id);
			clearTimeout(pending.timer);
			pending.abort?.();
			if (parsed.ok) pending.resolve(parsed.result);
			else pending.reject(new Error(typeof parsed.error === "string" ? safeModelTextV1(parsed.error, 1_024) : "browser relay request failed"));
		}
	}

	#fail(error: Error): void {
		if (!this.#closed) { this.#closed = true; this.#socket.destroy(); }
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.abort?.(); pending.reject(error); }
		this.#pending.clear();
	}
}
