import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { VERIFIED_THIRD_PARTY_PACKAGES } from "./product-config.mjs";
import { verifyThirdPartyPackageContract } from "./verify-pi-runtime.mjs";

const source = resolve(import.meta.dirname, "../extensions/third-party");
const archiveName = VERIFIED_THIRD_PARTY_PACKAGES["pi-subagents"].archive;

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "dev-agent-archive-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const thirdParty = join(root, "extensions/third-party");
	await mkdir(join(thirdParty, "vendor"), { recursive: true });
	const archives = Object.values(VERIFIED_THIRD_PARTY_PACKAGES).map((p) => p.archive).filter(Boolean);
	for (const name of ["package.json", "package-lock.json", ...archives]) await copyFile(join(source, name), join(thirdParty, name));
	// Package identity is enough for this focused contract; don't copy the entire
	// product or node_modules just to test a one-megabyte distribution archive.
	for (const [name, expected] of Object.entries(VERIFIED_THIRD_PARTY_PACKAGES)) {
		const directory = join(thirdParty, "node_modules", name);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: expected.version }));
	}
	return { root, thirdParty, archive: join(thirdParty, archiveName) };
}

test("relative locked archive works without the maintainer HOME", async (t) => {
	const { root, thirdParty } = await fixture(t);
	await verifyThirdPartyPackageContract(root);
	const lock = await readFile(join(thirdParty, "package-lock.json"), "utf8");
	assert.doesNotMatch(lock, /file:\/\/\/|\/Users\/|\/home\//u);
});

for (const scenario of ["missing", "bytes", "source", "file-symlink", "directory-symlink"]) {
	test(`locked archive rejects ${scenario}`, async (t) => {
		const { root, thirdParty, archive } = await fixture(t);
		if (scenario === "missing") await rm(archive);
		if (scenario === "bytes") await writeFile(archive, "not the reviewed package");
		if (scenario === "source") {
			const path = join(thirdParty, "package-lock.json");
			const lock = JSON.parse(await readFile(path, "utf8"));
			lock.packages["node_modules/pi-subagents"].resolved = "file:///tmp/unreviewed.tgz";
			await writeFile(path, JSON.stringify(lock));
		}
		if (scenario === "file-symlink") { await rename(archive, `${archive}.original`); await symlink(`${archive}.original`, archive); }
		if (scenario === "directory-symlink") {
			await rename(join(thirdParty, "vendor"), join(root, "outside"));
			await symlink(join(root, "outside"), join(thirdParty, "vendor"));
		}
		await assert.rejects(verifyThirdPartyPackageContract(root), /archive.*(?:缺失|integrity|source|canonical)/u);
	});
}
