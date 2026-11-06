// Store packaging: the archive a reviewer would download must be readable by a real
// zip reader, must not carry the development key, and must be reproducible.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";

import { STORE_ZIP_NAME_V1, buildZipV1, packChromeExtensionV1, storeManifestV1 } from "./pack-chrome-extension.mjs";

const root = join(import.meta.dirname, "..", "extensions", "browser", "chrome-extension");

/** Independent reader: it trusts only the central directory, like a store does. */
function readZip(zip) {
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	assert.notEqual(eocd, -1, "缺少 EOCD");
	const count = zip.readUInt16LE(eocd + 10);
	let offset = zip.readUInt32LE(eocd + 16);
	const entries = [];
	for (let index = 0; index < count; index += 1) {
		const method = zip.readUInt16LE(offset + 10);
		const checksum = zip.readUInt32LE(offset + 16);
		const compressed = zip.readUInt32LE(offset + 20);
		const size = zip.readUInt32LE(offset + 24);
		const nameLength = zip.readUInt16LE(offset + 28);
		const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const localOffset = zip.readUInt32LE(offset + 42);
		assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, `${name} 的本地头无效`);
		const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
		const raw = zip.subarray(dataStart, dataStart + compressed);
		const data = method === 8 ? inflateRawSync(raw) : raw;
		entries.push({ name, data, checksum, size, method });
		offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
	}
	return entries;
}

test("商店 zip 可被独立读取器解出，且每个条目的 CRC 与长度一致", async () => {
	const output = await mkdtemp(join(tmpdir(), "chrome-store-"));
	try {
		const result = await packChromeExtensionV1({ extensionDir: root, outputPath: join(output, STORE_ZIP_NAME_V1) });
		const zip = await readFile(result.zipPath);
		assert.equal(zip.length, result.bytes);
		const entries = readZip(zip);
		assert.deepEqual(entries.map((entry) => entry.name).sort(), result.files.slice().sort());
		assert.ok(entries.some((entry) => entry.name === "manifest.json"));
		assert.ok(entries.some((entry) => entry.name === "service-worker.js"));
		for (const entry of entries) {
			assert.equal((crc32(entry.data) >>> 0), entry.checksum, `${entry.name} 的 CRC 不符`);
			assert.equal(entry.size, entry.data.length, `${entry.name} 的原始长度不符`);
		}
		const manifest = JSON.parse(entries.find((entry) => entry.name === "manifest.json").data.toString("utf8"));
		assert.equal("key" in manifest, false, "商店包不得携带开发用 key");
		assert.equal(manifest.manifest_version, 3);
		assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes("debugger"));
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});

test("同一份源码两次打包得到完全相同的字节", async () => {
	const directory = await mkdtemp(join(tmpdir(), "chrome-store-"));
	try {
		const first = await packChromeExtensionV1({ extensionDir: root, outputPath: join(directory, "a.zip") });
		// A rebuild must not depend on mtime, so touch-order cannot change the digest.
		const second = await packChromeExtensionV1({ extensionDir: root, outputPath: join(directory, "b.zip") });
		assert.equal(second.sha256, first.sha256);
		assert.deepEqual(await readFile(join(directory, "a.zip")), await readFile(join(directory, "b.zip")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("缺少开发用 key 时拒绝打包，而不是悄悄换一个扩展 id", () => {
	assert.throws(() => storeManifestV1({ name: "x", manifest_version: 3 }), /key/u);
	const kept = storeManifestV1({ name: "x", manifest_version: 3, key: "abc" });
	assert.equal("key" in kept.manifest, false);
	assert.equal(kept.developmentKey, "abc");
});

test("符号链接和不存在的 manifest 被拒绝", async () => {
	const directory = await mkdtemp(join(tmpdir(), "chrome-store-"));
	try {
		const extension = join(directory, "chrome-extension");
		await writeFile(join(directory, "placeholder"), "");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(extension);
		await writeFile(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, key: "k" }));
		await symlink(join(directory, "placeholder"), join(extension, "escape.js"));
		await assert.rejects(() => packChromeExtensionV1({ extensionDir: extension, outputPath: join(directory, "x.zip") }), /身份无效/u);
		const empty = join(directory, "empty");
		await mkdir(empty);
		await assert.rejects(() => packChromeExtensionV1({ extensionDir: empty, outputPath: join(directory, "y.zip") }), /manifest\.json/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("buildZipV1 对不可压缩内容也用 store 方法，且仍带 CRC", () => {
	const zip = buildZipV1([{ name: "a.bin", data: Buffer.from([1, 2, 3]) }]);
	const [entry] = readZip(zip);
	assert.equal(entry.name, "a.bin");
	assert.equal(entry.data.toString("hex"), "010203");
	assert.equal(entry.checksum, crc32(Buffer.from([1, 2, 3])) >>> 0);
});
