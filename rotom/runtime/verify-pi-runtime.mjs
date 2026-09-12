#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	MINIMUM_NODE_VERSION,
	RESOURCE_DESCRIPTORS_V1,
	VERIFIED_HERDR_PI_INTEGRATION_VERSION,
	VERIFIED_PI_PACKAGE,
	VERIFIED_THIRD_PARTY_PACKAGES,
} from "./product-config.mjs";

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function semverCore(value, description) {
	const match = EXACT_SEMVER.exec(value);
	if (!match) throw new Error(`${description} 不是可解析的精确 semver：${String(value)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function assertMinimumNodeVersion(nodeVersion) {
	const actual = semverCore(nodeVersion, "Node runtime 版本");
	const minimum = semverCore(MINIMUM_NODE_VERSION, "最低 Node runtime 版本");
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] > minimum[index]) return;
		if (actual[index] < minimum[index]) throw new Error(`Node runtime ${nodeVersion} 不受支持；要求 >=${MINIMUM_NODE_VERSION}`);
	}
}

async function readStrictJsonFile(filePath, description) {
	const info = await lstat(filePath).catch(() => undefined);
	if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${description} 缺失、不是普通文件或为 symlink：${filePath}`);
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		throw new Error(`${description} 无法解析：${filePath}`);
	}
}

export async function verifyThirdPartyPackageContract(agentDir) {
	const root = resolve(agentDir, "extensions/third-party");
	const packageJson = await readStrictJsonFile(resolve(root, "package.json"), "third-party package.json");
	const lock = await readStrictJsonFile(resolve(root, "package-lock.json"), "third-party package-lock.json");
	if (lock.lockfileVersion !== 3) throw new Error("third-party lockfileVersion 必须为3");
	const expectedNames = Object.keys(VERIFIED_THIRD_PARTY_PACKAGES).sort();
	const declaredNames = Object.keys(packageJson.dependencies ?? {}).sort();
	const lockedNames = Object.keys(lock.packages?.[""]?.dependencies ?? {}).sort();
	if (JSON.stringify(declaredNames) !== JSON.stringify(expectedNames) || JSON.stringify(lockedNames) !== JSON.stringify(expectedNames)) {
		throw new Error(`third-party direct package 列表必须精确匹配产品合同：${expectedNames.join(", ")}`);
	}
	for (const [name, expected] of Object.entries(VERIFIED_THIRD_PARTY_PACKAGES)) {
		if (packageJson.dependencies?.[name] !== expected.version || lock.packages?.[""]?.dependencies?.[name] !== expected.version) throw new Error(`third-party package 必须精确依赖 ${name}@${expected.version}`);
		const locked = lock.packages?.[`node_modules/${name}`];
		if (locked?.version !== expected.version || locked.integrity !== expected.integrity) throw new Error(`third-party lockfile ${name} identity/integrity 不匹配`);
		if (expected.archive) {
			if (locked.resolved !== `file:${expected.archive}`) throw new Error(`third-party ${name} archive source 不匹配`);
			const archive = resolve(root, expected.archive);
			assertInside(root, archive, "third-party archive");
			const info = await lstat(archive).catch(() => undefined);
			if (!info?.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error(`third-party archive 缺失、symlink 或超过大小上限：${name}`);
			const canonicalRoot = await realpath(root);
			if (await realpath(archive) !== resolve(canonicalRoot, expected.archive)) throw new Error(`third-party archive canonical 漂移：${name}`);
			// Ship the exact reviewed artifact, not a machine-local pack or a newly
			// repacked approximation. npm ci and launcher share the same integrity.
			const integrity = `sha512-${createHash("sha512").update(await readFile(archive)).digest("base64")}`;
			if (integrity !== expected.integrity) throw new Error(`third-party archive integrity 不匹配：${name}`);
		}
		const installed = await readStrictJsonFile(resolve(root, "node_modules", ...name.split("/"), "package.json"), `已安装 ${name} package.json`);
		if (installed.name !== name || installed.version !== expected.version) throw new Error(`已安装 ${name} identity/version 不匹配`);
	}
}

function assertInside(root, candidate, description) {
	const path = relative(root, candidate);
	if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
	throw new Error(`${description} 不在已验证 package 根目录内`);
}

async function readPackageForExecutable(executable) {
	const resolvedExecutable = await realpath(executable);
	let directory = dirname(resolvedExecutable);
	for (;;) {
		const packagePath = resolve(directory, "package.json");
		try {
			const raw = await readFile(packagePath, "utf8");
			let packageJson;
			try {
				packageJson = JSON.parse(raw);
			} catch {
				throw new Error(`无法解析 Pi package.json：${packagePath}`);
			}
			return { resolvedExecutable, packageRoot: directory, packagePath, packageJson };
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("无法解析")) throw error;
			if (error?.code !== "ENOENT") throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("无法从 pi 可执行文件确定本地 npm package identity");
}

function expectedResourceDeclarations(agentDir) {
	return RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
}

async function verifyOptionalHerdrExtension(declaration) {
	const prefix = "herdr-extension:";
	const extension = declaration.slice(prefix.length);
	if (!isAbsolute(extension) || !extension.endsWith("/.pi/agent/extensions/herdr-agent-state.ts")) {
		throw new Error("Herdr Pi extension 路径无效");
	}
	const info = await lstat(extension).catch(() => undefined);
	if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Herdr Pi extension 不是普通文件：${extension}`);
	const canonical = await realpath(extension);
	if (canonical !== extension) throw new Error(`Herdr Pi extension 路径不是 canonical：${extension}`);
	const content = await readFile(extension, "utf8");
	if (
		!content.startsWith("// installed by herdr\n// managed by herdr;") ||
		!content.includes("\n// HERDR_INTEGRATION_ID=pi\n") ||
		!content.includes(`\n// HERDR_INTEGRATION_VERSION=${VERIFIED_HERDR_PI_INTEGRATION_VERSION}\n`)
	) {
		throw new Error("Herdr Pi extension identity/version 不可信");
	}
}

async function verifyOptionalExtensions(declarations) {
	const seen = new Set();
	for (const declaration of declarations) {
		const kind = declaration.slice(0, declaration.indexOf(":"));
		if (seen.has(kind)) throw new Error("launcher 可选资源声明重复");
		seen.add(kind);
		if (declaration.startsWith("herdr-extension:")) {
			await verifyOptionalHerdrExtension(declaration);
		} else {
			throw new Error("launcher 可选资源声明不受支持");
		}
	}
}

async function verifyResourceContract(agentDir, declarations) {
	const canonicalAgentDir = await realpath(agentDir);
	const expected = expectedResourceDeclarations(agentDir);
	const required = declarations.slice(0, expected.length);
	const optional = declarations.slice(expected.length);
	if (required.length !== expected.length || required.some((value, index) => value !== expected[index]) || optional.length > 1) {
		throw new Error("launcher 显式资源与 CapabilityManifestV1 不一致");
	}
	await verifyOptionalExtensions(optional);
	for (const resource of RESOURCE_DESCRIPTORS_V1) {
		const resourceRoot = resolve(agentDir, resource.path);
		for (const requiredFile of resource.requiredFiles) {
			const file = resolve(resourceRoot, requiredFile);
			const nested = relative(agentDir, file);
			if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) throw new Error(`运行时资源越出产品目录：${file}`);
			const info = await lstat(file).catch(() => undefined);
			if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`缺少运行时资源、不是普通文件或为 symlink：${file}`);
			const canonical = await realpath(file).catch(() => undefined);
			if (!canonical) throw new Error(`无法解析运行时资源 canonical 路径：${file}`);
			assertInside(canonicalAgentDir, canonical, "运行时资源");
			if (relative(canonicalAgentDir, canonical) !== nested) throw new Error(`运行时资源路径包含 symlink 或 canonical 漂移：${file}`);
		}
	}
}

export async function probePiVersion({ executable, nodeVersion = process.versions.node }) {
	assertMinimumNodeVersion(nodeVersion);
	const resolved = await readPackageForExecutable(executable);
	const { packageJson, packageRoot, packagePath, resolvedExecutable } = resolved;
	if (packageJson.name !== VERIFIED_PI_PACKAGE) {
		throw new Error(`Pi package identity 不匹配：期望 ${VERIFIED_PI_PACKAGE}，实际 ${String(packageJson.name)}`);
	}
	if (typeof packageJson.version !== "string" || !EXACT_SEMVER.test(packageJson.version)) {
		throw new Error(`无法解析 Pi package 版本：${String(packageJson.version)}`);
	}
	if (typeof packageJson.bin?.pi !== "string" || packageJson.bin.pi.length === 0) {
		throw new Error("Pi package 缺少 bin.pi 声明");
	}
	const declaredExecutable = await realpath(resolve(packageRoot, packageJson.bin.pi)).catch(() => undefined);
	if (declaredExecutable !== resolvedExecutable) {
		throw new Error("pi 可执行文件与 package.json 的 bin.pi 不一致");
	}

	const publicExport = typeof packageJson.exports?.["."] === "string"
		? packageJson.exports["."]
		: packageJson.exports?.["."]?.import;
	if (typeof publicExport !== "string" || !publicExport.startsWith("./")) {
		throw new Error("Pi package 缺少可解析的公开 import 入口");
	}
	const publicEntry = await realpath(resolve(packageRoot, publicExport)).catch(() => undefined);
	if (!publicEntry) throw new Error("无法解析 Pi package 的公开入口");
	assertInside(packageRoot, publicEntry, "Pi 公开入口");
	return {
		executable: resolvedExecutable,
		packageRoot,
		packagePath,
		publicEntry,
		version: packageJson.version,
	};
}

export async function verifyPiRuntimeIdentity(options) {
	if (!isAbsolute(options.agentDir)) throw new Error("agentDir 必须是绝对路径");
	await verifyResourceContract(options.agentDir, options.resourceDeclarations);
	await verifyThirdPartyPackageContract(options.agentDir);
	return probePiVersion(options);
}

export async function verifyPiRuntime(options) {
	const verified = await verifyPiRuntimeIdentity(options);
	const runtime = await import(pathToFileURL(verified.publicEntry).href);
	if (runtime.VERSION !== verified.version) {
		throw new Error(`Pi 公开入口 VERSION 不一致：${String(runtime.VERSION)}`);
	}
	for (const exportName of ["defineTool", "createBashToolDefinition", "createAgentSession", "DefaultResourceLoader", "SettingsManager", "SessionManager", "ModelRuntime"]) {
		if (!(exportName in runtime)) throw new Error(`Pi 公开入口缺少关键能力：${exportName}`);
		if (typeof runtime[exportName] !== "function") throw new Error(`Pi 公开入口关键能力类型不兼容：${exportName}`);
	}
	const requiredMethods = [
		["DefaultResourceLoader.prototype.reload", runtime.DefaultResourceLoader.prototype?.reload],
		["DefaultResourceLoader.prototype.getExtensions", runtime.DefaultResourceLoader.prototype?.getExtensions],
		["DefaultResourceLoader.prototype.getSkills", runtime.DefaultResourceLoader.prototype?.getSkills],
		["SettingsManager.create", runtime.SettingsManager.create],
		["SessionManager.inMemory", runtime.SessionManager.inMemory],
		["ModelRuntime.create", runtime.ModelRuntime.create],
	];
	for (const [name, method] of requiredMethods) {
		if (typeof method !== "function") throw new Error(`Pi 公开入口关键方法不兼容：${name}`);
	}

	return verified;
}

async function main() {
	const args = process.argv.slice(2);
	const mode = args[0] === "--version-only" || args[0] === "--runtime" ? args.shift() : "--runtime";
	const [executable, agentDir, ...resourceDeclarations] = args;
	if (!executable || !agentDir) {
		throw new Error("用法：verify-pi-runtime.mjs [--runtime|--version-only] <pi-executable> <agent-dir> <kind:absolute-path>...");
	}
	const versionOnly = mode === "--version-only";
	const verified = await (versionOnly
		? verifyPiRuntimeIdentity({ executable, agentDir, resourceDeclarations })
		: verifyPiRuntime({ executable, agentDir, resourceDeclarations }));
	process.stdout.write(versionOnly ? verified.version : verified.executable);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (invokedPath === await realpath(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		process.stderr.write(`rotom: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
