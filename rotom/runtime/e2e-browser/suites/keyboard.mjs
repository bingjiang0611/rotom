// keyboard (T15): the whitelist, modifiers, and a page that reports its own state.
//
// The fixture textarea mirrors its length and the listbox mirrors its selected option into
// a status node, so every step is judged by the page, not by the dispatch acknowledgement.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

export const description = "keyboard：白名单按键与修饰键，由页面自身状态证明生效";

// Meta on macOS, Control elsewhere; both must select all in a textarea.
const CHORD = process.platform === "darwin" ? "Meta" : "Control";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("keys-main");
	const request = relayRequestFor(client, "keys");
	const interact = async (payload) => request("interact", { tabName: "keys", actionId: `keys-${Math.random().toString(16).slice(2)}`, ...payload }, 15_000);
	const snapshot = async () => {
		const observation = await request("snapshot", { tabName: "keys" }, 15_000);
		return observation;
	};
	const refFor = (observation, role, name) => {
		const node = observation.nodes.find((candidate) => candidate.role === role && (!name || candidate.name === name));
		assert.ok(node, `${role} ${name ?? ""} 必须出现在快照里`);
		return node.ref;
	};
	// The status line is page text: the fixture mirrors its real state into it, so the
	// assertion reads what the page reports rather than the dispatch acknowledgement.
	const pageText = async () => {
		const observation = await snapshot();
		return observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
	};
	const textareaState = async () => {
		const text = await pageText();
		const match = /textarea\|(\d+)\|(.*)$/u.exec(text);
		assert.ok(match, `页面必须自证 textarea 状态：${JSON.stringify(text.slice(0, 200))}`);
		return { value: match[2].trim(), length: Number(match[1]) };
	};
	const listboxState = async () => {
		const text = await pageText();
		const match = /listbox\|(Arrow(?:Up|Down)|init)\|(\d+)\|([a-z]+)/u.exec(text);
		assert.ok(match, `页面必须自证 listbox 状态：${JSON.stringify(text.slice(0, 200))}`);
		return { lastKey: match[1], selected: Number(match[2]), label: match[3] };
	};

	await request("close", { all: true }, 5_000);
	await request("open", { tabName: "keys", url: fixtures.url("/keys") }, 10_000);
	await request("wait", { tabName: "keys", status: "complete", timeoutMs: 10_000 }, 11_000);

	await recorder.check(`${CHORD}+A 全选后 Backspace 清空 textarea`, async () => {
		const observation = await snapshot();
		const textarea = refFor(observation, "textbox");
		await interact({ action: "type", targetRef: textarea, text: "hello world" });
		assert.deepEqual(await textareaState(), { value: "hello world", length: 11 }, "打字后页面应报告真实内容");
		const selectAll = await interact({ action: "keypress", targetRef: textarea, key: "a", modifiers: [CHORD] });
		assert.equal(selectAll.effect.dispatch, "keyboard");
		assert.deepEqual(selectAll.effect.modifiers, [CHORD]);
		const after = await interact({ action: "keypress", targetRef: textarea, key: "Backspace" });
		assert.equal(after.effect.key, "Backspace");
		assert.deepEqual(await textareaState(), { value: "", length: 0 }, "全选后 Backspace 必须清空");
	});

	await recorder.check("方向键移动 listbox 的选中项", async () => {
		const observation = await snapshot();
		const listbox = refFor(observation, "listbox");
		await interact({ action: "click", targetRef: listbox });
		await interact({ action: "keypress", targetRef: listbox, key: "ArrowDown" });
		await interact({ action: "keypress", targetRef: listbox, key: "ArrowDown" });
		assert.deepEqual(await listboxState(), { lastKey: "ArrowDown", selected: 3, label: "three" });
		await interact({ action: "keypress", targetRef: listbox, key: "ArrowUp" });
		assert.deepEqual(await listboxState(), { lastKey: "ArrowUp", selected: 2, label: "two" });
		// Shift must not swallow an arrow key.
		await interact({ action: "keypress", targetRef: listbox, key: "ArrowDown", modifiers: ["Shift"] });
		assert.deepEqual(await listboxState(), { lastKey: "ArrowDown", selected: 3, label: "three" });
	});

	await recorder.check("Shift 只改字母大小写，Home/End 移动光标", async () => {
		const observation = await snapshot();
		const textarea = refFor(observation, "textbox");
		await interact({ action: "click", targetRef: textarea });
		await interact({ action: "keypress", targetRef: textarea, key: "a", modifiers: ["Shift"] });
		await interact({ action: "keypress", targetRef: textarea, key: "b", modifiers: ["Shift"] });
		assert.deepEqual(await textareaState(), { value: "AB", length: 2 }, "Shift+字母必须大写");
		await interact({ action: "keypress", targetRef: textarea, key: "Home" });
		await interact({ action: "type", targetRef: textarea, text: "x", replace: false });
		assert.deepEqual(await textareaState(), { value: "xAB", length: 3 }, "Home 之后插入应在开头");
	});

	await recorder.check("白名单外的键与非法修饰键在本地被拒绝", async () => {
		const observation = await snapshot();
		const textarea = refFor(observation, "textbox");
		await assert.rejects(interact({ action: "keypress", targetRef: textarea, key: "F13" }), /key/u);
		await assert.rejects(interact({ action: "keypress", targetRef: textarea, key: "A" }), /key/u);
		await assert.rejects(interact({ action: "keypress", targetRef: textarea, key: "a", modifiers: ["Hyper"] }), /modifiers/u);
		await assert.rejects(interact({ action: "keypress", targetRef: textarea, key: "a", modifiers: ["Shift", "Shift"] }), /modifiers/u);
		await assert.rejects(interact({ action: "type", targetRef: textarea, text: "x", modifiers: ["Shift"] }), /modifiers/u);
		// A rejected key never reaches the page.
		assert.deepEqual(await textareaState(), { value: "xAB", length: 3 });
	});
}
