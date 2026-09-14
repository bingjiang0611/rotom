#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const ROTOM_PACKAGE_NAME = "@bingjiang0611/rotom";
export const ROTOM_REGISTRY = "https://registry.npmjs.org";
export const ROTOM_LATEST_URL = `${ROTOM_REGISTRY}/%40bingjiang0611%2Frotom/latest`;
const MAX_METADATA_BYTES = 256 * 1024;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseSemver(version) {
	const match = SEMVER_PATTERN.exec(version);
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4]?.split(".") ?? [],
	};
}

export function compareSemver(left, right) {
	const a = parseSemver(left);
	const b = parseSemver(right);
	if (!a || !b) throw new Error("invalid semantic version");
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
		const aPart = a.prerelease[index];
		const bPart = b.prerelease[index];
		if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
		if (aPart === bPart) continue;
		const aNumeric = /^\d+$/u.test(aPart);
		const bNumeric = /^\d+$/u.test(bPart);
		if (aNumeric && bNumeric) return Number(aPart) < Number(bPart) ? -1 : 1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return aPart < bPart ? -1 : 1;
	}
	return 0;
}

export function selectLatestVersion(metadata) {
	if (!metadata || typeof metadata !== "object") return undefined;
	if (metadata.name !== ROTOM_PACKAGE_NAME || typeof metadata.version !== "string") return undefined;
	return parseSemver(metadata.version) ? metadata.version : undefined;
}

async function readBoundedJson(response) {
	if (!response.ok || !response.body) throw new Error(`registry returned HTTP ${response.status}`);
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_METADATA_BYTES) {
				await reader.cancel();
				throw new Error("registry metadata exceeded 256 KiB");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readProductManifest(packageRoot) {
	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (manifest.name !== ROTOM_PACKAGE_NAME || typeof manifest.version !== "string" || !parseSemver(manifest.version)) {
		throw new Error(`current installation is not a valid ${ROTOM_PACKAGE_NAME} package`);
	}
	return manifest;
}

function defaultRunCommand(command, args, options) {
	return spawnSync(command, args, {
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
}

function commandFailure(command, result) {
	if (result.error) return `${command}: ${result.error.message}`;
	if (result.signal) return `${command} terminated by signal ${result.signal}`;
	return `${command} exited with code ${result.status ?? "unknown"}`;
}

async function confirmUpdate() {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("cannot confirm from a non-interactive terminal; after exiting every other rotom session, rerun with --force");
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await prompt.question("Continue? [y/N] ")).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		prompt.close();
	}
}

export async function updateRotom(options = {}) {
	const packageRoot = await realpath(options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	const current = await readProductManifest(packageRoot);
	const npmCommand = options.npmCommand ?? join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
	const runCommand = options.runCommand ?? defaultRunCommand;
	const fetchImpl = options.fetchImpl ?? fetch;
	const output = options.output ?? ((message) => process.stdout.write(`${message}\n`));
	await access(npmCommand, constants.X_OK);

	const rootResult = runCommand(npmCommand, ["root", "--global"], { capture: true });
	if (rootResult.status !== 0) throw new Error(commandFailure("npm root --global", rootResult));
	const npmRootOutput = String(rootResult.stdout ?? "").trim();
	if (!isAbsolute(npmRootOutput)) throw new Error("npm root --global did not return an absolute path");
	let npmRoot;
	let installedRoot;
	try {
		npmRoot = await realpath(npmRootOutput);
		const installedPath = join(npmRoot, ROTOM_PACKAGE_NAME);
		const scopeStat = await lstat(dirname(installedPath));
		const installedStat = await lstat(installedPath);
		if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink() || !installedStat.isDirectory() || installedStat.isSymbolicLink()) {
			throw new Error("linked installation");
		}
		installedRoot = await realpath(installedPath);
	} catch {
		throw new Error("rotom update supports only a regular active global npm installation");
	}
	if (installedRoot !== packageRoot) {
		throw new Error(`active rotom is not owned by this npm prefix (${npmRoot})`);
	}

	const metadata = await readBoundedJson(await fetchImpl(ROTOM_LATEST_URL, {
		headers: {
			accept: "application/json",
			"cache-control": "no-cache",
			"User-Agent": `rotom/${current.version}`,
		},
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	}));
	const latest = selectLatestVersion(metadata);
	if (!latest) throw new Error("registry latest metadata has an invalid package identity or version");
	const order = compareSemver(latest, current.version);
	if (!options.force && order <= 0) {
		output(`rotom is already up to date (${current.version}).`);
		return { currentVersion: current.version, latestVersion: latest, updated: false };
	}
	if (order < 0) throw new Error(`refusing to downgrade rotom ${current.version} to registry latest ${latest}`);

	output("This replaces the active global rotom installation. Exit every other rotom session and worker before continuing.");
	if (!options.force && !(await (options.confirm ?? confirmUpdate)())) {
		output("Update cancelled.");
		return { currentVersion: current.version, latestVersion: latest, updated: false };
	}

	const installSpec = `${ROTOM_PACKAGE_NAME}@${latest}`;
	output(`Updating rotom ${current.version} → ${latest}...`);
	const installResult = runCommand(npmCommand, [
		"install",
		"--global",
		"--ignore-scripts",
		"--prefer-online",
		`--registry=${ROTOM_REGISTRY}`,
		installSpec,
	], { capture: false });
	if (installResult.status !== 0) {
		throw new Error(`${commandFailure("npm install", installResult)}; update status is unknown—run rotom --version before retrying`);
	}
	const installed = await readProductManifest(installedRoot);
	if (installed.version !== latest) {
		throw new Error(`npm exited successfully but installed ${installed.version}, expected ${latest}`);
	}
	output(`Updated rotom to ${latest}. Exit every other rotom session, then start a new one; running sessions do not hot-reload.`);
	return { currentVersion: current.version, latestVersion: latest, updated: true };
}

async function main() {
	let force = false;
	for (const argument of process.argv.slice(2)) {
		if (argument === "--force") force = true;
		else throw new Error(`unsupported rotom update option: ${argument}`);
	}
	await updateRotom({ force });
}

async function invokedAsMain() {
	if (!process.argv[1]) return false;
	try {
		return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (await invokedAsMain()) {
	main().catch((error) => {
		process.stderr.write(`rotom update: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
