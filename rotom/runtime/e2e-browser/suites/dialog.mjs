// dialog (T18): a JS dialog suspends the tab, so every other operation must refuse
// instead of hanging, and the `dialog` action must be the only way forward.
//
// The page records what `alert`/`confirm`/`prompt` returned, so "the dialog was handled"
// is proven by page state, not by the command acknowledgement.

import assert from "node:assert/strict";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "dialog：alert/confirm（两种）/prompt/beforeunload，弹窗期间其它操作被拒";

export async function run({ harness, fixtures, recorder, workspace }) {
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");
	const pageText = async (tabName) => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 100 });
		if (snapshot.details.kind === "dialog-blocking") return "";
		return snapshot.details.observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
	};
	const refFor = async (name, tabName = "dialog") => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 200 });
		assert.equal(snapshot.details.kind, "observation", textOf(snapshot));
		const node = snapshot.details.observation.nodes.find((candidate) => candidate.name === name);
		assert.ok(node, `${name} 必须在快照里；现有：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 16).map((entry) => [entry.role, entry.name]))}`);
		return node.ref;
	};
	const click = async (name) => tools.interact({ operation: "execute", tabName: "dialog", action: "click", targetRef: await refFor(name) });
	// Chrome resolves the dialog command after the page continues; give the click handler
	// one turn to write its status line.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

	try {
		await tools.inspect({ operation: "open", tabName: "dialog", url: fixtures.url("/dialog"), limit: 5 });
		await tools.inspect({ operation: "wait", tabName: "dialog", status: "complete", timeoutMs: 10_000 });

		await recorder.check("alert 弹窗期间其它操作返回 dialog-blocking，accept 后页面继续", async () => {
			// The click that opens the dialog cannot answer with a readback of a suspended
			// page, so it is allowed to report the dialog instead of a page state.
			const opened = await click("open alert");
			assert.equal(opened.details.kind, "browser-interaction-result", textOf(opened));
			assert.equal(opened.details.effect.dialogOpened, true, "打开弹窗的点击必须当场报告弹窗，而不是等超时");
			assert.equal(opened.details.effect.dialog.type, "alert");
			await settle();
			const blocked = await tools.inspect({ operation: "snapshot_visible", tabName: "dialog", limit: 20 });
			assert.equal(blocked.details.kind, "dialog-blocking", textOf(blocked));
			assert.equal(blocked.details.dialog.type, "alert");
			assert.equal(blocked.details.dialog.message, "alert message");
			// tabs stays exempt so the agent can see which tab is blocked.
			const tabs = await tools.inspect({ operation: "tabs" });
			assert.equal(tabs.details.kind, "tabs");
			// A write is refused too, and nothing is dispatched.
			const blockedClick = await tools.interact({ operation: "execute", tabName: "dialog", action: "click", targetRef: "ax_r_1" });
			assert.equal(blockedClick.details.kind, "dialog-blocking");
			assert.equal(blockedClick.details.dialog.tabId > 0, true);
			const handled = await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true });
			assert.equal(handled.details.kind, "browser-interaction-result", textOf(handled));
			assert.equal(handled.details.effect.accept, true);
			await settle();
			assert.match(await pageText("dialog"), /dialog-result\|alert\|returned/u, "页面必须在 alert 返回后继续执行");
		});

		await recorder.check("confirm 取消返回 false，接受返回 true", async () => {
			await click("open confirm");
			await settle();
			const dismissed = await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: false });
			assert.equal(dismissed.details.effect.accept, false);
			await settle();
			assert.match(await pageText("dialog"), /dialog-result\|confirm\|false/u);
			await click("open confirm");
			await settle();
			await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true });
			await settle();
			assert.match(await pageText("dialog"), /dialog-result\|confirm\|true/u);
		});

		await recorder.check("prompt 带文字返回该文字，取消返回 null", async () => {
			await click("open prompt");
			await settle();
			const blocked = await tools.inspect({ operation: "snapshot_visible", tabName: "dialog", limit: 20 });
			assert.equal(blocked.details.kind, "dialog-blocking");
			assert.equal(blocked.details.dialog.type, "prompt");
			assert.equal(blocked.details.dialog.defaultPrompt, "default answer");
			await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true, promptText: "typed answer" });
			await settle();
			assert.match(await pageText("dialog"), /dialog-result\|prompt\|typed answer/u);
			await click("open prompt");
			await settle();
			await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: false });
			await settle();
			assert.match(await pageText("dialog"), /dialog-result\|prompt\|null/u, "取消的 prompt 必须返回 null");
		});

		await recorder.check("没有弹窗时 dialog 动作被拒，参数组合非法也被拒", async () => {
			await assert.rejects(tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true }), /not open|dialog/u);
			await click("open alert");
			await settle();
			await assert.rejects(tools.interact({ operation: "execute", tabName: "dialog", action: "dialog" }), /accept/u);
			await assert.rejects(tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: false, promptText: "x" }), /promptText/u);
			await assert.rejects(tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true, targetRef: "ax_r_1" }), /dialog/u);
			await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true });
			await settle();
		});

		await recorder.check("beforeunload 弹窗：导航被挂起、navigate 被拒，接受后才离开页面", async () => {
			// Clicking a link with a beforeunload handler opens the dialog and suspends the
			// pending navigation.
			const leaving = await click("leave page");
			assert.equal(leaving.details.effect.dialogOpened, true, textOf(leaving));
			assert.equal(leaving.details.effect.dialog.type, "beforeunload");
			assert.equal(leaving.details.effect.dialog.sensitive, true, "beforeunload 必须标为敏感");
			await settle();
			const blocked = await tools.inspect({ operation: "navigate", tabName: "dialog", url: fixtures.url("/baseline"), limit: 5 });
			assert.equal(blocked.details.kind, "dialog-blocking", textOf(blocked));
			assert.equal(blocked.details.dialog.type, "beforeunload");
			assert.equal(blocked.details.dialog.sensitive, true);
			const before = fixtures.requestsTo("/baseline").length;
			const handled = await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true });
			assert.equal(handled.details.kind, "browser-interaction-result", textOf(handled));
			// Accepting lets the pending navigation go through.
			for (let attempt = 0; attempt < 60; attempt += 1) {
				if (fixtures.requestsTo("/baseline").length > before) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(fixtures.requestsTo("/baseline").length > before, "接受后挂起的导航必须真的发生");
			const tabs = await tools.inspect({ operation: "tabs" });
			const tab = tabs.details.tabs.find((candidate) => candidate.name === "dialog");
			assert.equal(new URL(tab.url).pathname, "/baseline");
			assert.equal(tab.dialog, undefined, "处理完之后不能再标记为弹窗阻塞");
		});
	} finally {
		await tools.shutdown();
	}
}
