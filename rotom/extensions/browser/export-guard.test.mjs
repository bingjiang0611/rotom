import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_EXPORT_BYTES_V1, exportFormatForPathV1, resolveExportTargetV1 } from "./export-guard.ts";

async function workspace() {
	const root = await mkdtemp(join(tmpdir(), "pi-export-guard-"));
	return { root, done: () => rm(root, { recursive: true, force: true }) };
}

test("格式跟着扩展名走，冲突直接拒绝", () => {
	assert.equal(exportFormatForPathV1("/p/shot.png"), "png");
	assert.equal(exportFormatForPathV1("/p/shot.JPG"), "jpeg");
	assert.equal(exportFormatForPathV1("/p/shot.jpeg"), "jpeg");
	assert.equal(exportFormatForPathV1("/p/shot.bin"), undefined);
	assert.equal(exportFormatForPathV1("/p/shot"), undefined);
	assert.equal(exportFormatForPathV1("/p/shot.png", "png"), "png");
	assert.equal(exportFormatForPathV1("/p/shot.png", "jpeg"), undefined, "扩展名与格式不一致必须拒绝");
	assert.equal(exportFormatForPathV1("/p/shot.png", "webp"), undefined);
	assert.equal(MAX_EXPORT_BYTES_V1, 8 * 1024 * 1024);
});

test("相对与绝对路径都接受，但结果必须落在项目目录内", async () => {
	const { root, done } = await workspace();
	try {
		const relative = await resolveExportTargetV1({ path: "shots/a.png", cwd: root });
		assert.equal(relative.ok, true);
		assert.equal(relative.target.relativePath, join("shots", "a.png"));
		assert.equal(relative.target.path, join(root, "shots", "a.png"));
		assert.equal(relative.target.format, "png");
		assert.equal(relative.target.exists, false);

		const absolute = await resolveExportTargetV1({ path: join(root, "a.jpeg"), cwd: root });
		assert.equal(absolute.ok, true);
		assert.equal(absolute.target.relativePath, "a.jpeg");

		for (const path of ["../escape.png", "shots/../../escape.png", "/etc/passwd", "/tmp/other.png", root, "."]) {
			const refused = await resolveExportTargetV1({ path, cwd: root });
			assert.equal(refused.ok, false, path);
		}
	} finally {
		await done();
	}
});

test("符号链接与非普通文件都拒绝，普通文件允许覆盖", async () => {
	const { root, done } = await workspace();
	try {
		await writeFile(join(root, "real.png"), "x");
		await symlink(join(root, "real.png"), join(root, "link.png"));
		const linked = await resolveExportTargetV1({ path: "link.png", cwd: root });
		assert.equal(linked.ok, false);
		assert.match(linked.reason, /符号链接/u);

		const existing = await resolveExportTargetV1({ path: "real.png", cwd: root });
		assert.equal(existing.ok, true);
		assert.equal(existing.target.exists, true, "普通文件允许覆盖，但要如实标 exists");
	} finally {
		await done();
	}
});

test("目录与坏参数被拒", async () => {
	const { root, done } = await workspace();
	try {
		await mkdir(join(root, "dir.png"));
		const asDirectory = await resolveExportTargetV1({ path: "dir.png", cwd: root });
		assert.equal(asDirectory.ok, false);
		assert.match(asDirectory.reason, /目录/u);
		for (const path of ["", "a\0b.png", 7, undefined]) {
			const refused = await resolveExportTargetV1({ path, cwd: root });
			assert.equal(refused.ok, false, String(path));
		}
		const badFormat = await resolveExportTargetV1({ path: "a.png", cwd: root, format: "gif" });
		assert.equal(badFormat.ok, false);
	} finally {
		await done();
	}
});
