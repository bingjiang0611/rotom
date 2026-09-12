import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_PI_INTEGRITY, DISTRIBUTION_PI_VERSION, VERIFIED_PI_PACKAGE } from "./product-config.mjs";
import { probePiVersion } from "./verify-pi-runtime.mjs";

async function ordinaryFile(path) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`非普通文件或 canonical 漂移：${path}`);
	return info;
}

async function json(path) {
	const info = await ordinaryFile(path);
	if (info.size > 2 * 1024 * 1024) throw new Error(`package metadata 超出大小上限：${path}`);
	return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyDistributionContract(agentDir) {
	const root = await realpath(agentDir);
	const manifest = await json(resolve(root, "package.json"));
	const lock = await json(resolve(root, "npm-shrinkwrap.json"));
	const locked = lock.packages?.[`node_modules/${VERIFIED_PI_PACKAGE}`];
	if (manifest.dependencies?.[VERIFIED_PI_PACKAGE] !== DISTRIBUTION_PI_VERSION ||
		lock.lockfileVersion !== 3 || lock.packages?.[""]?.dependencies?.[VERIFIED_PI_PACKAGE] !== DISTRIBUTION_PI_VERSION ||
		locked?.version !== DISTRIBUTION_PI_VERSION || locked?.integrity !== DISTRIBUTION_PI_INTEGRITY || locked?.link) {
		throw new Error("rotom 的 Pi dependency/version/shrinkwrap integrity 不匹配");
	}
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "") continue;
		const url = new URL(entry.resolved);
		if (entry.link || url.origin !== "https://registry.npmjs.org" || url.username || url.password || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? "")) {
			throw new Error(`rotom shrinkwrap transitive source/integrity 缺失或不可信：${path}`);
		}
	}
	return root;
}

// Use npm's ancestor node_modules layout, including a local install's hoisted
// dependency. Never consult PATH, NODE_PATH, or global module search directories.
export async function resolveInstalledPi(agentDir) {
	const root = await verifyDistributionContract(agentDir);
	let directory = root;
	for (;;) {
		const packageRoot = resolve(directory, "node_modules", VERIFIED_PI_PACKAGE);
		const metadata = resolve(packageRoot, "package.json");
		const exists = await lstat(packageRoot).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		});
		if (exists) {
			const pkg = await json(metadata);
			if (pkg.name !== VERIFIED_PI_PACKAGE || pkg.version !== DISTRIBUTION_PI_VERSION) throw new Error("rotom 安装的 Pi identity/version 不匹配");
			if (typeof pkg.bin?.pi !== "string" || !pkg.bin.pi) throw new Error("Pi package 缺少 bin.pi");
			const executable = resolve(packageRoot, pkg.bin.pi);
			const nested = relative(packageRoot, executable);
			if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) throw new Error("Pi bin.pi 越出 package root");
			await ordinaryFile(executable);
			await access(executable, constants.X_OK);
			const verified = await probePiVersion({ executable });
			const publicExport = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.import;
			await ordinaryFile(resolve(packageRoot, publicExport));
			return verified.executable;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("缺少 rotom 随附的 Pi 依赖；请重新安装 rotom（源码开发请在 rotom/ 执行 npm ci），不会回退到全局 pi");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { console.log(await resolveInstalledPi(process.argv[2])); }
	catch (error) { console.error(`rotom: ${error.message}`); process.exitCode = 1; }
}
