// pointer (T16): hover, double click, right click, and both drag flavours.
//
// The fixture mirrors every effect into one status line, so a step passes only when the
// page itself changed — a dispatched mouse event that nobody handled fails the check.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "pointer：hover 出菜单、dblclick 计数、右键菜单、两种拖拽换序";

const linux = process.platform === "linux";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("pointer-main");
	const request = relayRequestFor(client, "pointer");
	const act = async (payload) => request("interact", { tabName: "pointer", actionId: `pointer-${Math.random().toString(16).slice(2)}`, ...payload }, 20_000);
	const snapshot = () => request("snapshot", { tabName: "pointer" }, 20_000);
	const pageText = async () => {
		const observation = await snapshot();
		return observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
	};
	const state = async () => {
		const text = await pageText();
		const match = /\|dbl=(\d+)\|ctx=(\d+)\|start=(\d+)\|drop=(\d+)\|pointer=([123]{3})\|native=([123]{3})/u.exec(text);
		assert.ok(match, `页面必须自证指针状态：${JSON.stringify(text.slice(0, 240))}`);
		return { dbl: Number(match[1]), ctx: Number(match[2]), starts: Number(match[3]), drops: Number(match[4]), pointer: match[5], native: match[6] };
	};
	// Known limit (usage / CLAUDE.md §6): a Linux background tab is not guaranteed to composite
	// frames, and every held-mouse `mouseMoved` waits for a frame acknowledgement, so a drag can
	// run into the dispatch deadline. A timeout may only surface as the honest `unknown`, and the
	// tab has to stay usable afterwards; success stays on the strict path below.
	const drag = async (payload) => {
		try {
			return { result: await act(payload) };
		} catch (error) {
			const message = String(error?.message ?? error);
			assert.equal(linux, true, `拖拽不该在 ${process.platform} 上失败：${message}`);
			// Two honest shapes: the dispatch race gave up (`dispatch timeout … 结果 unknown`)
			// or the whole `interact` hit its deadline first (`browser relay interact operation
			// timeout`). Both are unknown, never success; anything else is a real failure.
			const dispatchTimeout = /dispatch timeout[\s\S]*unknown/u.test(message);
			const operationTimeout = /browser relay interact operation timeout/u.test(message);
			assert.equal(dispatchTimeout || operationTimeout, true, `Linux 上的失败必须是如实报出的超时（dispatch 或操作 deadline）：${message}`);
			const after = await snapshot();
			assert.ok(after.nodes.length > 0, "拖拽超时后 tab 仍可读，说明锁已释放");
			return { unknown: true };
		}
	};
	const refByName = async (role, name) => {
		const observation = await snapshot();
		const node = observation.nodes.find((candidate) => candidate.role === role && candidate.name === name);
		assert.ok(node, `${role} ${name} 必须在快照里；现有节点：${JSON.stringify(observation.nodes.slice(0, 24).map((candidate) => [candidate.role, candidate.name]))}`);
		return node.ref;
	};

	await request("close", { all: true }, 5_000);
	await request("open", { tabName: "pointer", url: fixtures.url("/pointer") }, 10_000);
	await request("wait", { tabName: "pointer", status: "complete", timeoutMs: 10_000 }, 11_000);

	await recorder.check("hover 让菜单出现，读回能看到菜单项", async () => {
		const before = await snapshot();
		assert.equal(before.nodes.some((node) => node.name === "Alpha item"), false, "菜单初始不可见");
		const zone = await refByName("generic", "hover zone");
		const result = await act({ action: "hover", targetRef: zone });
		assert.equal(result.effect.dispatch, "mouse");
		assert.equal(result.effect.action, "hover");
		const after = await snapshot();
		assert.deepEqual(after.nodes.filter((node) => node.role === "menuitem").map((node) => node.name), ["Alpha item", "Beta item"]);
		assert.match(await pageText(), /hover-open/u);
	});

	await recorder.check("dblclick 触发页面的 dblclick 事件", async () => {
		const pad = await refByName("generic", "double click pad");
		await act({ action: "dblclick", targetRef: pad });
		assert.equal((await state()).dbl, 1);
	});

	await recorder.check("right_click 触发 contextmenu 并显示菜单", async () => {
		const pad = await refByName("generic", "context pad");
		await act({ action: "right_click", targetRef: pad });
		const next = await state();
		assert.equal(next.ctx, 1);
		const observation = await snapshot();
		assert.equal(observation.nodes.some((node) => node.name === "Context delete"), true, "右键菜单必须真的出现");
	});

	await recorder.check("指针拖拽把第 1 项移到第 3 项", async () => {
		const first = await refByName("option", "Pointer one");
		const third = await refByName("option", "Pointer three");
		const { result, unknown } = await drag({ action: "drag", targetRef: first, dropRef: third });
		if (unknown) return;
		assert.equal(result.effect.action, "drag");
		assert.equal(result.effect.html5, false, "指针拖拽不应走 CDP 拖拽事件");
		assert.equal(result.effect.dragDataSource, "none");
		assert.ok(result.effect.moves >= 5, `至少 5 次中间移动：${result.effect.moves}`);
		assert.equal((await state()).pointer, "231");
	});

	await recorder.check("HTML5 拖拽把第 1 项移到第 3 项", async () => {
		const first = await refByName("option", "Native one");
		const third = await refByName("option", "Native three");
		const { result, unknown } = await drag({ action: "drag", targetRef: first, dropRef: third });
		if (unknown) return;
		assert.equal(result.effect.action, "drag");
		assert.equal(result.effect.html5, true, `原生拖拽必须走 CDP 拖拽事件：${JSON.stringify(result.effect)} state=${JSON.stringify(await state())}`);
		assert.ok(["intercepted", "synthesized-from-text"].includes(result.effect.dragDataSource), `拖拽数据来源必须可解释：${JSON.stringify(result.effect)}`);
		assert.equal(result.effect.dragstartFired, result.effect.dragDataSource === "intercepted", "dragstart 只在真实拦截时触发");
		const next = await state();
		assert.equal(next.native, "231", `HTML5 拖拽必须真正换序：${JSON.stringify(next)} effect=${JSON.stringify(result.effect)}`);
		assert.equal(next.starts, result.effect.dragstartFired ? 1 : 0, "页面看到的 dragstart 次数必须与上报一致");
	});

	await recorder.check("非法指针参数在本地被拒绝", async () => {
		const pad = await refByName("generic", "double click pad");
		await assert.rejects(act({ action: "drag", targetRef: pad }), /dropRef/u);
		await assert.rejects(act({ action: "drag", targetRef: pad, dropRef: pad, x: 5, y: 5, observationEpoch: 1 }), /坐标|dropRef|drag/u);
		await assert.rejects(act({ action: "click", targetRef: pad, dropRef: pad }), /dropRef/u);
		await assert.rejects(act({ action: "hover", targetRef: pad, text: "x" }), /参数|invalid/u);
	});
}
