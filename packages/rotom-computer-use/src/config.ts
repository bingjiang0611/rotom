import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ComputerUseConfig {
	browser_use: boolean;
	headless: boolean;
	cursor_overlay: boolean;
	managed_browser: "helium" | "chrome";
	/** Cross-process write arbitration through the Desktop Broker. */
	broker: boolean;
	/** Write the local Computer Use trace (metadata + redacted evidence). */
	trace: boolean;
	/** Save observation screenshots into the trace. */
	trace_screenshots: boolean;
	/** Put the user's previous clipboard text back after a `clipboard set`. */
	clipboard_restore: boolean;
}

export interface ComputerUseConfigSource {
	path: string;
	exists: boolean;
	values?: Partial<ComputerUseConfig>;
	error?: string;
}

export interface LoadedComputerUseConfig {
	config: ComputerUseConfig;
	sources: ComputerUseConfigSource[];
	env: Partial<ComputerUseConfig>;
}

const DEFAULT_CONFIG: ComputerUseConfig = {
	browser_use: true,
	headless: false,
	cursor_overlay: true,
	managed_browser: "chrome",
	// macOS is the platform with the cross-process arbiter. Other platforms keep
	// the previous per-process behavior until their helper grows the same surface.
	broker: process.platform === "darwin",
	trace: true,
	trace_screenshots: true,
	clipboard_restore: true,
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {} };

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

function normalizePartial(raw: unknown): Partial<ComputerUseConfig> {
	if (!raw || typeof raw !== "object") return {};
	const source = (raw as any).computer_use && typeof (raw as any).computer_use === "object" ? (raw as any).computer_use : raw;
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean((source as any).browser_use);
	const headless = parseBoolean((source as any).headless);
	const cursorOverlay = parseBoolean((source as any).cursor_overlay);
	const broker = parseBoolean((source as any).broker);
	const trace = parseBoolean((source as any).trace);
	const traceScreenshots = parseBoolean((source as any).trace_screenshots);
	const clipboardRestore = parseBoolean((source as any).clipboard_restore);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (broker !== undefined) out.broker = broker;
	if (trace !== undefined) out.trace = trace;
	if (traceScreenshots !== undefined) out.trace_screenshots = traceScreenshots;
	if (clipboardRestore !== undefined) out.clipboard_restore = clipboardRestore;
	const managedBrowser = (source as any).managed_browser;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	return out;
}

function readConfigFile(filePath: string): ComputerUseConfigSource {
	if (!existsSync(filePath)) return { path: filePath, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
		return { path: filePath, exists: true, values: normalizePartial(parsed) };
	} catch (error) {
		return { path: filePath, exists: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function readEnv(): Partial<ComputerUseConfig> {
	const out: Partial<ComputerUseConfig> = {};
	const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
	const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
	const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
	const broker = parseBoolean(process.env.ROTOM_CU_BROKER);
	// ROTOM_CU_TRACE=0 is the documented hard off switch for the trace.
	const trace = parseBoolean(process.env.ROTOM_CU_TRACE);
	const traceScreenshots = parseBoolean(process.env.ROTOM_CU_TRACE_SCREENSHOTS);
	const clipboardRestore = parseBoolean(process.env.ROTOM_CU_CLIPBOARD_RESTORE);
	if (browserUse !== undefined) out.browser_use = browserUse;
	if (headless !== undefined) out.headless = headless;
	if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
	if (broker !== undefined) out.broker = broker;
	if (trace !== undefined) out.trace = trace;
	if (traceScreenshots !== undefined) out.trace_screenshots = traceScreenshots;
	if (clipboardRestore !== undefined) out.clipboard_restore = clipboardRestore;
	const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
	if (managedBrowser === "helium" || managedBrowser === "chrome") out.managed_browser = managedBrowser;
	return out;
}

/**
 * Pi's own agent directory.
 *
 * Resolved through Pi itself instead of a static import so this module — and
 * every module that reads configuration — loads in a checkout without the peer
 * package installed. That is what lets `node --test` run on a clean clone
 * (review I3); inside Pi the package is always present, and a missing one is a
 * real installation error that must surface rather than be guessed around.
 */
async function piAgentDir(): Promise<string> {
	const peer = await import("@earendil-works/pi-coding-agent");
	return peer.getAgentDir();
}

export async function loadComputerUseConfig(cwd: string): Promise<LoadedComputerUseConfig> {
	const agentDir = await piAgentDir();
	const sources = [
		readConfigFile(path.join(agentDir, "extensions", "pi-computer-use.json")),
		readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
	];
	const env = readEnv();
	const config = { ...DEFAULT_CONFIG };
	for (const source of sources) {
		if (source.values) Object.assign(config, source.values);
	}
	Object.assign(config, env);
	activeConfig = config;
	activeLoadedConfig = { config, sources, env };
	return activeLoadedConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
	return activeConfig;
}

export function getLoadedComputerUseConfig(): LoadedComputerUseConfig {
	return activeLoadedConfig;
}

export function isHeadlessMode(): boolean {
	return activeConfig.headless;
}

export function isBrowserUseEnabled(): boolean {
	return activeConfig.browser_use;
}
