import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEVTOOLS_EVALUATE_TIMEOUT_MS_V1,
	DEVTOOLS_OPERATIONS_V1,
	DEVTOOLS_VIEWPORT_PRESETS_V1,
	MAX_DEVTOOLS_EXPRESSION_CHARS_V1,
	MAX_DEVTOOLS_RESULT_BYTES_V1,
	MAX_EXPORT_HEIGHT_V1,
	MAX_EXPORT_WIDTH_V1,
	DEFAULT_EXPORT_QUALITY_V1,
	sanitizeExportQualityV1,
	boundDevtoolsTextV1,
	devtoolsCodeDigestV1,
	devtoolsEnabledByEnvironment,
	resolveViewportV1,
	sanitizeDevtoolsExpressionV1,
	sanitizeDevtoolsOperationV1,
	sanitizeDevtoolsWorldV1,
	viewportDescriptionV1,
} from "./devtools.ts";

test("ROTOM_BROWSER_DEVTOOLS=0 disables the tool and empty/unset keeps it on", () => {
	assert.equal(devtoolsEnabledByEnvironment({}), true);
	assert.equal(devtoolsEnabledByEnvironment({ ROTOM_BROWSER_DEVTOOLS: "" }), true);
	assert.equal(devtoolsEnabledByEnvironment({ ROTOM_BROWSER_DEVTOOLS: "1" }), true);
	for (const off of ["0", "false", "no", " NO "]) {
		assert.equal(devtoolsEnabledByEnvironment({ ROTOM_BROWSER_DEVTOOLS: off }), false, off);
	}
});

test("only implemented operations are accepted", () => {
	assert.deepEqual([...DEVTOOLS_OPERATIONS_V1], ["evaluate", "viewport", "screenshot_export"]);
	assert.equal(sanitizeDevtoolsOperationV1("evaluate"), "evaluate");
	assert.equal(sanitizeDevtoolsOperationV1("screenshot_export"), "screenshot_export");
	assert.equal(sanitizeDevtoolsOperationV1("record_start"), undefined);
	assert.equal(sanitizeDevtoolsOperationV1("trace_start"), undefined);
	assert.equal(sanitizeDevtoolsOperationV1("Evaluate"), undefined);
	assert.equal(sanitizeDevtoolsOperationV1(undefined), undefined);
});

test("evaluate runs in the isolated world unless main is asked for explicitly", () => {
	assert.equal(sanitizeDevtoolsWorldV1(undefined), "isolated");
	assert.equal(sanitizeDevtoolsWorldV1("isolated"), "isolated");
	assert.equal(sanitizeDevtoolsWorldV1("main"), "main");
	assert.equal(sanitizeDevtoolsWorldV1(" MAIN "), undefined);
	assert.equal(sanitizeDevtoolsWorldV1("page"), undefined);
});

test("expressions are bounded and NUL-free", () => {
	assert.equal(sanitizeDevtoolsExpressionV1("  1 + 1  "), "1 + 1");
	assert.equal(sanitizeDevtoolsExpressionV1("   "), undefined);
	assert.equal(sanitizeDevtoolsExpressionV1(7), undefined);
	assert.equal(sanitizeDevtoolsExpressionV1("a\0b"), undefined);
	assert.equal(sanitizeDevtoolsExpressionV1("x".repeat(MAX_DEVTOOLS_EXPRESSION_CHARS_V1)), "x".repeat(MAX_DEVTOOLS_EXPRESSION_CHARS_V1));
	assert.equal(sanitizeDevtoolsExpressionV1("x".repeat(MAX_DEVTOOLS_EXPRESSION_CHARS_V1 + 1)), undefined);
});

test("viewport presets resolve to a copy and unknown names are rejected", () => {
	const preset = resolveViewportV1("iphone-15");
	assert.deepEqual(preset, { ...DEVTOOLS_VIEWPORT_PRESETS_V1["iphone-15"] });
	assert.notEqual(preset, DEVTOOLS_VIEWPORT_PRESETS_V1["iphone-15"], "调用方拿到副本，不会改到预设表");
	assert.equal(resolveViewportV1("reset"), "reset");
	assert.equal(resolveViewportV1("iphone-99"), undefined);
	assert.deepEqual(viewportDescriptionV1(preset), "393x852@3");
	assert.deepEqual(viewportDescriptionV1("reset"), "reset");
});

test("explicit viewport overrides are bounded instead of clamped", () => {
	assert.deepEqual(resolveViewportV1({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false, touch: false }), { width: 800, height: 600, deviceScaleFactor: 1, mobile: false, touch: false });
	for (const bad of [
		{ width: 100, height: 600, deviceScaleFactor: 1, mobile: false, touch: false },
		{ width: 800, height: 9_000, deviceScaleFactor: 1, mobile: false, touch: false },
		{ width: 800.5, height: 600, deviceScaleFactor: 1, mobile: false, touch: false },
		{ width: 800, height: 600, deviceScaleFactor: 0, mobile: false, touch: false },
		{ width: 800, height: 600, deviceScaleFactor: 9, mobile: false, touch: false },
		{ width: 800, height: 600, deviceScaleFactor: 1, mobile: "no", touch: false },
		{ width: 800, height: 600, deviceScaleFactor: 1, touch: false },
		{ width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
		[],
		null,
	]) assert.equal(resolveViewportV1(bad), undefined, JSON.stringify(bad));
});

test("text bounding keeps whole characters and reports truncation", () => {
	const ascii = boundDevtoolsTextV1("abc");
	assert.deepEqual(ascii, { text: "abc", truncated: false, bytes: 3 });
	const bounded = boundDevtoolsTextV1("汉".repeat(10), 10);
	assert.equal(bounded.truncated, true);
	assert.equal(bounded.text, "汉汉汉", "3 字节一个字符，10 字节只放得下 3 个");
	assert.equal(bounded.bytes, 9);
	assert.equal(bounded.text.includes("\uFFFD"), false);
	assert.equal(MAX_DEVTOOLS_RESULT_BYTES_V1, 64 * 1024);
});

test("audit stores a stable digest of the code", () => {
	const digest = devtoolsCodeDigestV1("document.title");
	assert.match(digest, /^[0-9a-f]{64}$/u);
	assert.equal(digest, devtoolsCodeDigestV1("document.title"));
	assert.notEqual(digest, devtoolsCodeDigestV1("document.title+''"));
	assert.equal(digest.includes("document"), false, "摘要不含源码");
	assert.equal(DEVTOOLS_EVALUATE_TIMEOUT_MS_V1, 10_000);
});

test("导出质量有默认值，范围外拒绝而不是钳制", () => {
	assert.equal(MAX_EXPORT_WIDTH_V1, 5_000);
	assert.equal(MAX_EXPORT_HEIGHT_V1, 20_000);
	assert.equal(sanitizeExportQualityV1(undefined), DEFAULT_EXPORT_QUALITY_V1);
	assert.equal(sanitizeExportQualityV1(1), 1);
	assert.equal(sanitizeExportQualityV1(100), 100);
	for (const bad of [0, 101, 1.5, "80", null]) assert.equal(sanitizeExportQualityV1(bad), undefined, String(bad));
});
