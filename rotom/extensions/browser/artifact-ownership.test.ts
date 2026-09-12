import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import test from "node:test";
import { BrowserArtifactStoreV1 } from "./browser-relay.ts";

const screenshot = { schemaVersion: 1, kind: "rotom-browser-screenshot", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), tabName: "docs", tabId: 1, documentGeneration: 1, observationEpoch: 1, viewport: { width: 800, height: 600, pageX: 0, pageY: 0, scale: 1 } };
test("close drains already-admitted screenshot I/O and never publishes an artifact after retirement", { timeout: 5000 }, async (t) => {
	const store = await BrowserArtifactStoreV1.open();
	t.after(() => rm(store.rootDir, { recursive: true, force: true }));
	// storeScreenshot synchronously reaches fs.open's first await before close.
	const pending = store.storeScreenshot(screenshot);
	const closing = store.close();
	const repeated = store.close();
	const [writeResult, closeResult] = await Promise.allSettled([pending, closing, repeated]);
	assert.equal(writeResult.status, "rejected", "no late artifact publication");
	assert.equal(closeResult.status, "fulfilled", "cleanup drains admitted writes");
	assert.equal(repeated, closing, "all callers wait for the same cleanup");
	await assert.rejects(access(store.rootDir), { code: "ENOENT" });
});
