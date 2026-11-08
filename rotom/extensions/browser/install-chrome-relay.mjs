#!/usr/bin/env node

import { constants, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstalledBrowsersV1, nativeHostManifestPathV1, nativeHostRegistryKeyV1, browserRelayDirectoryV1, browserIdsV1 } from "./platform-paths.mjs";

const HOST_NAME = "dev.rotom.browser_relay";
const EXTENSION_ID = "kgadcllokaodnoknakblocmhidemimdi";
const root = dirname(fileURLToPath(import.meta.url));
const configuredHome = process.env.HOME;
if (!configuredHome || !isAbsolute(configuredHome)) throw new Error("HOME 必须是存在的绝对目录");
const home = await realpath(configuredHome);
const platform = process.platform;
if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error("Chrome relay installer 不支持的平台");
// `--browser` chooses which Chromium-family browser gets the native host; without it the
// first browser whose registration directory exists wins, and Chrome is the fallback.
const browserFlag = (() => {
	const index = process.argv.indexOf("--browser");
	return index === -1 ? undefined : process.argv[index + 1];
})();
if (browserFlag !== undefined && !browserIdsV1(platform).includes(browserFlag)) throw new Error(`不支持的浏览器：${browserFlag}（可用：${browserIdsV1(platform).join("|")}）`);
const browser = browserFlag
	?? detectInstalledBrowsersV1({ platform, home, exists: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } } })[0]
	?? "chrome";
const supportDir = browserRelayDirectoryV1({ platform, home });
// A single stable directory is what Chrome loads and what the launcher execs. Its
// path never changes across product releases, so a content upgrade is one Chrome
// reload (↻) with no re-selecting an unpacked directory or re-registering the host.
const currentDir = join(supportDir, "current");
const extensionDir = join(currentDir, "chrome-extension");
const nativeHostPath = join(currentDir, "native-host.mjs");
// Exactly what `materialize` writes, in sorted order: the extension directory plus the two
// host modules. Anything else means the stable directory is not ours to trust.
const INSTALLED_COMPONENT_ENTRIES = Object.freeze(["chrome-extension", "native-host.mjs", "platform-paths.mjs"]);
const launcherPath = join(supportDir, platform === "win32" ? "native-host-launcher.cmd" : "native-host-launcher.sh");
const installLock = join(supportDir, ".install.lock");
// Windows Chrome reads the host path from the registry, so the manifest lives next to the
// relay and the registry value points at it. macOS and Linux read a fixed directory.
const chromeManifestPath = platform === "win32"
	? join(supportDir, `${HOST_NAME}.json`)
	: nativeHostManifestPathV1({ platform, browser, home });
const chromeManifestDir = dirname(chromeManifestPath);
const registryKey = nativeHostRegistryKeyV1({ platform, browser });

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

async function ensureDirectory(path, mode, requirePrivate = false, recursive = false) {
	if (recursive && path !== home) {
		if (!path.startsWith(`${home}/`)) throw new Error("目录超出 HOME");
		await ensureDirectory(dirname(path), mode, false, true);
	}
	if (await realpath(dirname(path)) !== dirname(path)) throw new Error("父目录身份无效");
	try { await mkdir(path, { mode }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("目录身份无效");
	if (requirePrivate && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) throw new Error("目录不是本人 private 目录");
	return path;
}

async function atomicPrivateWrite(path, content, mode) {
	const parent = await realpath(dirname(path));
	try {
		const existing = await lstat(path);
		if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid()) throw new Error("拒绝替换非本人唯一普通文件");
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
	const temp = join(parent, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
	try { await handle.writeFile(content); await handle.sync(); }
	finally { await handle.close(); }
	await rename(temp, path);
	const dirHandle = await open(parent, constants.O_RDONLY);
	try { await dirHandle.sync(); } finally { await dirHandle.close(); }
	await chmod(path, mode);
}

// Only the actual Chrome/native-host bytes identify a component. Product version,
// checkout path, installer UI and Node installation path must not churn its identity.
class ComponentIdentityError extends Error {}

async function componentFiles(base, privateFiles = false) {
	const files = new Map(); let bytes = 0; let entries = 0;
	async function visit(relative, depth = 0) {
		if (++entries > 128 || depth > 8) throw new ComponentIdentityError("browser component inventory 超限");
		const path = join(base, relative);
		const info = await lstat(path);
		if (info.isSymbolicLink() || await realpath(path) !== path) throw new ComponentIdentityError("browser component 路径身份无效");
		if (privateFiles && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) throw new ComponentIdentityError("browser component 非本人 private 资源");
		if (info.isDirectory()) {
			for (const name of (await readdir(path)).sort()) await visit(join(relative, name), depth + 1);
			return;
		}
		if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024 || bytes + info.size > 8 * 1024 * 1024 || files.size >= 64) throw new ComponentIdentityError("browser component 文件身份或大小无效");
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const before = await handle.stat();
			if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size || before.ctimeMs !== info.ctimeMs) throw new ComponentIdentityError("browser component 读取前漂移");
			const buffer = Buffer.alloc(before.size + 1); let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const data = buffer.subarray(0, offset);
			const after = await handle.stat();
			const current = await lstat(path);
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || current.ino !== after.ino || current.dev !== after.dev || data.length !== before.size || await realpath(path) !== path) throw new ComponentIdentityError("browser component 读取中漂移");
			bytes += data.length;
			if (bytes > 8 * 1024 * 1024) throw new ComponentIdentityError("browser component 总量超限");
			files.set(relative, data);
		} finally { await handle.close(); }
	}
	await visit("native-host.mjs");
	await visit("platform-paths.mjs"); // native-host.mjs imports it relatively
	await visit("chrome-extension");
	if (!files.has("chrome-extension/manifest.json") || !files.has("chrome-extension/service-worker.js")) throw new ComponentIdentityError("browser component 入口缺失");
	return files;
}

function digestFiles(files) {
	const hash = createHash("sha256").update("rotom-browser-component/v1\0");
	for (const [name, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		hash.update(JSON.stringify([name, data.length])).update("\0").update(data);
	}
	return hash.digest("hex");
}

// Only chrome-extension/ bytes are loaded into Chrome, so only they need a reload (↻).
// native-host.mjs is relaunched by Chrome per connection and upgrades automatically, so
// splitting the identity lets install ask for a reload strictly when the in-Chrome part
// changed instead of on every host-side update.
function componentDigests(files) {
	const ext = new Map(), host = new Map();
	for (const [name, data] of files) (name.startsWith("chrome-extension/") ? ext : host).set(name, data);
	return { componentDigest: digestFiles(files), extensionDigest: digestFiles(ext), hostDigest: digestFiles(host) };
}

// The content currently materialized in the stable directory Chrome loads from.
async function installedState() {
	let directoryExists = false;
	try {
		for (const path of [supportDir, currentDir]) {
			const info = await lstat(path);
			if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) return { state: "invalid" };
		}
		directoryExists = true;
		const names = (await readdir(currentDir)).sort();
		if (JSON.stringify(names) !== JSON.stringify(INSTALLED_COMPONENT_ENTRIES)) return { state: "invalid" };
		return { state: "ready", ...componentDigests(await componentFiles(currentDir, true)) };
	} catch (error) {
		if (error instanceof ComponentIdentityError) return { state: "invalid" };
		return error?.code === "ENOENT" ? { state: directoryExists ? "invalid" : "missing" } : { state: "unavailable" };
	}
}

async function describeComponent() {
	if (await realpath(root) !== root || await realpath(process.execPath) !== process.execPath) throw new Error("installer 必须使用 canonical 资源与 Node");
	const files = await componentFiles(root);
	return { files, ...componentDigests(files) };
}

async function removeCurrentAside(previous) {
	const info = await lstat(previous).catch((error) => { if (error?.code === "ENOENT") return undefined; throw error; });
	if (!info) return;
	if (info.isSymbolicLink() || !info.isDirectory()) await unlink(previous);
	else await rm(previous, { recursive: true });
}

// Atomically replace the stable directory's contents to match the packaged component.
// The running native host already holds its code in memory; Chrome does not auto-reload
// an unpacked extension, so a user reload (↻) picks up the swapped files. Returns whether
// the content actually changed so the UI can ask for exactly one reload when needed.
async function materialize(component) {
	const before = await installedState();
	if (before.state === "unavailable") throw new Error("browser component 状态不可确定；未改动");
	if (before.state === "ready" && before.componentDigest === component.componentDigest) return { change: "unchanged", extensionChanged: false };
	await mkdir(installLock, { mode: 0o700 }); // exclusive; no stale-lock stealing or retry
	const lockIdentity = await lstat(installLock);
	let staging; let stagingIdentity; let previous;
	try {
		staging = await mkdtemp(join(supportDir, ".stage-"));
		stagingIdentity = await lstat(staging);
		for (const [name, data] of component.files) {
			await mkdir(dirname(join(staging, name)), { recursive: true, mode: 0o700 });
			await atomicPrivateWrite(join(staging, name), data, 0o600);
		}
		if (digestFiles(await componentFiles(staging, true)) !== component.componentDigest) throw new Error("browser component 暂存校验失败");
		const existing = await lstat(currentDir).catch((error) => { if (error?.code === "ENOENT") return undefined; throw error; });
		if (existing) {
			previous = join(supportDir, `.previous-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
			await rename(currentDir, previous); // brief window: only Chrome ↻ or a new native connection reads currentDir
		}
		await rename(staging, currentDir);
		staging = undefined;
		const directory = await open(supportDir, constants.O_RDONLY);
		try { await directory.sync(); } finally { await directory.close(); }
	} finally {
		if (staging) {
			const current = await lstat(staging).catch(() => undefined);
			if (stagingIdentity && current?.ino === stagingIdentity.ino && current?.dev === stagingIdentity.dev && current.isDirectory() && !current.isSymbolicLink()) await rm(staging, { recursive: true });
		}
		if (previous) await removeCurrentAside(previous).catch(() => {});
		const current = await lstat(installLock).catch(() => undefined);
		if (current?.ino === lockIdentity.ino && current?.dev === lockIdentity.dev && current.isDirectory() && !current.isSymbolicLink()) await rmdir(installLock);
	}
	const extensionChanged = before.state !== "ready" || before.extensionDigest !== component.extensionDigest;
	return { change: before.state === "missing" ? "created" : "updated", extensionChanged };
}

function expectedInstallContent() {
	// Launcher references the stable native-host path, so its bytes depend only on the
	// Node executable — component content changes never re-register the host.
	const launcher = platform === "win32"
		? `@echo off\r\n"${process.execPath}" "${nativeHostPath}"\r\n`
		: `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeHostPath)}\n`;
	const manifest = `${JSON.stringify({ name: HOST_NAME, description: "Rotom Browser Relay Native Messaging Host", path: launcherPath, type: "stdio", allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }, null, 2)}\n`;
	return { launcher, manifest };
}

function details(component, installed) {
	return {
		extensionId: EXTENSION_ID,
		componentDigest: component.componentDigest,
		extensionDigest: component.extensionDigest,
		hostDigest: component.hostDigest,
		installedDigest: installed?.state === "ready" ? installed.componentDigest : null,
		extensionDir, nativeHostManifest: chromeManifestPath, launcherPath,
	};
}

async function install() {
	if (platform === "win32") {
		// L1: the manifest and launcher are written, but the registry value is left to the
		// user because this path cannot be exercised in the current environment.
		const component = await describeComponent();
		await ensureDirectory(dirname(supportDir), 0o700, true, true);
		await ensureDirectory(supportDir, 0o700, true);
		const change = await materialize(component);
		const { launcher, manifest } = expectedInstallContent();
		await atomicPrivateWrite(launcherPath, launcher, 0o600);
		await atomicPrivateWrite(chromeManifestPath, manifest, 0o600);
		console.log(JSON.stringify({
			status: "manual-registration-required",
			firstInstall: change.change === "created",
			reloadNeeded: change.change === "updated" && change.extensionChanged,
			hostOnlyUpdate: change.change === "updated" && !change.extensionChanged,
			registryKey,
			registryCommand: `reg add "${registryKey}" /ve /t REG_SZ /d "${chromeManifestPath}" /f`,
			unverified: "windows-native-host",
			...details(component, await installedState()),
		}, null, 2));
		return;
	}
	if (platform !== "darwin" && platform !== "linux") throw new Error("Chrome relay installer 不支持的平台");
	const component = await describeComponent();
	// The relay directory's parent belongs to the platform: Application Support on macOS,
	// XDG runtime / ~/.local/state on Linux.
	const stateRoot = platform === "darwin" ? join(home, "Library", "Application Support", "rotom") : dirname(supportDir);
	await ensureDirectory(stateRoot, 0o700, true, true);
	await ensureDirectory(supportDir, 0o700, true);
	await ensureDirectory(chromeManifestDir, 0o700, false, true);
	const change = await materialize(component);
	const { launcher, manifest } = expectedInstallContent();
	await atomicPrivateWrite(launcherPath, launcher, 0o700);
	await atomicPrivateWrite(chromeManifestPath, manifest, 0o600);
	const installed = await installedState();
	console.log(JSON.stringify({
		status: "installed",
		firstInstall: change.change === "created",
		reloadNeeded: change.change === "updated" && change.extensionChanged,
		hostOnlyUpdate: change.change === "updated" && !change.extensionChanged,
		...details(component, installed),
	}, null, 2));
}

async function matchesExpectedFile(path, identity, expected) {
	const bytes = Buffer.from(expected);
	if (identity.size !== bytes.length) return false;
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat();
		if (before.ino !== identity.ino || before.dev !== identity.dev || before.size !== bytes.length || before.ctimeMs !== identity.ctimeMs) return false;
		const buffer = Buffer.alloc(bytes.length + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const after = await handle.stat();
		const current = await lstat(path);
		return bytesRead === bytes.length && buffer.subarray(0, bytesRead).equals(bytes)
			&& after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.size === before.size && after.nlink === 1
			&& current.ino === after.ino && current.dev === after.dev && !current.isSymbolicLink();
	} finally { await handle.close(); }
}

async function status() {
	const component = await describeComponent();
	const installed = await installedState();
	const upToDate = installed.state === "ready" && installed.componentDigest === component.componentDigest;
	const extensionUpToDate = installed.state === "ready" && installed.extensionDigest === component.extensionDigest;
	const result = { ...details(component, installed), browser, ...(registryKey === undefined ? {} : { registryKey }), componentState: installed.state, upToDate, extensionUpToDate, registrationValid: false, installed: false };
	if (platform === "win32") {
		// Registration lives in HKCU; reading it needs a Windows host, so it stays unproven.
		result.unverified = "windows-native-host";
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	try {
		const [manifestInfo, launcherInfo] = await Promise.all([lstat(chromeManifestPath), lstat(launcherPath)]);
		const expected = expectedInstallContent();
		result.registrationValid = manifestInfo.uid === process.getuid() && launcherInfo.uid === process.getuid() && manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.nlink === 1 && launcherInfo.isFile() && !launcherInfo.isSymbolicLink() && launcherInfo.nlink === 1 && (manifestInfo.mode & 0o077) === 0 && (launcherInfo.mode & 0o077) === 0 && await matchesExpectedFile(chromeManifestPath, manifestInfo, expected.manifest) && await matchesExpectedFile(launcherPath, launcherInfo, expected.launcher);
	} catch { /* unconfirmed registration; not a Chrome connection conclusion */ }
	// installed means a working, current relay: registration valid and the loaded
	// directory already matches this rotom (so no reload is pending).
	result.installed = result.registrationValid && upToDate;
	console.log(JSON.stringify(result, null, 2));
}

async function removeExact(path) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("拒绝删除非普通文件");
		await unlink(path);
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function uninstall() {
	await removeExact(chromeManifestPath);
	await removeExact(launcherPath);
	// Retain the stable directory: Chrome may still have it loaded and a running native
	// host may still reference it. Removing it is a user action in chrome://extensions.
	console.log(JSON.stringify({ status: "uninstalled", componentRetained: true, extensionId: EXTENSION_ID, ...(registryKey === undefined ? {} : { registryCommand: `reg delete "${registryKey}" /f` }) }));
}

const operation = process.argv[2] ?? "status";
if (operation === "install") await install();
else if (operation === "status") await status();
else if (operation === "uninstall") await uninstall();
else throw new Error("usage: install-chrome-relay.mjs install|status|uninstall");
