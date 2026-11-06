import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
	BROWSER_IDS_V1,
	NATIVE_HOST_NAME_V1,
	browserIdsV1,
	browserRelayDirectoryV1,
	browserRelayLockPathV1,
	browserRelaySocketPathV1,
	browserRelayUserHashV1,
	detectInstalledBrowsersV1,
	nativeHostManifestPathV1,
	nativeHostRegistryKeyV1,
} from "./platform-paths.mjs";

const HOME = "/Users/user";

test("macOS 路径与升级前的实现逐字一致", () => {
	const expected = "/Users/user/Library/Application Support/rotom/browser-relay/relay.sock";
	assert.equal(browserRelaySocketPathV1({ platform: "darwin", home: HOME }), expected);
	assert.equal(browserRelayDirectoryV1({ platform: "darwin", home: HOME }), "/Users/user/Library/Application Support/rotom/browser-relay");
	assert.equal(browserRelayLockPathV1({ platform: "darwin", home: HOME }), "/Users/user/Library/Application Support/rotom/browser-relay/relay.lock");
	assert.equal(nativeHostManifestPathV1({ platform: "darwin", browser: "chrome", home: HOME }), "/Users/user/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.rotom.browser_relay.json");
});

test("Linux 用 XDG_RUNTIME_DIR，缺失时退回 ~/.local/state", () => {
	assert.equal(browserRelaySocketPathV1({ platform: "linux", home: "/h", env: { XDG_RUNTIME_DIR: "/run/user/501" } }), "/run/user/501/rotom/browser-relay/relay.sock");
	assert.equal(browserRelaySocketPathV1({ platform: "linux", home: "/h", env: {} }), "/h/.local/state/rotom/browser-relay/relay.sock");
	// A relative XDG_RUNTIME_DIR is not a real runtime directory: fall back instead of
	// creating the socket somewhere that depends on the working directory.
	assert.equal(browserRelaySocketPathV1({ platform: "linux", home: "/h", env: { XDG_RUNTIME_DIR: "run/user/501" } }), "/h/.local/state/rotom/browser-relay/relay.sock");
	assert.equal(browserRelayLockPathV1({ platform: "linux", home: "/h", env: { XDG_RUNTIME_DIR: "/run/user/501" } }), "/run/user/501/rotom/browser-relay/relay.lock");
});

test("Windows 用命名管道，名称带不可逆的用户摘要且不含用户名", () => {
	const pipe = browserRelaySocketPathV1({ platform: "win32", home: "C:\\Users\\bob", user: "bob" });
	assert.match(pipe, /^\\\\\.\\pipe\\rotom-browser-relay-[0-9a-f]{12}$/u);
	assert.equal(pipe.includes("bob"), false, "管道名不得包含用户名");
	assert.equal(pipe, browserRelaySocketPathV1({ platform: "win32", home: "C:\\Users\\bob", user: "bob" }), "同一用户必须得到同一管道名");
	assert.notEqual(pipe, browserRelaySocketPathV1({ platform: "win32", home: "C:\\Users\\bob", user: "alice" }));
	assert.equal(browserRelayDirectoryV1({ platform: "win32", home: "C:\\Users\\bob" }), join("C:\\Users\\bob", "AppData", "Local", "rotom", "browser-relay"));
	assert.equal(browserRelayLockPathV1({ platform: "win32", home: "C:\\Users\\bob" }), join("C:\\Users\\bob", "AppData", "Local", "rotom", "browser-relay", "relay.lock"));
	assert.equal(browserRelayUserHashV1("bob"), browserRelayUserHashV1("bob"));
});

test("native host manifest 按平台与浏览器落到各自目录", () => {
	for (const [browser, vendor] of [["chrome", "google-chrome"], ["chromium", "chromium"], ["edge", "microsoft-edge"], ["brave", "BraveSoftware/Brave-Browser"], ["vivaldi", "vivaldi"]]) {
		assert.equal(
			nativeHostManifestPathV1({ platform: "linux", browser, home: "/h" }),
			`/h/.config/${vendor}/NativeMessagingHosts/${NATIVE_HOST_NAME_V1}.json`,
			browser,
		);
	}
	assert.equal(nativeHostManifestPathV1({ platform: "darwin", browser: "brave", home: HOME }), `/Users/user/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/${NATIVE_HOST_NAME_V1}.json`);
	// Windows registers in the registry, so there is no manifest path to report.
	assert.equal(nativeHostManifestPathV1({ platform: "win32", browser: "chrome", home: "C:\\Users\\bob" }), undefined);
});

test("Windows 注册表 key 与浏览器一一对应", () => {
	assert.equal(nativeHostRegistryKeyV1({ platform: "win32", browser: "chrome" }), `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME_V1}`);
	assert.equal(nativeHostRegistryKeyV1({ platform: "win32", browser: "brave" }), `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME_V1}`);
	assert.equal(nativeHostRegistryKeyV1({ platform: "darwin", browser: "chrome" }), undefined, "macOS 用 manifest 文件，不用注册表");
});

test("不支持的平台与浏览器被拒绝，而不是猜一个路径", () => {
	assert.throws(() => browserRelaySocketPathV1({ platform: "freebsd", home: HOME }), /平台/u);
	assert.throws(() => nativeHostManifestPathV1({ platform: "linux", browser: "arc", home: "/h" }), /arc/u, "Linux 没有可验证的 Arc 注册目录");
	assert.throws(() => nativeHostManifestPathV1({ platform: "win32", browser: "arc", home: "C:\\Users\\bob" }), /arc/u);
	assert.deepEqual(browserIdsV1("linux").includes("arc"), false);
	assert.deepEqual(browserIdsV1("darwin"), [...BROWSER_IDS_V1]);
	assert.deepEqual(browserIdsV1("freebsd"), [], "未知平台没有可声明的安装路径");
});

test("自动探测只报告注册目录已存在的浏览器", () => {
	const present = new Set(["/h/.config/google-chrome/NativeMessagingHosts", "/h/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"]);
	assert.deepEqual(detectInstalledBrowsersV1({ platform: "linux", home: "/h", exists: (path) => present.has(path) }), ["chrome", "brave"]);
	assert.deepEqual(detectInstalledBrowsersV1({ platform: "linux", home: "/h", exists: () => false }), []);
	assert.deepEqual(detectInstalledBrowsersV1({ platform: "win32", home: "C:\\Users\\bob", exists: () => true }), [], "Windows 不靠目录探测");
});
