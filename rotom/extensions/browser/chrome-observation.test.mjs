import test from "node:test";
import assert from "node:assert/strict";
import { mintCoordinateObservation, validateCoordinateBinding, validateCoordinateHit, invalidateCoordinateObservation } from "./chrome-extension/coordinate-click.js";
import { consumeMatchingWindowOpenSignal } from "./chrome-extension/window-open-correlation.js";
import { formatScopedAxRef, parseScopedAxRef } from "./chrome-extension/scoped-ax-ref.js";
import { collectRenderedText, utf8TextChunks } from "./chrome-extension/rendered-text.js";
import { mergeRenderedText, scrollableTextTargets, fullReadCoverage, fullReadScrollStep } from "./chrome-extension/full-read.js";
test("坐标点击绑定 screenshot epoch、文档 generation、viewport 与非歧义 hit target", () => {
	const item = { documentGeneration: 4 };
	const metrics = { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 120, scale: 1 } };
	const minted = mintCoordinateObservation(item, metrics);
	assert.equal(minted.observationEpoch, 1);
	assert.deepEqual(validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, metrics), { x: 640, y: 400, viewport: { width: 1280, height: 800, pageX: 0, pageY: 120, scale: 1 } });
	assert.deepEqual(validateCoordinateHit({ backendNodeId: 91, nodeName: "CANVAS" }), { backendNodeId: 91, nodeName: "canvas" });
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 0, documentGeneration: 4, x: 640, y: 400 }, metrics), /epoch is stale/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 5, x: 640, y: 400 }, metrics), /generation is stale/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, { cssVisualViewport: { ...metrics.cssVisualViewport, pageY: 121 } }), /viewport changed/u);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 0, y: 400 }, metrics), /outside/u);
	assert.throws(() => validateCoordinateHit({ backendNodeId: 92, nodeName: "BODY" }), /ambiguous/u);
	invalidateCoordinateObservation(item);
	assert.throws(() => validateCoordinateBinding(item, { observationEpoch: 1, documentGeneration: 4, x: 640, y: 400 }, metrics), /current browser screenshot/u);
});
test("windowOpen signal 只关联 URL 匹配的新标签且单次消费", () => {
	const signals = [{ timestamp: 1000, url: "https://example.test/popup?x=1", used: false }];
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 1, url: "https://unrelated.test/" }, 1100, 2000), false);
	assert.equal(signals[0].used, false, "无关 session/用户标签不得消费 source-tab popup signal");
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 2, pendingUrl: "https://example.test/popup?x=1" }, 1200, 2000), true);
	assert.equal(signals[0].used, true);
	assert.equal(consumeMatchingWindowOpenSignal(signals, { id: 3, url: "https://example.test/popup?x=1" }, 1300, 2000), false, "signal 只能关联一个 created tab");
	assert.equal(consumeMatchingWindowOpenSignal([{ timestamp: 1000, url: "https://example.test/late", used: false }], { url: "https://example.test/late" }, 4000, 2000), false, "过期 signal 不得关联后续无关标签");
});
test("AX ref 保持根页面兼容并绑定 OOPIF scope", () => {
	assert.equal(formatScopedAxRef(3, "r", 42), "ax_3_42");
	assert.equal(formatScopedAxRef(3, "f2", 42), "ax_3_f2_42");
	assert.deepEqual(parseScopedAxRef("ax_3_42", 3), { ref: "ax_3_42", scopeId: "r", backendNodeId: 42 });
	assert.deepEqual(parseScopedAxRef("ax_3_f2_42", 3), { ref: "ax_3_f2_42", scopeId: "f2", backendNodeId: 42 });
	assert.equal(parseScopedAxRef("ax_2_f2_42", 3), undefined);
	assert.equal(parseScopedAxRef("ax_3_f0_42", 3), undefined);
});
test("固定正文提取覆盖同源 iframe，并以 UTF-8 安全分块", () => {
	const child = { document: { body: { innerText: "正文第二段" } }, frames: [] };
	const blocked = {};
	Object.defineProperty(blocked, "document", { get() { throw new Error("cross origin"); } });
	const rootWindow = { document: { body: { innerText: "Wiki 导航\n\n\n正文第一段" } }, frames: [child, blocked] };
	assert.equal(collectRenderedText(rootWindow), "Wiki 导航\n\n正文第一段\n\n正文第二段");
	const complete = utf8TextChunks("示例正文".repeat(30), 48, 20);
	assert.equal(complete.truncated, false);
	assert.equal(complete.chunks.join(""), "示例正文".repeat(30));
	assert.equal(complete.chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 48), true);
	const truncated = utf8TextChunks("正文".repeat(100), 12, 2);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.chunks.length, 2);
});
test("全文分段按相邻重叠合并且不会把容量完整误报成页面完整", () => {
	const first = mergeRenderedText("标题\n第一段\n第二段", "第二段\n第三段\n第四段", 10000);
	assert.equal(first.text, "标题\n第一段\n第二段\n第三段\n第四段");
	assert.equal(first.addedLines, 2);
	const duplicate = mergeRenderedText(first.text, "第一段\n第二段", 10000);
	assert.equal(duplicate.text, first.text);
	assert.equal(duplicate.addedLines, 0);
	assert.equal(mergeRenderedText("a", "b".repeat(20), 8).truncated, true);
});
test("全文读取沿采样点和同源 iframe 寻找滚动容器，不遍历页面全量 DOM", () => {
	const root = { clientHeight: 800, clientWidth: 1200, scrollHeight: 800, innerText: "root", parentElement: null, getBoundingClientRect: () => ({ width: 1200, height: 800, bottom: 800, right: 1200 }) };
	const content = { clientHeight: 700, clientWidth: 900, scrollHeight: 4200, innerText: "正文".repeat(500), parentElement: root, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 760, right: 1150 }) };
	const leaf = { clientHeight: 20, clientWidth: 200, scrollHeight: 20, innerText: "段落", parentElement: content, getBoundingClientRect: () => ({ width: 200, height: 20, bottom: 400, right: 800 }) };
	const fakeDocument = {
		scrollingElement: root,
		defaultView: { innerWidth: 1200, innerHeight: 800, getComputedStyle: (element) => ({ overflowY: element === content ? "auto" : "visible" }) },
		elementsFromPoint: () => [leaf],
		querySelectorAll() { throw new Error("full DOM traversal denied"); },
	};
	root.ownerDocument = fakeDocument;
	content.ownerDocument = fakeDocument;
	leaf.ownerDocument = fakeDocument;
	assert.equal(scrollableTextTargets(fakeDocument, 3)[0], content);
	const frameRoot = { clientHeight: 700, clientWidth: 900, scrollHeight: 700, innerText: "frame", parentElement: null, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 700, right: 900 }) };
	const frameContent = { clientHeight: 600, clientWidth: 800, scrollHeight: 5000, innerText: "第四章正文".repeat(800), parentElement: frameRoot, getBoundingClientRect: () => ({ width: 800, height: 600, bottom: 650, right: 850 }) };
	const frameLeaf = { clientHeight: 20, clientWidth: 200, scrollHeight: 20, innerText: "详细需求", parentElement: frameContent, getBoundingClientRect: () => ({ width: 200, height: 20, bottom: 300, right: 700 }) };
	const frameDocument = {
		scrollingElement: frameRoot,
		defaultView: { innerWidth: 900, innerHeight: 700, getComputedStyle: (element) => ({ overflowY: element === frameContent ? "auto" : "visible" }) },
		elementsFromPoint: () => [frameLeaf],
		querySelectorAll: () => [],
	};
	frameRoot.ownerDocument = frameDocument;
	frameContent.ownerDocument = frameDocument;
	frameLeaf.ownerDocument = frameDocument;
	const iframe = { tagName: "IFRAME", contentDocument: frameDocument, clientHeight: 700, clientWidth: 900, scrollHeight: 700, innerText: "", parentElement: root, ownerDocument: fakeDocument, getBoundingClientRect: () => ({ width: 900, height: 700, bottom: 700, right: 1100 }) };
	fakeDocument.elementsFromPoint = () => [iframe];
	fakeDocument.querySelectorAll = (selector) => selector === "iframe,frame" ? [iframe] : [];
	assert.equal(scrollableTextTargets(fakeDocument, 6)[0], frameContent, "同源 iframe 内的虚拟化正文容器必须优先于外层空壳");
});
test("short semantic scroller between sample points is found, and discovery caps stay partial", () => {
	const root = { clientHeight: 1200, clientWidth: 2000, scrollHeight: 1200, innerText: "root", parentElement: null, getBoundingClientRect: () => ({ width: 2000, height: 1200, bottom: 1200, right: 2000 }) };
	const list = { clientHeight: 160, clientWidth: 700, scrollHeight: 1920, innerText: "Fixture rows", parentElement: root, getBoundingClientRect: () => ({ width: 700, height: 160, bottom: 560, right: 730 }) };
	const document = { scrollingElement: root, defaultView: { innerWidth: 2000, innerHeight: 1200, getComputedStyle: (element) => ({ overflowY: element === list ? "auto" : "visible" }) }, elementsFromPoint: () => [root], querySelectorAll: (selector) => selector.includes('[role="list"]') ? [list] : [] };
	root.ownerDocument = document;
	list.ownerDocument = document;
	const targets = scrollableTextTargets(document, 3);
	assert.equal(targets[0], list);
	assert.equal(targets.truncated, false);
	assert.equal(scrollableTextTargets(document, 1).truncated, true, "omitted candidates cannot become complete");
	document.querySelectorAll = (selector) => selector.includes('[role="list"]') ? Array(65).fill(list) : [];
	assert.equal(scrollableTextTargets(document, 3).truncated, true, "semantic discovery is bounded and reports its limit");
});
test("full-read completion requires actual scrolling and all bounded sources; short viewports overlap", () => {
	const still = { scanSteps: 3, scannedContainers: 1, scrolledContainers: 0, endReached: true };
	assert.equal(fullReadCoverage([still], false, 60, true).contentComplete, false);
	assert.equal(fullReadCoverage([still], false, 60, true).contentCoverage, "rendered-dom");
	const moved = { ...still, scrolledContainers: 1 };
	assert.equal(fullReadCoverage([moved], false, 60, true).contentComplete, true);
	// Spending the whole step budget is not itself incomplete: a read that reached the end
	// at the ceiling is complete, otherwise a finished document reports as unfinished.
	assert.equal(fullReadCoverage([{ ...moved, scanSteps: 60 }], false, 60, true).contentComplete, true);
	for (const [sources, truncated, maxSteps, framesComplete] of [[[moved], true, 60, true], [[moved], false, 60, false], [[moved, { ...still, endReached: false }], false, 60, true]])
		assert.equal(fullReadCoverage(sources, truncated, maxSteps, framesComplete).contentComplete, false);
	for (const height of [120, 160, 700])
		assert.ok(fullReadScrollStep(height) > 0 && fullReadScrollStep(height) < height);
});
