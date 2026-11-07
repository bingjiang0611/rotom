import assert from "node:assert/strict";
import test from "node:test";
import { captureScreenshotWithin } from "./chrome-extension/screenshot-capture.js";
import { createSessionLockV1, createTabLocksV1 } from "./chrome-extension/request-locks.js";

const never = () => new Promise(() => undefined);
const viewport = (width, height) => ({ cssVisualViewport: { clientWidth: width, clientHeight: height, pageX: 0, pageY: 0, scale: 1 } });

/** A fake CDP target: every command answers except the ones named in `hang`. */
const target = (hang) => {
	const sent = [];
	const sendCommand = (method) => {
		sent.push(method);
		if (hang.includes(method)) return never();
		if (method === "Page.getLayoutMetrics") return Promise.resolve(viewport(800, 600));
		if (method === "Page.captureScreenshot") return Promise.resolve({ data: "aGVsbG8=" });
		return Promise.resolve({});
	};
	return { sent, sendCommand };
};

test("screenshot：capture 永不 resolve 时按 deadline 报 timeout，不会拿半张图当成功", async () => {
	const fake = target(["Page.captureScreenshot"]);
	const startedAt = Date.now();
	await assert.rejects(
		captureScreenshotWithin({ sendCommand: fake.sendCommand, metricsWaitMs: 40, captureWaitMs: 60 }),
		/Page\.captureScreenshot timeout/u,
	);
	assert.ok(Date.now() - startedAt < 1_000, `必须在 deadline 内返回：${Date.now() - startedAt} ms`);
	// Focus emulation is switched on for the capture and switched off again afterwards.
	assert.deepEqual(fake.sent, ["Emulation.setFocusEmulationEnabled", "Page.getLayoutMetrics", "Page.captureScreenshot", "Emulation.setFocusEmulationEnabled"]);
});

test("screenshot：metrics 挂住同样在 deadline 内报 timeout", async () => {
	await assert.rejects(
		captureScreenshotWithin({ sendCommand: target(["Page.getLayoutMetrics"]).sendCommand, metricsWaitMs: 40, captureWaitMs: 60 }),
		/Page\.getLayoutMetrics timeout|Emulation\.setFocusEmulationEnabled timeout/u,
	);
});

test("screenshot：超时后同 session 的 tabs/close 不被挂住的命令挡住", async () => {
	const lock = createSessionLockV1();
	const tabLocks = createTabLocksV1();
	// Screenshot is tab scoped: session read lock, then the tab's own lock (what the worker does).
	const screenshot = lock.read(() => tabLocks.run("frozen", () => captureScreenshotWithin({ sendCommand: target(["Page.captureScreenshot"]).sendCommand, metricsWaitMs: 20, captureWaitMs: 30 })));
	await assert.rejects(screenshot, /timeout/u);
	// A structural operation (tabs/close/hello) takes the session lock exclusively and must
	// still be granted: a pending capture would have blocked it forever.
	const structural = await Promise.race([
		lock.write(async () => "tabs/close ran"),
		new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
	]);
	assert.equal(structural, "tabs/close ran");
	// The tab lock is free again, so the next operation on the same tab runs instead of
	// overlapping the timed-out capture.
	assert.equal(await tabLocks.run("frozen", async () => "next op"), "next op");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(tabLocks.size(), 0);
	assert.deepEqual(lock.counts(), { readers: 0, writing: false, waiting: 0 });
});

test("screenshot：正常路径返回同一对 metrics 与 capture", async () => {
	const result = await captureScreenshotWithin({ sendCommand: target([]).sendCommand, metricsWaitMs: 40, captureWaitMs: 60 });
	assert.equal(result.captured.data, "aGVsbG8=");
	assert.equal(result.metricsAfter.cssVisualViewport.clientWidth, 800);
});
