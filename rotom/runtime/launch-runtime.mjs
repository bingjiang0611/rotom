#!/usr/bin/env node

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RESOURCE_DESCRIPTORS_V1 } from "./product-config.mjs";
import { resolveInstalledPi } from "./resolve-installed-pi.mjs";
import { verifyPiRuntime, verifyPiRuntimeIdentity } from "./verify-pi-runtime.mjs";

class UsageError extends Error {
	exitCode = 2;
}

function parseLauncherArgs(args) {
	let packageManagement = false;
	let versionMode = 0;
	let herdrExtension;
	let index = 0;
	for (; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--") break;
		if (argument === "--package-management") packageManagement = true;
		else if (argument === "--version-only") versionMode = 1;
		else if (argument === "--version-verbose") versionMode = 2;
		else if (argument === "--herdr-extension" && index + 1 < args.length) herdrExtension = args[++index];
		else throw new UsageError("内部 runtime launcher 参数无效");
	}
	if (index >= args.length || args[index] !== "--") throw new UsageError("内部 runtime launcher 缺少参数边界");
	return { packageManagement, versionMode, herdrExtension, userArgs: args.slice(index + 1) };
}

async function readProductVersion(agentDir) {
	const path = resolve(agentDir, "package.json");
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isFile() || info.isSymbolicLink()) throw new Error("Untrusted rotom package manifest");
	let manifest;
	try { manifest = JSON.parse(await readFile(path, "utf8")); }
	catch { throw new Error("Invalid rotom package manifest"); }
	if (manifest.name !== "@bingjiang0611/rotom" || typeof manifest.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
		throw new Error("Invalid rotom product version");
	}
	return manifest.version;
}

function productUserAgentDir() {
	let directory = process.env.PI_CODING_AGENT_DIR ?? (process.env.HOME ? join(process.env.HOME, ".pi/agent") : "");
	if (directory === "~") directory = homedir();
	else if (directory.startsWith("~/")) directory = join(homedir(), directory.slice(2));
	return directory;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function applySubagentBudget(userAgentDir) {
	if (process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION !== undefined) {
		if (!/^\d+$/u.test(process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION)) throw new UsageError("PI_SUBAGENT_MAX_SPAWNS_PER_SESSION 必须是非负整数");
		return;
	}
	const configPath = userAgentDir ? join(userAgentDir, "extensions/subagent/config.json") : "";
	if (configPath) {
		const info = await stat(configPath).catch(() => undefined);
		if (info?.isFile()) {
			let config;
			try { config = await readJson(configPath); }
			catch { throw new UsageError("Subagent user config 的 maxSubagentSpawnsPerSession 必须是非负整数"); }
			if (config && typeof config === "object" && Object.hasOwn(config, "maxSubagentSpawnsPerSession")) {
				const limit = config.maxSubagentSpawnsPerSession;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) throw new UsageError("Subagent user config 的 maxSubagentSpawnsPerSession 必须是非负整数");
				return;
			}
		}
	}
	process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "128";
}

async function applyComputerUseDefault(userAgentDir) {
	if (process.env.PI_COMPUTER_USE_HEADLESS !== undefined) return;
	for (const configPath of [userAgentDir ? join(userAgentDir, "extensions/pi-computer-use.json") : "", join(process.cwd(), ".pi/computer-use.json")]) {
		if (!configPath) continue;
		const info = await stat(configPath).catch(() => undefined);
		if (!info?.isFile()) continue;
		try {
			const value = await readJson(configPath);
			if (!value || typeof value !== "object") continue;
			const scope = value.computer_use && typeof value.computer_use === "object" ? value.computer_use : value;
			if (Object.hasOwn(scope, "headless")) return;
		} catch {
			// The package also ignores unreadable or malformed Computer Use config.
		}
	}
	process.env.PI_COMPUTER_USE_HEADLESS = "1";
}

async function initializeSubagentStore(agentDir) {
	if (process.env.PI_SUBAGENTS_EXECUTION_SCOPE === undefined) process.env.PI_SUBAGENTS_EXECUTION_SCOPE = "owned-process-groups-v2";
	if (process.env.PI_SUBAGENTS_EXECUTION_SCOPE === "") return;
	if (process.env.PI_SUBAGENTS_EXECUTION_SCOPE !== "owned-process-groups-v2") throw new UsageError("不支持的 PI_SUBAGENTS_EXECUTION_SCOPE；仅接受 owned-process-groups-v2 或显式空值");
	if (process.env.PI_SUBAGENTS_TEMP_ROOT === undefined) {
		if (!process.env.HOME) throw new UsageError("默认 scoped 执行需要 HOME；请显式设置 PI_SUBAGENTS_TEMP_ROOT 或 PI_SUBAGENTS_EXECUTION_SCOPE=");
		process.env.PI_SUBAGENTS_TEMP_ROOT = join(process.env.HOME, ".local/state/rotom/subagent-store");
	}
	if (!isAbsolute(process.env.PI_SUBAGENTS_TEMP_ROOT)) throw new UsageError("PI_SUBAGENTS_TEMP_ROOT 必须是绝对目录路径");

	const packageRoot = resolve(agentDir, "extensions/third-party/node_modules/pi-subagents");
	const source = resolve(packageRoot, "src/shared/execution-store.ts");
	const jitiEntry = resolve(agentDir, "extensions/third-party/node_modules/jiti/lib/jiti.mjs");
	for (const path of [source, jitiEntry]) {
		const info = await lstat(path).catch(() => undefined);
		if (!info?.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`缺少可信 scoped execution store 工具：${path}`);
	}
	try {
		const { createJiti } = await import(pathToFileURL(jitiEntry).href);
		const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
		const { initializeExecutionStore } = await jiti.import(source);
		initializeExecutionStore(process.env.PI_SUBAGENTS_TEMP_ROOT);
	} catch {
		throw new Error(`scoped execution store 不可用；未启动会话，也不授权恢复或重放既有工作：${process.env.PI_SUBAGENTS_TEMP_ROOT}`);
	}
}

function productRuntimeArgs(agentDir) {
	const args = [];
	for (const resource of RESOURCE_DESCRIPTORS_V1) {
		const path = resolve(agentDir, resource.loadPath ?? resource.path);
		if (resource.kind === "extension") args.push("--extension", path);
		else if (resource.kind === "skill") args.push("--skill", path);
	}
	return args;
}

async function runPi(verified, args) {
	process.argv = [process.execPath, verified.executable, ...args];
	process.title = "pi";
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = () => {};
	const runtime = await import(pathToFileURL(verified.runtimeEntry).href);
	await runtime.main(args);
}

export async function launchRuntime(rawArgs = process.argv.slice(2)) {
	const options = parseLauncherArgs(rawArgs);
	const agentDir = resolve(import.meta.dirname, "..");
	const resourceDeclarations = RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
	if (options.herdrExtension) resourceDeclarations.push(`herdr-extension:${options.herdrExtension}`);
	const bundledPi = process.env.ROTOM_PI === undefined;
	const executable = bundledPi ? await resolveInstalledPi(agentDir) : process.env.ROTOM_PI;
	if (!isAbsolute(executable)) throw new UsageError("ROTOM_PI 必须是绝对 Pi 可执行文件路径");
	const verified = await (options.versionMode
		? verifyPiRuntimeIdentity({ executable, agentDir, resourceDeclarations })
		: verifyPiRuntime({
			executable,
			agentDir,
			resourceDeclarations,
			// The product-owned fork builds a bundled SDK beside its CLI. Loading that
			// reviewed entry satisfies the same capability gate while sharing the CLI's
			// module graph, instead of evaluating the unbundled SDK a second time.
			...(bundledPi ? { runtimeEntry: resolve(dirname(executable), "index.js") } : {}),
		}));
	process.env.ROTOM_PRODUCT_VERSION = await readProductVersion(agentDir);
	process.env.ROTOM_VERIFIED_PI_EXECUTABLE = verified.executable;
	if (options.packageManagement) {
		await runPi(verified, options.userArgs);
		return;
	}

	const userAgentDir = productUserAgentDir();
	await applySubagentBudget(userAgentDir);
	await applyComputerUseDefault(userAgentDir);
	if (options.versionMode) {
		if (options.versionMode === 1) process.stdout.write(`${process.env.ROTOM_PRODUCT_VERSION}\n`);
		else process.stdout.write(`rotom ${process.env.ROTOM_PRODUCT_VERSION}\nPi fork ${verified.version}\nUpdate source https://registry.npmjs.org/@bingjiang0611/rotom\n`);
		return;
	}
	await initializeSubagentStore(agentDir);
	const herdrArgs = options.herdrExtension ? ["--extension", options.herdrExtension] : [];
	await runPi(verified, [...productRuntimeArgs(agentDir), ...herdrArgs, ...options.userArgs]);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath === await realpath(import.meta.filename)) {
	launchRuntime().catch((error) => {
		process.stderr.write(`rotom: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = error?.exitCode === 2 ? 2 : 1;
	});
}
