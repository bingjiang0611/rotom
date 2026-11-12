import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageVersion, exists, hashFile, run } from "./setup-helper-common.mjs";

const releaseRepo = "injaneity/pi-computer-use";
const releaseAssetName = "pi-computer-use.app.zip";

function githubReleaseUrl(tag, assetName) {
	return `https://github.com/${releaseRepo}/releases/download/${tag}/${assetName}`;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

async function downloadFile(url, outputPath) {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	if (!response.body) {
		throw new Error("empty response body");
	}
	await pipeline(response.body, createWriteStream(outputPath));
}

async function releaseChecksums(tag) {
	const response = await fetch(githubReleaseUrl(tag, "SHA256SUMS"), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) return new Map();
	const text = await response.text();
	const checksums = new Map();
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
		if (match) checksums.set(path.basename(match[2]), match[1].toLowerCase());
	}
	return checksums;
}

async function verifySha256(filePath, expected) {
	const file = await fs.readFile(filePath);
	const actual = createHash("sha256").update(file).digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
	}
}

async function findExtractedHelperApp(extractDir) {
	const direct = path.join(extractDir, "pi-computer-use.app");
	if (await exists(direct)) return direct;
	const entries = await fs.readdir(extractDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(extractDir, entry.name);
		if (entry.name === "pi-computer-use.app") return entryPath;
		const nested = await findExtractedHelperApp(entryPath);
		if (nested) return nested;
	}
	return undefined;
}

export async function downloadReleaseHelperApp() {
	const version = await packageVersion();
	const tag = `v${version}`;
	const checksums = await releaseChecksums(tag).catch(() => new Map());
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-release-helper-"));
	try {
		const zipPath = path.join(tempDir, releaseAssetName);
		await downloadFile(githubReleaseUrl(tag, releaseAssetName), zipPath);
		const expectedSha = checksums.get(releaseAssetName);
		if (expectedSha) await verifySha256(zipPath, expectedSha);
		const extractDir = path.join(tempDir, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
		const appPath = await findExtractedHelperApp(extractDir);
		if (!appPath) throw new Error(`missing pi-computer-use.app in ${releaseAssetName}`);
		return { appPath, tempDir, assetName: releaseAssetName, tag };
	} catch (error) {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
		throw new Error(`No signed helper release asset found for ${tag}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
