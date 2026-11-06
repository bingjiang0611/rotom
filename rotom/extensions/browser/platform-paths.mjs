// Where the browser relay keeps its socket, its lock, and the native messaging host
// registration, per platform and per Chromium-family browser.
//
// macOS paths are frozen: an upgrade must reconnect to the relay that is already
// installed, so these strings are a compatibility contract, not an implementation
// detail. Linux and Windows are declared here and covered by unit tests; Windows has
// no live verification yet, because it cannot be run in this environment.

import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const NATIVE_HOST_NAME_V1 = "dev.rotom.browser_relay";
export const BROWSER_IDS_V1 = Object.freeze(["chrome", "chromium", "edge", "brave", "vivaldi", "arc"]);

// Per-browser registration locations. `arc` is macOS-only here: Arc ships no Linux or
// Windows native-messaging host directory we could verify, so it is not offered there.
const MACOS_VENDOR_DIRS_V1 = Object.freeze({
	chrome: "Google/Chrome",
	chromium: "Chromium",
	edge: "Microsoft Edge",
	brave: "BraveSoftware/Brave-Browser",
	vivaldi: "Vivaldi",
	arc: "Arc",
});
const LINUX_VENDOR_DIRS_V1 = Object.freeze({
	chrome: "google-chrome",
	chromium: "chromium",
	edge: "microsoft-edge",
	brave: "BraveSoftware/Brave-Browser",
	vivaldi: "vivaldi",
});
const WINDOWS_REGISTRY_ROOTS_V1 = Object.freeze({
	chrome: "Google\\Chrome",
	chromium: "Chromium",
	edge: "Microsoft\\Edge",
	brave: "BraveSoftware\\Brave-Browser",
	vivaldi: "Vivaldi",
});

function platformOf(value) {
	const platform = value ?? process.platform;
	if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("browser relay 不支持的平台");
	return platform;
}

function environmentOf(value) {
	return value ?? process.env;
}

/** Browsers whose native messaging host this platform can actually register. */
export function browserIdsV1(platform) {
	const resolved = platform ?? process.platform;
	// Pure capability probe: an unsupported platform has no registration path to offer,
	// while the path functions below still refuse instead of inventing one.
	if (resolved !== "darwin" && resolved !== "linux" && resolved !== "win32") return [];
	if (resolved === "darwin") return [...BROWSER_IDS_V1];
	if (resolved === "linux") return Object.keys(LINUX_VENDOR_DIRS_V1);
	return Object.keys(WINDOWS_REGISTRY_ROOTS_V1);
}

/**
 * Hash of the user name, not of the home directory: a named pipe must be stable across
 * sessions and must not spell out a local account name.
 */
export function browserRelayUserHashV1(user) {
	const name = user ?? userInfo().username;
	if (typeof name !== "string" || name.length === 0) throw new Error("browser relay user 无效");
	return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
}

/** Directory that holds the socket (except on Windows) and the relay lock file. */
export function browserRelayDirectoryV1(options = {}) {
	const platform = platformOf(options.platform);
	const env = environmentOf(options.env);
	const home = options.home ?? homedir();
	// macOS：保持原路径，旧安装升级后仍连得上。
	if (platform === "darwin") return join(home, "Library", "Application Support", "rotom", "browser-relay");
	if (platform === "linux") {
		const runtime = env.XDG_RUNTIME_DIR;
		const base = typeof runtime === "string" && runtime.startsWith("/") ? runtime : join(home, ".local", "state");
		return join(base, "rotom", "browser-relay");
	}
	return join(home, "AppData", "Local", "rotom", "browser-relay");
}

export function browserRelaySocketPathV1(options = {}) {
	const platform = platformOf(options.platform);
	if (platform === "win32") return `\\\\.\\pipe\\rotom-browser-relay-${browserRelayUserHashV1(options.user)}`;
	return join(browserRelayDirectoryV1(options), "relay.sock");
}

export function browserRelayLockPathV1(options = {}) {
	return join(browserRelayDirectoryV1(options), "relay.lock");
}

/** `Chrome`-style registration key for the native host, or undefined when unknown. */
export function nativeHostRegistryKeyV1(options) {
	const platform = platformOf(options?.platform);
	if (platform !== "win32") return undefined;
	const root = WINDOWS_REGISTRY_ROOTS_V1[options.browser];
	if (root === undefined) throw new Error(`browser native host 注册不支持该浏览器：${options.browser}`);
	return `HKCU\\Software\\${root}\\NativeMessagingHosts\\${NATIVE_HOST_NAME_V1}`;
}

/** Manifest file Chrome reads, or undefined when this platform registers in the registry. */
export function nativeHostManifestPathV1(options) {
	const platform = platformOf(options?.platform);
	const browser = options?.browser;
	const home = options?.home ?? homedir();
	if (platform === "win32") { nativeHostRegistryKeyV1({ platform, browser }); return undefined; }
	const vendor = platform === "darwin" ? MACOS_VENDOR_DIRS_V1[browser] : LINUX_VENDOR_DIRS_V1[browser];
	if (vendor === undefined) throw new Error(`browser native host 注册不支持该浏览器：${browser}`);
	const base = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
	return join(base, ...vendor.split("/"), "NativeMessagingHosts", `${NATIVE_HOST_NAME_V1}.json`);
}

/**
 * Browsers whose registration directory already exists. Windows registers in the
 * registry, so it reports nothing here instead of guessing an installation.
 */
export function detectInstalledBrowsersV1(options) {
	const platform = platformOf(options?.platform);
	return browserIdsV1(platform).filter((browser) => {
		const manifestPath = nativeHostManifestPathV1({ platform, browser, home: options?.home });
		return manifestPath !== undefined && options.exists(dirname(manifestPath));
	});
}
