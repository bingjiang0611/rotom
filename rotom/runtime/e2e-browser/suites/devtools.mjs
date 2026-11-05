// devtools (T23): page code in a bounded world, and device emulation that voids
// every earlier measurement.
//
// The isolated world must not see the page's own globals; the main world must. That pair
// is the check that proves the boundary instead of trusting the implementation.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "devtools：isolated 与 main world 的可见性差异、viewport 预设与 reset、坐标失效";

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
			{ devtools: "trace_start" },
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
