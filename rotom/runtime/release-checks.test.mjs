import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PI_RUNTIME } from "./resolve-installed-pi.mjs";
import { verifyExtensionLoad, verifyLocalImports } from "../scripts/pack-release.mjs";
import { extensionEntries } from "./verify-extension-load.mjs";

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

test("the load smoke loads every built-in extension of an installed product tree", async (t) => {
	const product = resolve(import.meta.dirname, "..");
	const loader = join(product, PI_RUNTIME, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
	if (!existsSync(loader)) {
		t.skip("the Pi runtime is not installed in this checkout");
		return;
	}
	const entries = await extensionEntries(product);
	assert.ok(entries.length >= 6, `expected the six built-in extensions, found ${entries.length}`);
	const result = await verifyExtensionLoad(product, { ...process.env, HOME: mkdtempSync(join(tmpdir(), "rotom-load-home-")) });
	assert.equal(result.loaded, entries.length);
});
