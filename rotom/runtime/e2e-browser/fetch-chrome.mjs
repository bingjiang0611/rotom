#!/usr/bin/env node

// Download Chrome for Testing into the harness cache.
//
// Chrome for Testing is the only supported browser for the e2e suites: branded
// Google Chrome 137+ ignores --load-extension, and Chromium may not be installed.
// This never touches the operator's Chrome profile or install.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheDir = process.env.ROTOM_E2E_CHROME_CACHE
	?? (process.platform === "darwin"
		? join(process.env.HOME ?? tmpdir(), "Library", "Caches", "rotom-e2e")
		: join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache"), "rotom-e2e"));

function platformPath(version) {
	if (process.platform === "darwin") {
		const arch = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
		return `/${version}/${arch}/chrome-${arch}.zip`;
	}
	if (process.platform === "linux") return `/${version}/linux64/chrome-linux64.zip`;
	throw new Error(`Chrome for Testing 当前只支持 macOS 和 Linux；其它平台请自行设置 ROTOM_CHROME_EXECUTABLE（${process.platform}）`);
}

async function main() {
	const listing = await (await fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json")).json();
	const stable = listing.channels?.Stable;
	if (!stable?.version) throw new Error("无法读取 Chrome for Testing 最新 Stable 版本");
	const suffix = platformPath(stable.version);
	const entry = (stable.downloads?.chrome ?? []).find((item) => item.url.endsWith(suffix));
	if (!entry) throw new Error(`Chrome for Testing ${stable.version} 没有匹配 ${suffix} 的下载`);
	mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	chmodSync(cacheDir, 0o700);
	const staging = mkdtempSync(join(cacheDir, "download-"));
	const archive = join(staging, "chrome.zip");
	process.stdout.write(`下载 ${entry.url}\n`);
	const response = await fetch(entry.url);
	if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
	const hash = createHash("sha256");
	const file = createWriteStream(archive, { mode: 0o600 });
	for await (const chunk of response.body) {
		hash.update(chunk);
		if (!file.write(chunk)) await new Promise((drain) => file.once("drain", drain));
	}
	await new Promise((done, reject) => file.end((error) => (error ? reject(error) : done())));
	const digest = hash.digest("hex");
	process.stdout.write(`sha256=${digest}\n`);
	const unzipped = spawnSync("unzip", ["-q", "-o", archive, "-d", staging], { stdio: "inherit" });
	if (unzipped.status !== 0) throw new Error("解压 Chrome for Testing 失败");
	for (const name of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-linux64"]) {
		if (!existsSync(join(staging, name))) continue;
		const target = join(cacheDir, name);
		rmSync(target, { recursive: true, force: true });
		renameSync(join(staging, name), target);
	}
	rmSync(staging, { recursive: true, force: true });
	process.stdout.write(`完成。设置 ROTOM_CHROME_EXECUTABLE 或直接运行 run.mjs（默认从 ${cacheDir} 解析）。\n`);
}

await main();
