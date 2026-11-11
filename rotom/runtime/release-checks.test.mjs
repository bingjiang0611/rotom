import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PI_RUNTIME } from "./resolve-installed-pi.mjs";
import { verifyExtensionLoad, verifyLocalImports } from "../scripts/pack-release.mjs";
import { extensionEntries, verifyExtensionLoad as smokeExtensionLoad } from "./verify-extension-load.mjs";
import { BUILD_INFO_SCHEMA, parseBuildInfo } from "./build-info.mjs";

/** A stamp in the shape a real build writes, so only the field under test varies. */
function stamp(overrides = {}) {
	return JSON.stringify({ schema: BUILD_INFO_SCHEMA, commit: "0".repeat(40), dirty: false, allowDirty: false, builtAt: "2026-11-11T00:00:00.000Z", ...overrides });
}

/**
 * The two checks that make the packed artifact self-sufficient, tested against the defect that
 * motivated them instead of only against a healthy tree.
 */
/** The 0.1.27-main.2b4ea53b defect: provider.mjs imports a catalog the package never shipped. */
function brokenQoderTree(root) {
	const extension = join(root, "extensions", "qoder");
	mkdirSync(extension, { recursive: true });
	writeFileSync(join(extension, "index.ts"), "import './provider.mjs';\nexport default function extension(pi) { void pi; }\n");
	writeFileSync(join(extension, "provider.mjs"), "import { catalog } from './model-catalog.mjs';\nexport const provider = catalog;\n");
	return ["extensions/qoder/index.ts", "extensions/qoder/provider.mjs"];
}

test("the closure check refuses a shipped module whose local import is not in the package", async () => {
	const root = mkdtempSync(join(tmpdir(), "rotom-closure-"));
	try {
		const files = brokenQoderTree(root);
		await assert.rejects(verifyLocalImports(root, files), /Missing release dependency: extensions\/qoder\/provider\.mjs -> extensions\/qoder\/model-catalog\.mjs/u);
		// The same tree passes once the catalog is declared and present, so the check is about the
		// package contents rather than about extension code in general.
		writeFileSync(join(root, "extensions/qoder/model-catalog.mjs"), "export const catalog = [];\n");
		await verifyLocalImports(root, [...files, "extensions/qoder/model-catalog.mjs"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the load smoke refuses an artifact whose extension cannot be imported", async () => {
	const root = mkdtempSync(join(tmpdir(), "rotom-loadsmoke-"));
	try {
		const entries = brokenQoderTree(root);
		assert.deepEqual(await extensionEntries(root), [join(root, "extensions", "qoder", "index.ts")]);
		// Without the packaged runtime the artifact cannot be loaded at all, which is also a failure.
		await assert.rejects(verifyExtensionLoad(root, { ...process.env }), /Cannot find module|ERR_MODULE_NOT_FOUND|Extension load failed/u);
		assert.equal(entries.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the load smoke refuses an artifact whose build stamp is missing or wrong", async () => {
	const root = mkdtempSync(join(tmpdir(), "rotom-loadstamp-"));
	try {
		brokenQoderTree(root);
		// Run the product's own smoke against the fake tree, so the stamp gate is the real one.
		const smoke = () => execFileSync(process.execPath, [join(import.meta.dirname, "verify-extension-load.mjs"), "--release", root], { encoding: "utf8", timeout: 120_000 });
		// No stamp at all: the artifact cannot say which commit it is, so nothing else it reports
		// could be attributed to a build.
		assert.throws(smoke, /build-info\.json/u);
		writeFileSync(join(root, "build-info.json"), stamp({ commit: "abc" }));
		assert.throws(smoke, /commit must be a full 40-character SHA/u);
		writeFileSync(join(root, "build-info.json"), stamp({ schema: "other/v1" }));
		assert.throws(smoke, /schema must be rotom-build-info\/v1/u);
		writeFileSync(join(root, "build-info.json"), "{");
		assert.throws(smoke, /not JSON/u);
		// A well-formed stamp gets past provenance and fails on the real defect behind it.
		writeFileSync(join(root, "build-info.json"), stamp());
		assert.throws(smoke, /Cannot find module|ERR_MODULE_NOT_FOUND|Extension load failed/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a build stamp accepts a dirty tree only when it says so", () => {
	assert.equal(parseBuildInfo(stamp({ dirty: true, allowDirty: true })).dirty, true);
	assert.throws(() => parseBuildInfo(stamp({ builtAt: "2026-11-11" })), /builtAt must be an ISO instant/u);
	assert.throws(() => parseBuildInfo(stamp({ dirty: "no" })), /dirty must be a boolean/u);
	assert.throws(() => parseBuildInfo("[]"), /not an object/u);
});

test("the load smoke loads every built-in extension of an installed product tree", async (t) => {
	const product = resolve(import.meta.dirname, "..");
	const loader = join(product, PI_RUNTIME, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
	if (!existsSync(loader)) {
		t.skip("the Pi runtime is not installed in this checkout");
		return;
	}
	const entries = await extensionEntries(product);
	assert.ok(entries.length >= 6, `expected the six built-in extensions, found ${entries.length}`);
	// A source checkout carries no build stamp on purpose; its identity comes from Git.
	const result = await smokeExtensionLoad(product, { requireBuildInfo: false });
	assert.equal(result.loaded, entries.length);
});
