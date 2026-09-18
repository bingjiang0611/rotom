#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@bingjiang0611/rotom";
export const REGISTRY = "https://registry.npmjs.org";
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TAG = /^[a-z][a-z0-9._-]{0,63}$/u;

function digest(algorithm, bytes, encoding = "hex") {
	return createHash(algorithm).update(bytes).digest(encoding);
}

export function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function inspectArtifact(input) {
	if (!isAbsolute(input)) throw new Error("artifact path must be absolute");
	const artifact = realpathSync(input);
	const stat = lstatSync(input);
	if (!stat.isFile() || stat.isSymbolicLink() || artifact !== input) throw new Error("artifact must be a canonical regular file, not a symlink");
	if (stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) throw new Error("artifact size is outside the 64 MiB release bound");
	let manifest;
	try {
		manifest = JSON.parse(execFileSync("tar", ["-xzOf", artifact, "package/package.json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }));
	} catch {
		throw new Error("artifact does not contain a readable package/package.json");
	}
	if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw new Error("artifact package identity or version is invalid");
	if (manifest.private !== false || manifest.publishConfig?.access !== "public" || manifest.publishConfig?.registry !== REGISTRY) throw new Error("artifact public publish contract is invalid");
	const bytes = readFileSync(artifact);
	return {
		artifact,
		name: manifest.name,
		version: manifest.version,
		bytes: bytes.length,
		sha256: digest("sha256", bytes),
		shasum: digest("sha1", bytes),
		integrity: `sha512-${digest("sha512", bytes, "base64")}`,
	};
}

function validateTag(tag) {
	if (!TAG.test(tag)) throw new Error("dist-tag must be a simple npm tag");
	return tag;
}

function packageUrl(version) {
	return `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`;
}

function rootUrl() {
	return `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}`;
}

async function boundedBytes(response) {
	if (!response.ok || !response.body) throw new Error(`registry returned HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_ARTIFACT_BYTES) throw new Error("registry tarball exceeded the 64 MiB release bound");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

async function json(response, label) {
	if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
	return response.json();
}

export async function preflightRelease(artifactInput, tagInput, fetchImpl = fetch) {
	const artifact = inspectArtifact(artifactInput);
	const tag = validateTag(tagInput);
	const versionResponse = await fetchImpl(packageUrl(artifact.version), { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
	if (versionResponse.status !== 404) {
		if (versionResponse.ok) throw new Error(`${artifact.name}@${artifact.version} already exists; npm versions are immutable`);
		throw new Error(`target version lookup returned HTTP ${versionResponse.status}`);
	}
	const root = await json(await fetchImpl(rootUrl(), { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(10_000) }), "package metadata");
	if (root.name !== artifact.name) throw new Error("registry package identity mismatch");
	return { ...artifact, tag, currentTag: root["dist-tags"]?.[tag] ?? null, targetAbsent: true };
}

export async function verifyRelease(artifactInput, tagInput, fetchImpl = fetch) {
	const artifact = inspectArtifact(artifactInput);
	const tag = validateTag(tagInput);
	const metadata = await json(await fetchImpl(packageUrl(artifact.version), { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(10_000) }), "published version");
	const root = await json(await fetchImpl(rootUrl(), { headers: { accept: "application/json", "cache-control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(10_000) }), "package metadata");
	if (metadata.name !== artifact.name || metadata.version !== artifact.version) throw new Error("published package identity mismatch");
	if (root["dist-tags"]?.[tag] !== artifact.version) throw new Error(`dist-tag ${tag} does not point to ${artifact.version}`);
	if (metadata.dist?.integrity !== artifact.integrity || metadata.dist?.shasum !== artifact.shasum) throw new Error("registry integrity or shasum differs from the frozen artifact");
	const tarball = new URL(metadata.dist?.tarball ?? "");
	if (tarball.protocol !== "https:" || tarball.origin !== REGISTRY || tarball.username || tarball.password) throw new Error("registry returned an untrusted tarball URL");
	const remote = await boundedBytes(await fetchImpl(tarball, { redirect: "error", signal: AbortSignal.timeout(180_000) }));
	const local = readFileSync(artifact.artifact);
	if (!remote.equals(local)) throw new Error("registry tarball bytes differ from the frozen artifact");
	return { ...artifact, tag, tarball: tarball.href, verified: true };
}

export function handoffCommands(artifactInput, tagInput = "latest", scriptPath = fileURLToPath(import.meta.url)) {
	const artifact = inspectArtifact(artifactInput);
	const tag = validateTag(tagInput);
	const repository = resolve(dirname(scriptPath), "..");
	const helper = shellQuote(realpathSync(scriptPath));
	const tgz = shellQuote(artifact.artifact);
	const install = shellQuote(resolve(repository, "scripts/install-release.sh"));
	return `# 请在同一个前台终端中逐段执行，保持下面的临时环境变量\n# 1) 无凭据只读检查：目标版本必须不存在\nnode ${helper} preflight ${tgz} ${shellQuote(tag)}\n\n# 2) 创建本次发布专用的私有 npm 配置，再由你完成网页登录\numask 077\nexport ROTOM_NPM_AUTH_DIR="$(mktemp -d \"\${TMPDIR:-/tmp}/rotom-npm-auth.XXXXXX\")"\nexport NPM_CONFIG_USERCONFIG="$ROTOM_NPM_AUTH_DIR/user.npmrc"\nexport NPM_CONFIG_GLOBALCONFIG="$ROTOM_NPM_AUTH_DIR/global.npmrc"\nexport NPM_CONFIG_CACHE="$ROTOM_NPM_AUTH_DIR/cache"\nexport ROTOM_RELEASE_CWD="$PWD"\nunset NPM_TOKEN NODE_AUTH_TOKEN\n: > "$NPM_CONFIG_USERCONFIG"\n: > "$NPM_CONFIG_GLOBALCONFIG"\ncd "$ROTOM_NPM_AUTH_DIR"\nnpm login --auth-type=web --registry=${REGISTRY}\nnpm whoami --registry=${REGISTRY}\n\n# 3) 不可逆发布：确认前两步通过后由你执行一次\nnpm publish ${tgz} --ignore-scripts --access public --tag ${shellQuote(tag)} --registry=${REGISTRY}\n\n# 4) 若遇到 EOTP，只完成 npm 输出的官方网页确认；先运行下面的只读核验，不要盲目重发 publish\nnode ${helper} verify ${tgz} ${shellQuote(tag)}\n\n# 5) 仅在 verify 显示 verified=true 后，由你切换本机版本\n${install} ${tgz}\nrotom --version --verbose\n\n# 6) 撤销并删除本次临时认证；whoami 失败是预期回读\nnpm logout --registry=${REGISTRY}\nif npm whoami --registry=${REGISTRY}; then echo 'credential cleanup unproven' >&2; else echo 'temporary npm credential removed'; fi\ncd "$ROTOM_RELEASE_CWD"\ncase "\${ROTOM_NPM_AUTH_DIR:-}" in */rotom-npm-auth.??????) rm -rf -- "$ROTOM_NPM_AUTH_DIR" ;; *) echo 'refusing unexpected auth directory' >&2 ;; esac\nunset ROTOM_NPM_AUTH_DIR ROTOM_RELEASE_CWD NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_CACHE`;
}

async function main() {
	const [action, artifact, tag = "latest"] = process.argv.slice(2);
	if (!artifact || !["commands", "preflight", "verify"].includes(action)) throw new Error("usage: npm-release-handoff.mjs <commands|preflight|verify> /absolute/rotom.tgz [tag]");
	if (action === "commands") {
		const evidence = JSON.stringify(inspectArtifact(artifact), null, 2).split("\n").map((line) => `# ${line}`).join("\n");
		console.log(`# 冻结产物证据（注释，不会作为命令执行）\n${evidence}\n\n${handoffCommands(artifact, tag)}`);
		return;
	}
	const result = action === "preflight" ? await preflightRelease(artifact, tag) : await verifyRelease(artifact, tag);
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`npm-release-handoff: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
