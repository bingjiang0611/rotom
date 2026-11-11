import assert from "node:assert/strict";
import test from "node:test";
import { runtimeVersionAttributes } from "./model-metadata.ts";

test("runtime build metadata preserves clean, dirty and unknown without version inference", () => {
	const commit = "a".repeat(40);
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_BUILD_COMMIT: commit, ROTOM_BUILD_DIRTY: "1" }), { "rotom.build.commit": commit, "rotom.build.dirty": true });
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_BUILD_COMMIT: commit, ROTOM_BUILD_DIRTY: "0" }), { "rotom.build.commit": commit, "rotom.build.dirty": false });
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_BUILD_COMMIT: commit }), { "rotom.build.commit": commit });
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_BUILD_COMMIT: "short", ROTOM_BUILD_DIRTY: "0" }), {});
	assert.deepEqual(runtimeVersionAttributes({ ROTOM_BUILD_DIRTY: "0" }), {});
});
