// devtools (T23): page code in a bounded world, and device emulation that voids
// every earlier measurement.
//
// The isolated world must not see the page's own globals; the main world must. That pair
// is the check that proves the boundary instead of trusting the implementation.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "devtools：isolated 与 main world 的可见性差异、viewport 覆盖与 reset、坐标失效、截图导出、响应体读取、性能 trace";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("devtools-main");
	const request = relayRequestFor(client, "devtools");
	const openGlobals = async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "code", url: fixtures.url("/globals") }, 10_000);
		await request("wait", { tabName: "code", status: "complete", timeoutMs: 10_000 }, 11_000);
	};
	const evaluate = (payload) => request("devtools", { tabName: "code", devtools: "evaluate", ...payload }, 15_000);

	await recorder.check("isolated world 读不到页面全局变量，main world 读得到", async () => {
		await openGlobals();
		const isolated = await evaluate({ expression: "String(typeof window.rotomPageSecret)" });
		assert.equal(isolated.kind, "rotom-browser-devtools");
		assert.equal(isolated.devtools, "evaluate");
		assert.equal(isolated.world, "isolated");
		assert.equal(isolated.threw, false);
		assert.equal(isolated.valueText, JSON.stringify("undefined"), `isolated world 不应看到页面全局：${isolated.valueText}`);

		const main = await evaluate({ expression: "String(window.rotomPageSecret)", world: "main" });
		assert.equal(main.world, "main");
		assert.equal(main.valueText, JSON.stringify("page-secret"), "main world 必须能读到页面全局");
	});

	await recorder.check("evaluate 支持 DOM 读取、awaitPromise 与返回值序列化", async () => {
		const text = await evaluate({ expression: "document.getElementById('echo').textContent" });
		assert.equal(text.valueText, JSON.stringify("ready"));
		// The isolated world shares the DOM, so a DOM read is legitimate there.
		const awaited = await evaluate({ expression: "Promise.resolve(1 + 1)" });
		assert.equal(awaited.valueText, "2");
		const noAwait = await evaluate({ expression: "Promise.resolve(7)", awaitPromise: false });
		assert.equal(noAwait.type, "object", "awaitPromise:false 必须回传 Promise 对象类型，而不是悄悄 await");
	});

	await recorder.check("抛错的表达式作为数据返回，不是 relay 失败", async () => {
		const threw = await evaluate({ expression: "throw new Error('boom-marker')" });
		assert.equal(threw.threw, true);
		assert.match(threw.valueText, /boom-marker/u);
	});

	await recorder.check("大结果被截断并标记 truncated", async () => {
		const large = await evaluate({ expression: "'abcdefghij'.repeat(20000)" });
		assert.equal(large.truncated, true);
		assert.ok(large.bytes <= 64 * 1024, `bytes=${large.bytes}`);
		assert.equal(large.valueText.includes("abcdefghij"), true);
	});

	await recorder.check("非法参数在 relay 侧被拒绝，不产生 CDP 调用", async () => {
		for (const payload of [
			{ devtools: "evaluate", expression: "   " },
			{ devtools: "evaluate", expression: "1", world: "page" },
			{ devtools: "record_start" },
			{ devtools: "viewport", viewport: "iphone-99" },
			{ devtools: "viewport", viewport: { width: 10, height: 600, deviceScaleFactor: 1, mobile: false, touch: false } },
			{ devtools: "viewport", viewport: { width: 800, height: 600, deviceScaleFactor: 1, mobile: "no", touch: false } },
		]) {
			await assert.rejects(() => request("devtools", { tabName: "code", ...payload }), /devtools/u, JSON.stringify(payload));
		}
	});

	await recorder.check("viewport 预设生效，reset 恢复，且让旧坐标失效", async () => {
		const step = async (label, promise) => { try { return await promise; } catch (error) { throw new Error(`[${label}] ${error.message}`); } };
		await step("open", openGlobals());
		const before = await step("screenshot", request("screenshot", { tabName: "code" }, 10_000));
		// A non-mobile override maps 1:1 onto the layout viewport, so it proves the command
		// reached the page. A mobile override without a meta viewport keeps Chrome's
		// 980px layout viewport, so that preset is asserted through touch support instead.
		const applied = await step("desktop", request("devtools", { tabName: "code", devtools: "viewport", viewport: { width: 900, height: 700, deviceScaleFactor: 1, mobile: false, touch: false } }, 10_000));
		assert.equal(applied.devtools, "viewport");
		assert.equal(applied.reset, false);
		assert.deepEqual(applied.viewport, { width: 900, height: 700, deviceScaleFactor: 1, mobile: false, touch: false });
		assert.ok(applied.observationEpoch > before.observationEpoch, "换 viewport 必须让旧 observation 失效");
		const measured = await step("innerWidth", evaluate({ expression: "window.innerWidth" }));
		assert.equal(measured.valueText, "900", `覆盖后 innerWidth 应为 900，实际 ${measured.valueText}`);

		const iphone = await step("iphone", request("devtools", { tabName: "code", devtools: "viewport", viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true } }, 10_000));
		assert.deepEqual(iphone.viewport, { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true });
		const mobile = await step("touch", evaluate({ expression: "navigator.maxTouchPoints > 0" }));
		assert.equal(mobile.valueText, "true", "touch 预设必须真的开启触摸");

		const reset = await step("reset", request("devtools", { tabName: "code", devtools: "viewport", viewport: "reset" }, 10_000));
		assert.equal(reset.reset, true);
		assert.equal(reset.viewport, null);
		// Restoring the metrics relayouts the page; the screenshot refuses to measure while
		// the viewport is still moving, so retry until it settles.
		const settled = async (label, run) => {
			for (let attempt = 0; attempt < 10; attempt += 1) {
				try { return await run(); } catch (error) { if (attempt === 9) throw new Error(`[${label}] ${error.message}`); await new Promise((resolve) => setTimeout(resolve, 100)); }
			}
			return undefined;
		};
		const restoredShot = await settled("restored", () => request("screenshot", { tabName: "code" }, 10_000));
		assert.equal(restoredShot.viewport.width, before.viewport.width, `reset 之后视口宽度必须回到 ${before.viewport.width}，实际 ${restoredShot.viewport.width}`);
		const touches = await step("touches", evaluate({ expression: "navigator.maxTouchPoints > 0" }));
		assert.equal(touches.valueText, "false", "reset 也要关掉触摸模拟");
	});

	await recorder.check("screenshot_export：视口 PNG 与整页 JPEG 都是真实图片且字节数自洽", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "shot", url: fixtures.url("/globals") }, 10_000);
		await request("wait", { tabName: "shot", status: "complete", timeoutMs: 10_000 }, 11_000);
		const viewportShot = await request("devtools", { tabName: "shot", devtools: "screenshot_export", format: "png" }, 20_000);
		assert.equal(viewportShot.kind, "rotom-browser-devtools");
		assert.equal(viewportShot.devtools, "screenshot_export");
		assert.equal(viewportShot.format, "png");
		assert.equal(viewportShot.fullPage, false);
		const viewportBytes = Buffer.from(viewportShot.data, "base64");
		assert.equal(viewportBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG magic 必须是真实 PNG");
		assert.equal(viewportShot.bytes, viewportBytes.length);
		assert.equal(viewportShot.width, undefined, "视口截图不带 clip 尺寸");

		const fullPage = await request("devtools", { tabName: "shot", devtools: "screenshot_export", format: "jpeg", fullPage: true, quality: 70 }, 20_000);
		const fullBytes = Buffer.from(fullPage.data, "base64");
		assert.equal(fullBytes.subarray(0, 2).toString("hex"), "ffd8", "JPEG magic 必须是真实 JPEG");
		assert.equal(fullPage.fullPage, true);
		assert.ok(fullPage.height > 0 && fullPage.width > 0, "整页截图必须回报 clip 尺寸");

		await assert.rejects(() => request("devtools", { tabName: "shot", devtools: "screenshot_export", format: "webp" }, 10_000), /devtools/u);
		await assert.rejects(() => request("devtools", { tabName: "shot", devtools: "screenshot_export", format: "png", quality: 101 }, 10_000), /devtools/u);

		// A page taller than the cap is refused instead of producing a giant image.
		await request("open", { tabName: "huge", url: fixtures.url("/large") }, 10_000);
		await request("wait", { tabName: "huge", status: "complete", timeoutMs: 10_000 }, 11_000);
		await assert.rejects(() => request("devtools", { tabName: "huge", devtools: "screenshot_export", format: "png", fullPage: true }, 20_000), /too large/u);
	});

	await recorder.check("network_body：启用前取不到、启用后能取到 JSON 并截断到 64 KiB、二进制被拒", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "api", url: fixtures.url("/json-page") }, 10_000);
		await request("wait", { tabName: "api", status: "complete", timeoutMs: 10_000 }, 11_000);
		// Enabled here for the first time: earlier requests must not be readable.
		await assert.rejects(() => request("devtools", { tabName: "api", devtools: "network_body", requestId: "not-enabled-yet" }, 10_000), /network body unavailable/u);

		const lengths = await request("devtools", { tabName: "api", devtools: "evaluate", expression: "window.fetchJsonOnce()", world: "main" }, 15_000);
		assert.ok(Number(lengths.valueText) > 64 * 1024, `fixture JSON 必须真的超过 64 KiB，实际 ${lengths.valueText}`);

		let requestId;
		for (let attempt = 0; attempt < 40 && requestId === undefined; attempt += 1) {
			const page = await request("network", { tabName: "api", limit: 200 }, 10_000);
			requestId = page.entries.find((entry) => entry.url.includes("/json") && entry.status === 200)?.requestId;
			if (requestId === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(requestId, "network 必须给出 /json 的 requestId");

		const body = await request("devtools", { tabName: "api", devtools: "network_body", requestId }, 15_000);
		assert.equal(body.devtools, "network_body");
		assert.equal(body.requestId, requestId);
		assert.equal(body.status, 200);
		assert.match(body.mimeType, /application\/json/u);
		assert.equal(body.truncated, true, "70 KB 的正文必须被截断");
		assert.ok(body.bytes <= 64 * 1024, `bytes=${body.bytes}`);
		assert.match(body.bodyText, /rotom-json-fixture/u);
		assert.match(body.note, /after network_body was first enabled/u);

		// Binary payloads are not text: refuse instead of pretending they are。
		const binary = await request("devtools", { tabName: "api", devtools: "evaluate", expression: "fetch('/binary', {cache:'no-store'}).then(r => r.arrayBuffer()).then(b => b.byteLength)", world: "main" }, 15_000);
		assert.equal(binary.valueText, "4");
		let binaryId;
		for (let attempt = 0; attempt < 40 && binaryId === undefined; attempt += 1) {
			const page = await request("network", { tabName: "api", limit: 200 }, 10_000);
			binaryId = page.entries.find((entry) => entry.url.includes("/binary") && entry.status === 200)?.requestId;
			if (binaryId === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(binaryId, "network 必须给出 /binary 的 requestId");
		await assert.rejects(() => request("devtools", { tabName: "api", devtools: "network_body", requestId: binaryId }, 10_000), /not text/u);
	});

	await recorder.check("trace_start/trace_stop：全局只能一个 trace，停止后取到真实事件流且能算出 long task", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "perf", url: fixtures.url("/globals") }, 10_000);
		await request("wait", { tabName: "perf", status: "complete", timeoutMs: 10_000 }, 11_000);
		const started = await request("devtools", { tabName: "perf", devtools: "trace_start" }, 15_000);
		assert.equal(started.devtools, "trace_start");
		assert.ok(Date.parse(started.startedAt) > 0);
		assert.ok(started.categories.includes("devtools.timeline"));
		// 全局只允许一个 trace，第二次必须被拒绝而不是混在一起。
		await assert.rejects(() => request("devtools", { tabName: "perf", devtools: "trace_start" }, 10_000), /already running/u);

		// 制造一段可观测的主线程工作，让 trace 里有真实事件。
		await request("devtools", { tabName: "perf", devtools: "evaluate", expression: "const t=Date.now(); while (Date.now()-t < 120) {} 'busy'", world: "main" }, 15_000);
		const stopped = await request("devtools", { tabName: "perf", devtools: "trace_stop" }, 40_000);
		assert.equal(stopped.devtools, "trace_stop");
		assert.ok(stopped.bytes > 1_000, `trace 应该包含真实事件，bytes=${stopped.bytes}`);
		const parsed = JSON.parse(Buffer.from(stopped.traceBase64, "base64").toString("utf8"));
		assert.ok(Array.isArray(parsed.traceEvents) && parsed.traceEvents.length > 10, "trace 必须是可解析的事件流");
		assert.ok(parsed.traceEvents.some((event) => event.name === "RunTask"), "trace 里必须有主线程任务");
		// 停止之后可以再次开始，说明状态真的清了。
		const again = await request("devtools", { tabName: "perf", devtools: "trace_start" }, 15_000);
		assert.equal(again.devtools, "trace_start");
		await request("devtools", { tabName: "perf", devtools: "trace_stop" }, 40_000);
	});

	await recorder.check("viewport 后被取消的旧坐标 observation 不能被复用", async () => {
		await openGlobals();
		const shot = await request("screenshot", { tabName: "code" }, 10_000);
		assert.ok(Number.isInteger(shot.observationEpoch));
		await request("devtools", { tabName: "code", devtools: "viewport", viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true } }, 10_000);
		await assert.rejects(
			() => request("interact", { tabName: "code", action: "click", x: 20, y: 20, observationEpoch: shot.observationEpoch, documentGeneration: shot.documentGeneration }, 10_000),
			/observation|coordinate|epoch|stale/iu,
			"旧 epoch 的坐标点击必须被拒绝",
		);
	});
}
