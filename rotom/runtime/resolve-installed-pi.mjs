import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_PI_BUILD_SHA256, DISTRIBUTION_PI_VERSION, VERIFIED_PI_PACKAGE } from "./product-config.mjs";
import { probePiVersion } from "./verify-pi-runtime.mjs";

export const PI_RUNTIME = "runtime/pi";
export const PI_MODULES = `${PI_RUNTIME}/node_modules`;

async function ordinaryFile(path, maxBytes = 2 * 1024 * 1024) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || info.size > maxBytes) throw new Error(`非普通文件、过大或 canonical 漂移：${path}`);
}
async function json(path) {
	await ordinaryFile(path);
	return JSON.parse(await readFile(path, "utf8"));
}
function inside(root, path) {
	const nested = relative(root, path);
	if (!nested || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) throw new Error("Pi resource 越出 package root");
	return path;
}

export async function verifyDistributionContract(agentDir) {
	const root = await realpath(agentDir);
	const manifest = await json(resolve(root, "package.json"));
	const outerLock = await json(resolve(root, "npm-shrinkwrap.json"));
	if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(outerLock.packages?.[""]?.dependencies ?? {}).length || outerLock.lockfileVersion !== 3 || Object.keys(outerLock.packages ?? {}).length !== 1) throw new Error("rotom 不得从外部 dependency/shrinkwrap 加载 Pi");
	const runtime = resolve(root, PI_RUNTIME);
	const buildPath = resolve(runtime, "fork-build.json");
	await ordinaryFile(buildPath);
	const bytes = await readFile(buildPath);
	if (createHash("sha256").update(bytes).digest("hex") !== DISTRIBUTION_PI_BUILD_SHA256) throw new Error("Pi fork build identity 摘要不匹配");
	const build = JSON.parse(bytes);
	const pkg = await json(resolve(runtime, "package.json"));
	const lock = await json(resolve(runtime, "package-lock.json"));
	if (build.schema !== "rotom-pi-fork/v1" || build.version !== DISTRIBUTION_PI_VERSION || pkg.name !== "rotom-pi-runtime" || pkg.version !== build.version || pkg.private !== true || lock.lockfileVersion !== 3 || !build.artifacts?.[VERIFIED_PI_PACKAGE]) throw new Error("Pi fork runtime identity 不匹配");
	if (Object.keys(pkg.dependencies ?? {}).length !== Object.keys(lock.packages?.[""]?.dependencies ?? {}).length || Object.keys(pkg.dependencies).length !== Object.keys(build.artifacts).length) throw new Error("Pi fork dependency/lock 不匹配");
	for (const [name, artifact] of Object.entries(build.artifacts)) {
		const spec = `file:${artifact.file}`;
		const locked = lock.packages?.[`node_modules/${name}`];
		if (!/^vendor\/[a-z0-9.-]+\.tgz$/u.test(artifact.file) || artifact.version !== build.version || pkg.dependencies[name] !== spec || lock.packages?.[""]?.dependencies?.[name] !== spec || pkg.overrides?.[name] !== spec || locked?.resolved !== spec || locked?.version !== artifact.version || locked?.integrity !== artifact.integrity || locked?.link) throw new Error(`Pi fork dependency/version/shrinkwrap integrity 不匹配：${name}`);
		const archive = inside(runtime, resolve(runtime, artifact.file));
		await ordinaryFile(archive, 32 * 1024 * 1024);
		const integrity = `sha512-${createHash("sha512").update(await readFile(archive)).digest("base64")}`;
		if (integrity !== artifact.integrity) throw new Error(`Pi fork archive integrity 不匹配：${name}`);
	}
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path === "") continue;
		const local = build.artifacts[path.replace(/^node_modules\//u, "")];
		if (entry.link || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? "")) throw new Error(`Pi transitive source/integrity 缺失或不可信：${path}`);
		if (local) continue;
		const url = new URL(entry.resolved);
		if (url.origin !== "https://registry.npmjs.org" || url.username || url.password) throw new Error(`Pi transitive source/integrity 缺失或不可信：${path}`);
		if (path.includes("node_modules/@earendil-works/")) throw new Error(`不允许隐藏的上游 Pi 副本：${path}`);
	}
	return root;
}

// The installed fork is product-owned, not an ancestor npm/PATH search. A missing
// runtime never falls back to official Pi, a sibling checkout or an older release.
export async function resolveInstalledPi(agentDir) {
	const root = await verifyDistributionContract(agentDir);
	const build = await json(resolve(root, PI_RUNTIME, "fork-build.json"));
	let coding;
	for (const [name, artifact] of Object.entries(build.artifacts)) {
		const packageRoot = resolve(root, PI_MODULES, name);
		let pkg;
		try { pkg = await json(resolve(packageRoot, "package.json")); }
		catch (error) { if (error.code === "ENOENT") throw new Error("缺少 rotom 随附的 Pi fork；请重新安装 rotom，不会回退到全局 pi"); throw error; }
		if (pkg.name !== name || pkg.version !== artifact.version || pkg.rotomFork?.sourceSha256 !== build.sourceSha256 || pkg.rotomFork?.revision !== build.upstreamRevision) throw new Error(`rotom 安装的 Pi fork identity/version 不匹配：${name}`);
		if (name === VERIFIED_PI_PACKAGE) coding = { pkg, packageRoot };
	}
	const { pkg, packageRoot } = coding;
	if (typeof pkg.bin?.pi !== "string" || !pkg.bin.pi) throw new Error("Pi package 缺少 bin.pi");
	const executable = inside(packageRoot, resolve(packageRoot, pkg.bin.pi));
	await ordinaryFile(executable);
	await access(executable, constants.X_OK);
	const verified = await probePiVersion({ executable });
	const publicExport = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.import;
	if (typeof publicExport !== "string") throw new Error("Pi package 缺少 public export");
	await ordinaryFile(inside(packageRoot, resolve(packageRoot, publicExport)));
	return verified.executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { console.log(await resolveInstalledPi(process.argv[2])); }
	catch (error) { console.error(`rotom: ${error.message}`); process.exitCode = 1; }
}
