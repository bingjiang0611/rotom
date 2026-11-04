#!/usr/bin/env node

// Isolated real-Chromium end-to-end harness for the browser relay.
//
// Isolation contract: every path this module creates lives under one temporary
// root. The browser gets its own --user-data-dir and reads the native host
// manifest from that profile; the native host process gets HOME pointed at the
// temporary root, so the relay socket, lock and session state never touch the
// operator's relay directory or Chrome profile. A failing run keeps the root and
// prints it; run.mjs also asserts the real product data directory is unchanged.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserRelayClientV1 } from "../../extensions/browser/browser-relay.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const extensionDir = resolve(here, "../../extensions/browser/chrome-extension");
export const nativeHostPath = resolve(here, "../../extensions/browser/native-host.mjs");
const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));

/** Chrome extension id: sha256 of the DER manifest key, first 32 hex digits mapped 0-f -> a-p. */
export function extensionIdFromKey(base64Key) {
	const der = Buffer.from(String(base64Key), "base64");
	if (der.length === 0) throw new Error("manifest key 不是有效 base64 DER");
	return [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
		.map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
		.join("");
}

export const extensionId = extensionIdFromKey(manifest.key);

const CHROME_CACHE_DIR = process.env.ROTOM_E2E_CHROME_CACHE
	?? (process.platform === "darwin"
		? join(process.env.HOME ?? tmpdir(), "Library", "Caches", "rotom-e2e")
		: join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache"), "rotom-e2e"));

const MAC_GUESSES = [
	join(CHROME_CACHE_DIR, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
	join(CHROME_CACHE_DIR, "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
];
const LINUX_GUESSES = [
	join(CHROME_CACHE_DIR, "chrome-linux64/chrome"),
	join(CHROME_CACHE_DIR, "chrome-headless-shell-linux64/chrome-headless-shell"),
];

/** Resolve the isolated browser binary. Never falls back to the operator's branded Chrome. */
export function resolveChromeExecutable() {
	const configured = process.env.ROTOM_CHROME_EXECUTABLE;
	if (configured) {
		if (!existsSync(configured)) throw new Error(`ROTOM_CHROME_EXECUTABLE 不存在：${configured}`);
		return configured;
	}
	for (const candidate of process.platform === "darwin" ? MAC_GUESSES : LINUX_GUESSES) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`找不到 Chromium/Chrome for Testing。先运行 node rotom/runtime/e2e-browser/fetch-chrome.mjs，或设置 ROTOM_CHROME_EXECUTABLE 指向 Chromium 或 Chrome for Testing（不能用正式版 Google Chrome）`);
}

function privateDirectory(path, mode = 0o700) {
	mkdirSync(path, { recursive: true, mode });
	chmodSync(path, mode);
	return path;
}

function writePrivateFile(path, content, mode = 0o600) {
	writeFileSync(path, content, { mode });
	chmodSync(path, mode);
}

/**
 * Chrome resolves native messaging hosts relative to (a) the product directory in
 * HOME and (b) the explicit --user-data-dir. Only (b) is used here: redirecting
 * HOME away from the operator's real home makes Chrome for Testing 156 on macOS
 * stop committing page navigations (reproduced with plain Chrome, no extension),
 * so the browser keeps the real HOME and every harness path lives in `root`.
 */
function nativeHostManifestDirs(profileDir) {
	return [join(profileDir, "NativeMessagingHosts")];
}

// macOS caps sun_path at 104 bytes and Linux at 108, so the temporary root must
// stay short: $TMPDIR on macOS is already ~50 bytes and the relay path adds ~60.
const TEMP_BASE = existsSync("/tmp") ? "/tmp" : tmpdir();
const MAX_SOCKET_PATH_BYTES = 100;

/** The operator's real home, captured before any harness redirect. */
function realUserHome() {
	const configured = process.env.HOME;
	return configured && configured.length > 0 ? configured : tmpdir();
}

/** PIDs whose command line names this exact temporary profile; scoped, never a global pkill. */
function survivingChromePids(profileDir) {
	const listed = spawnSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
	if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
	const needle = `--user-data-dir=${profileDir}`;
	return listed.stdout.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(.*)$/u))
		.filter((match) => match && match[2].includes(needle))
		.map((match) => Number(match[1]));
}

/** Relative inventory (path + mtime + size) of one directory tree; used for the isolation claim. */
function inventory(path) {
	if (!existsSync(path)) return ["<absent>"];
	const entries = [];
	const visit = (current, depth) => {
		if (depth > 6) return;
		let names;
		try { names = readdirSync(current, { withFileTypes: true }); } catch { return; }
		for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const child = join(current, entry.name);
			let info;
			try { info = lstatSync(child); } catch { continue; }
			entries.push(`${child}\0${info.size}\0${info.mtimeMs}`);
			if (entry.isDirectory() && !entry.isSymbolicLink()) visit(child, depth + 1);
		}
	};
	visit(path, 0);
	return entries;
}

export async function launchHarness(input = {}) {
	const chromeExecutable = input.chromeExecutable ?? resolveChromeExecutable();
	const root = mkdtempSync(join(TEMP_BASE, "rotom-e2e-"));
	// The operator's real product data must never change: snapshot it here and
	// verify it again from the suite runner.
	const realHome = realUserHome();
	const realProductPaths = [
		join(realHome, "Library", "Application Support", "rotom"),
		join(realHome, ".config", "rotom"),
	];
	const realProductBefore = realProductPaths.map((path) => inventory(path));
	const home = privateDirectory(join(root, "home"));
	const profileDir = privateDirectory(join(root, "profile"));
	const relayDir = privateDirectory(join(home, "Library", "Application Support", "rotom", "browser-relay"));
	const socketPath = join(relayDir, "relay.sock");
	privateDirectory(join(home, "Library", "Application Support"));
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`relay socket 路径过长（${Buffer.byteLength(socketPath)} 字节 > ${MAX_SOCKET_PATH_BYTES}）：${socketPath}；这是 unix socket 的 sun_path 上限，不是产品缺陷`);

	const wrapperPath = join(root, "native-host-wrapper.sh");
	const nativeHostLog = join(root, "native-host.log");
	// Chrome execs the wrapper, so it must be a plain executable file.
	writePrivateFile(wrapperPath, `#!/bin/sh\nHOME='${home}'\nexport HOME\nexec '${process.execPath}' '${nativeHostPath}' 2>>'${nativeHostLog}'\n`, 0o700);
	const hostManifest = {
		name: "dev.rotom.browser_relay",
		description: "Rotom Browser Relay e2e native host",
		path: wrapperPath,
		type: "stdio",
		allowed_origins: [`chrome-extension://${extensionId}/`],
	};
	const manifestPaths = nativeHostManifestDirs(profileDir);
	for (const dir of manifestPaths) {
		privateDirectory(dir);
		writePrivateFile(join(dir, "dev.rotom.browser_relay.json"), `${JSON.stringify(hostManifest, null, 2)}\n`);
	}

	const headless = process.env.ROTOM_E2E_HEADED !== "1";
	const verbose = process.env.ROTOM_E2E_CHROME_LOG === "1";
	const chromeArgs = [
		`--user-data-dir=${profileDir}`,
		`--disable-extensions-except=${extensionDir}`,
		`--load-extension=${extensionDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-component-update",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-features=Translate,MediaRouter,OptimizationHints",
		"--metrics-recording-only",
		"--mute-audio",
		...(process.env.ROTOM_E2E_CHROME_ARGS ? process.env.ROTOM_E2E_CHROME_ARGS.split(" ").filter(Boolean) : []),
		// Background tabs are the product default; these keep headless Chrome from
		// deferring their navigation and timers so a suite measures the relay, not throttling.
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		...(process.env.ROTOM_E2E_DEBUG_PORT ? [`--remote-debugging-port=${process.env.ROTOM_E2E_DEBUG_PORT}`] : []),
		"--window-size=1280,900",
		...(verbose ? ["--enable-logging=stderr", "--v=1"] : ["--enable-logging=stderr"]),
		...(headless ? ["--headless=new"] : []),
		"--new-window",
		"about:blank",
	];
	const chromeLogPath = join(root, "chrome.log");
	// Browser stderr is where extension manifest and debugger failures surface.
	const chromeLog = openSync(chromeLogPath, "a", 0o600);
	const chrome = spawn(chromeExecutable, chromeArgs, {
		cwd: root,
		// Chrome keeps the real HOME (see nativeHostManifestDirs); the native host
		// wrapper is what redirects HOME so the relay socket and lock stay isolated.
		env: { ...process.env, TMPDIR: root },
		detached: true,
		stdio: ["ignore", chromeLog, chromeLog],
	});

	const pause = (ms) => new Promise((done) => setTimeout(done, ms));
	const clients = new Set();
	let closed = false;

	// Suites exercise ownership, cleanup and concurrency, which need more tabs on one
	// fixture origin than the product default allows. Quotas themselves are covered by
	// the `quotas` suite through the tool layer, which reads ROTOM_BROWSER_MAX_*.
	const harnessTabQuotas = { maxAgents: 32, maxTabsPerAgent: 32, maxTabs: 64, maxTabsPerOrigin: 16 };
	const connect = async (sessionId, extra = {}) => {
		const client = await BrowserRelayClientV1.connect({ sessionId, socketPath, timeoutMs: 1_000, tabQuotas: harnessTabQuotas, ...extra });
		clients.add(client);
		return client;
	};

	const close = async () => {
		if (closed) return;
		closed = true;
		for (const client of clients) {
			try { client.close(); } catch { /* already closed */ }
		}
		clients.clear();
		try { closeSync(chromeLog); } catch { /* already closed */ }
		if (Number.isInteger(chrome.pid)) {
			try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* already exited */ }
			await pause(500);
			try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already exited */ }
		}
		// Chrome may re-exec or detach helpers out of the spawned process group, so
		// sweep whatever still names this exact profile before returning.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const survivors = survivingChromePids(profileDir);
			if (survivors.length === 0) return;
			for (const pid of survivors) {
				try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
			}
			await pause(100);
		}
		process.stdout.write(`# 警告：仍有 Chrome 进程存活（profile=${profileDir}）\n`);
	};

	const discard = () => {
		if (process.env.ROTOM_E2E_KEEP === "1") return;
		try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	};

	const realHomeUntouched = () => realProductPaths.map((path, index) => ({
		path,
		changed: JSON.stringify(inventory(path)) !== JSON.stringify(realProductBefore[index]),
	}));

	return { chromeExecutable, root, home, profileDir, socketPath, nativeHostLog, chromeLogPath, chrome, headless, connect, close, discard, realHomeUntouched };
}

/** Wait until the extension's native host relay socket accepts a handshake. */
export async function waitForRelay(harness, { timeoutMs = 30_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const client = await harness.connect("e2e-probe", { timeoutMs: 1_000 });
			client.close();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((done) => setTimeout(done, 250));
		}
	}
	throw new Error(`Chrome extension 未在 ${Math.round(timeoutMs / 1000)} 秒内建立 Native Messaging relay（HOME=${harness.home}）`, { cause: lastError });
}

/** Per-assertion reporting so a failing step names itself. */
export function createRecorder(name) {
	const results = [];
	const record = (step, ok, detail) => {
		results.push({ step, ok, detail });
		const label = ok ? "ok  " : "FAIL";
		process.stdout.write(`${label} ${name} :: ${step}${ok || detail === undefined ? "" : ` :: ${detail}`}\n`);
	};
	const recorder = {
		name,
		results,
		/** Run one assertion step; a thrown error fails only this step. */
		async check(step, fn) {
			try {
				await fn();
				record(step, true);
				return true;
			} catch (error) {
				record(step, false, error instanceof Error ? error.message : String(error));
				return false;
			}
		},
		assert(step, condition, detail) {
			try {
				assert.ok(condition, detail);
				record(step, true);
				return true;
			} catch (error) {
				record(step, false, error instanceof Error ? error.message : String(error));
				return false;
			}
		},
		get failed() { return results.filter((item) => !item.ok).length; },
	};
	return recorder;
}

/** Bind a client into a bounded request helper that names the failing stage. */
export function relayRequestFor(client, label) {
	return async (operation, payload, timeoutMs = 10_000) => {
		try {
			return await client.request(operation, payload, { timeoutMs });
		} catch (error) {
			throw new Error(`${label}/${operation} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	};
}
