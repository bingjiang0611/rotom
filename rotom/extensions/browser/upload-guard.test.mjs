import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_UPLOAD_TOTAL_BYTES_V1, inspectUploadPathV1, validateUploadPathsV1 } from "./upload-guard.ts";

const workspace = await mkdtemp(join(tmpdir(), "rotom-upload-guard-"));
const file = join(workspace, "notes.txt");
await writeFile(file, "hello upload\n");
const big = join(workspace, "big.bin");
await writeFile(big, Buffer.alloc(MAX_UPLOAD_TOTAL_BYTES_V1 + 1));
const nested = join(workspace, ".ssh");
await mkdir(nested, { recursive: true });
const secret = join(nested, "config");
await writeFile(secret, "secret\n");
const pem = join(workspace, "server.pem");
await writeFile(pem, "pem\n");
// A hard link needs its own source file; linking to `file` would raise its nlink and make
// the "plain file" case fail.
const linkSource = join(workspace, "link-source.txt");
await writeFile(linkSource, "linked\n");
const hardlink = join(workspace, "linked.txt");
await link(linkSource, hardlink);
const symlinked = join(workspace, "sym.txt");
await symlink(file, symlinked);
const dirLink = join(workspace, "linkdir");
await symlink(workspace, dirLink);

const rejection = (path) => async () => {
	await assert.rejects(validateUploadPathsV1({ paths: [path], allowUpload: true }), /upload 被拒绝/u);
};

test("upload：普通文件通过，返回真实路径、名字与大小", async () => {
	const inspected = await inspectUploadPathV1(file);
	assert.equal(inspected.ok, true);
	assert.equal(inspected.path, file);
	assert.equal(inspected.name, "notes.txt");
	assert.equal(inspected.size, 13);
	const files = await validateUploadPathsV1({ paths: [file], allowUpload: true });
	assert.deepEqual(files.map((entry) => entry.name), ["notes.txt"]);
});

test("upload：相对路径、空路径、含 NUL 的路径被拒绝", async () => {
	await assert.rejects(validateUploadPathsV1({ paths: ["notes.txt"], allowUpload: true }), /绝对路径/u);
	await assert.rejects(validateUploadPathsV1({ paths: [""], allowUpload: true }), /路径为空/u);
	await assert.rejects(validateUploadPathsV1({ paths: [`${file}\0x`], allowUpload: true }), /非法字符/u);
	await assert.rejects(validateUploadPathsV1({ paths: [], allowUpload: true }), /至少一个/u);
	await assert.rejects(validateUploadPathsV1({ paths: [file] }), /lease 不允许 upload/u);
});

test("upload：符号链接、硬链接、目录、不存在的文件被拒绝", async () => {
	await rejection(symlinked)();
	await rejection(hardlink)();
	await rejection(workspace)();
	await rejection(join(workspace, "missing.txt"))();
	// A symlinked directory is fine while it stays benign, and rejected as soon as the
	// resolved path enters a sensitive directory.
	const viaLink = await inspectUploadPathV1(join(dirLink, "notes.txt"));
	assert.equal(viaLink.ok, true);
	const escaped = join(workspace, "escapelink");
	await symlink(nested, escaped);
	await writeFile(join(nested, "notes2.txt"), "x\n");
	const viaEscape = await inspectUploadPathV1(join(escaped, "notes2.txt"));
	assert.equal(viaEscape.ok, false);
	assert.match(viaEscape.reason, /敏感文件名/u);
});

test("upload：敏感文件名与目录名逐段拒绝", async () => {
	for (const path of [secret, pem, join(workspace, ".env"), join(workspace, ".env.local"), join(workspace, "id_rsa"), join(workspace, "client.key"), join(workspace, ".netrc"), join(workspace, ".npmrc")]) {
		const inspected = await inspectUploadPathV1(path);
		assert.equal(inspected.ok, false, path);
		assert.match(inspected.reason, /敏感文件名/u);
	}
	const aws = await inspectUploadPathV1(join(workspace, ".aws", "credentials"));
	assert.equal(aws.ok, false);
});

test("upload：总大小上限、文件个数上限与重复路径", async () => {
	await assert.rejects(validateUploadPathsV1({ paths: [big], allowUpload: true }), /总大小超过/u);
	await assert.rejects(validateUploadPathsV1({ paths: [file, file], allowUpload: true }), /不得重复/u);
	await assert.rejects(validateUploadPathsV1({ paths: Array.from({ length: 11 }, () => file), allowUpload: true }), /最多 10 个/u);
	const many = await validateUploadPathsV1({ paths: Array.from({ length: 10 }, (_, index) => file), allowUpload: true }).catch((error) => error);
	assert.ok(many instanceof Error, "重复路径先被拒，说明去重发生在个数检查之后");
});

test("upload：注入的 lstat/realpath/stat 用于边界分支", async () => {
	const enoent = await inspectUploadPathV1(file, { lstat: async () => { throw new Error("missing"); } });
	assert.equal(enoent.reason, "文件不存在或无法读取");
	const unsafesize = await inspectUploadPathV1(file, { stat: async () => ({ size: Number.NaN }) });
	assert.equal(unsafesize.ok, false);
	const noReal = await inspectUploadPathV1(file, { realpath: async () => { throw new Error("nope"); } });
	assert.equal(noReal.reason, "无法解析真实路径");
	const renamed = await inspectUploadPathV1(file, { realpath: async () => join(workspace, "other.txt") });
	assert.equal(renamed.reason, "真实文件与给定文件名不一致");
});

test.after(async () => { await rm(workspace, { recursive: true, force: true }); });
