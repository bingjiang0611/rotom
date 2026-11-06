#!/usr/bin/env node
// Store zip for the browser relay extension.
//
// The Chrome Web Store assigns the extension id itself, so the unpacked-development
// `key` field must not ship. Losing it changes the id, which changes the native host's
// `allowed_origins`: the zip records the old and the future id so the host manifest can
// list both after the review lands.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

export const STORE_ZIP_NAME_V1 = "rotom-browser-relay.zip";
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 64;
// Deterministic archive: fixed timestamp and permissions, so the same sources always
// produce the same bytes and the digest is a real artifact identity.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33; // 1980-01-01
const FIXED_MODE_ATTRS = 0o644 << 16;

function dosDateTime() {
	return { time: FIXED_DOS_TIME, date: FIXED_DOS_DATE };
}

/** Minimal store-or-deflate zip writer; no dependency, and no directory entries. */
export function buildZipV1(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = entry.data;
		const deflated = deflateRawSync(data, { level: 9 });
		const useDeflate = deflated.length < data.length;
		const body = useDeflate ? deflated : data;
		const method = useDeflate ? 8 : 0;
		const sum = crc32(data) >>> 0;
		const { time, date } = dosDateTime();
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(sum, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4); // made by: unix, zip 3.0
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(sum, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(FIXED_MODE_ATTRS, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Store shape: no `key`, the store-reserved name, and an id note. Everything else in the
 * manifest is the same object the unpacked extension ships.
 */
export function storeManifestV1(manifest) {
	const { key, ...rest } = manifest;
	if (typeof key !== "string" || key.length === 0) throw new Error("chrome-extension/manifest.json 没有开发用 key，无法记录扩展 id 迁移");
	return { manifest: { ...rest, name: rest.name }, developmentKey: key };
}

async function collectFiles(base) {
	const files = [];
	async function visit(directory, prefix) {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const info = await lstat(path);
			if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error(`扩展资源路径身份无效：${prefix}${name}`);
			if (info.isDirectory()) { await visit(path, `${prefix}${name}/`); continue; }
			if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ENTRY_BYTES) throw new Error(`扩展资源文件无效：${prefix}${name}`);
			if (files.length >= MAX_ENTRIES) throw new Error("扩展资源数量超限");
			files.push({ name: `${prefix}${name}`, path, size: info.size });
		}
	}
	await visit(base, "");
	return files;
}

export async function packChromeExtensionV1({ extensionDir, outputPath }) {
	const files = await collectFiles(extensionDir);
	const manifestEntry = files.find((file) => file.name === "manifest.json");
	if (manifestEntry === undefined) throw new Error("扩展缺少 manifest.json");
	const manifest = JSON.parse(await readFile(manifestEntry.path, "utf8"));
	const { manifest: shipped, developmentKey } = storeManifestV1(manifest);
	const entries = [];
	for (const file of files) {
		// Uploading the development key would move the extension id away from the one the
		// native host already allows, so the store copy is built from the stripped manifest.
		const data = file.name === "manifest.json" ? Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`) : await readFile(file.path);
		entries.push({ name: file.name, data });
	}
	const zip = buildZipV1(entries);
	await writeFile(outputPath, zip);
	const digest = createHash("sha256").update(zip).digest("hex");
	return {
		zipPath: outputPath,
		bytes: zip.length,
		sha256: digest,
		files: entries.map((entry) => entry.name),
		removedKey: true,
		note: "商店会分配新的扩展 id；上架后需要把该 id 与现有 id 一起写进 native host manifest 的 allowed_origins。",
	};
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const output = process.argv[2];
	if (output === undefined || !isAbsolute(output)) throw new Error("usage: pack-chrome-extension.mjs /absolute/output/dir");
	const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "browser", "chrome-extension");
	const result = await packChromeExtensionV1({ extensionDir, outputPath: join(output, STORE_ZIP_NAME_V1) });
	console.log(JSON.stringify(result, null, 2));
}
