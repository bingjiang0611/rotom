#!/usr/bin/env node

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "dev.rotom.browser_relay";
const EXTENSION_ID = "kgadcllokaodnoknakblocmhidemimdi";
const root = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(root, "chrome-extension");
const nativeHostSource = join(root, "native-host.mjs");
const supportDir = join(homedir(), "Library", "Application Support", "rotom", "browser-relay");
const launcherPath = join(supportDir, "native-host-launcher.sh");
const chromeManifestDir = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
const chromeManifestPath = join(chromeManifestDir, `${HOST_NAME}.json`);

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

async function ensureDirectory(path, mode, requirePrivate = false, recursive = false) {
	try { await mkdir(path, { mode, recursive }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`目录身份无效：${path}`);
	if (requirePrivate && (info.mode & 0o077) !== 0) throw new Error(`目录不是 private：${path}`);
	return realpath(path);
}

async function atomicPrivateWrite(path, content, mode) {
	const parent = await realpath(dirname(path));
	try {
		const existing = await lstat(path);
		if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error(`拒绝替换非唯一普通文件：${path}`);
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
	const temp = join(parent, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
	try { await handle.writeFile(content, "utf8"); await handle.sync(); }
	finally { await handle.close(); }
	await rename(temp, path);
	const dirHandle = await open(parent, constants.O_RDONLY);
	try { await dirHandle.sync(); } finally { await dirHandle.close(); }
	await chmod(path, mode);
}

async function validateSource() {
	for (const path of [extensionDir, nativeHostSource]) {
		const info = await lstat(path);
		if (info.isSymbolicLink() || (path === extensionDir ? !info.isDirectory() : !info.isFile())) throw new Error(`browser relay source 无效：${path}`);
	}
	if (!process.execPath.startsWith("/") || (await realpath(process.execPath)) !== process.execPath) throw new Error("installer 必须由 canonical absolute Node executable 运行");
}

async function expectedInstallContent() {
	const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(await realpath(nativeHostSource))}\n`;
	const manifest = `${JSON.stringify({
		name: HOST_NAME,
		description: "Rotom Browser Relay Native Messaging Host",
		path: launcherPath,
		type: "stdio",
		allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
	}, null, 2)}\n`;
	return { launcher, manifest };
}

async function install() {
	if (process.platform !== "darwin") throw new Error("M7 Chrome relay installer 首版仅支持 macOS");
	await validateSource();
	await ensureDirectory(join(homedir(), "Library", "Application Support", "rotom"), 0o700, true);
	await ensureDirectory(supportDir, 0o700, true);
	await ensureDirectory(chromeManifestDir, 0o700, false, true);
	const { launcher, manifest } = await expectedInstallContent();
	await atomicPrivateWrite(launcherPath, launcher, 0o700);
	await atomicPrivateWrite(chromeManifestPath, manifest, 0o600);
	console.log(JSON.stringify({ status: "installed", extensionId: EXTENSION_ID, extensionDir, nativeHostManifest: chromeManifestPath }, null, 2));
}

async function status() {
	const result = { extensionId: EXTENSION_ID, extensionDir, nativeHostManifest: chromeManifestPath, launcherPath, installed: false };
	try {
		const [manifestInfo, launcherInfo] = await Promise.all([lstat(chromeManifestPath), lstat(launcherPath)]);
		const expected = await expectedInstallContent();
		result.installed = manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.nlink === 1 && launcherInfo.isFile() && !launcherInfo.isSymbolicLink() && launcherInfo.nlink === 1 && (manifestInfo.mode & 0o077) === 0 && (launcherInfo.mode & 0o077) === 0 && await readFile(chromeManifestPath, "utf8") === expected.manifest && await readFile(launcherPath, "utf8") === expected.launcher;
	} catch { /* absent */ }
	console.log(JSON.stringify(result, null, 2));
}

async function removeExact(path) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error(`拒绝删除非普通文件：${path}`);
		await unlink(path);
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function uninstall() {
	await removeExact(chromeManifestPath);
	await removeExact(launcherPath);
	console.log(JSON.stringify({ status: "uninstalled", extensionId: EXTENSION_ID }));
}

const operation = process.argv[2] ?? "status";
if (operation === "install") await install();
else if (operation === "status") await status();
else if (operation === "uninstall") await uninstall();
else throw new Error("usage: install-chrome-relay.mjs install|status|uninstall");
