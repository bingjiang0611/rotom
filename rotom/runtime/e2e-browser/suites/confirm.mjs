// confirm (T21): sensitive actions need a real user decision before anything runs.
//
// The page records every click in its status line, so "was it dispatched" is answered by
// the page, not by the tool result. Each check turns the localhost escape hatch off unless
// the check is specifically about that switch.

import assert from "node:assert/strict";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "confirm：敏感名称与 cc-* 表单需确认、拒绝不派发、localhost 开关只对本机生效";

export async function run({ harness, fixtures, recorder, workspace }) {
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const tabName = "confirm";
	const text = async () => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 80 });
		return snapshot.details.observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
	};
	const refFor = async (name) => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 200 });
		const node = snapshot.details.observation.nodes.find((candidate) => candidate.name === name);
		assert.ok(node, `${name} 必须在快照里；现有：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 20).map((entry) => [entry.role, entry.name]))}`);
		return node.ref;
	};
	const savedConfirm = process.env.ROTOM_BROWSER_CONFIRM;
	try {
		await tools.inspect({ operation: "open", tabName, url: fixtures.url("/checkout") });
		await tools.inspect({ operation: "wait", tabName, status: "complete", timeoutMs: 10_000 });

		await recorder.check("敏感名称 + 没有 UI：不派发，返回 needs-approval/no-ui，页面状态没变", async () => {
			delete process.env.ROTOM_BROWSER_CONFIRM;
			const ref = await refFor("Place order");
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
			assert.equal(result.details.kind, "needs-approval", JSON.stringify(result.details));
			assert.equal(result.details.reason, "no-ui");
			assert.equal(result.details.capability, "interact");
			assert.match(await text(), /idle/u, "没有确认就不许点");
		});

		await recorder.check("cc-* 表单里的 Continue 也算敏感：按钮名称不在词表也要确认", async () => {
			delete process.env.ROTOM_BROWSER_CONFIRM;
			const ref = await refFor("Continue");
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
			assert.equal(result.details.kind, "needs-approval", JSON.stringify(result.details));
			assert.equal(result.details.reason, "no-ui");
			assert.match(result.content.map((part) => part.text ?? "").join(" "), /cc-\*/u, "拒绝理由必须说明是支付表单");
			assert.match(await text(), /idle/u);
		});

		await recorder.check("非敏感按钮在没有确认的情况下照常执行", async () => {
			delete process.env.ROTOM_BROWSER_CONFIRM;
			const ref = await refFor("Refresh totals");
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
			for (let attempt = 0; attempt < 20 && !/plain-clicked/u.test(await text()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.match(await text(), /plain-clicked/u);
		});

		await recorder.check("auto-approve-localhost 打开后同一个敏感点击真的执行", async () => {
			process.env.ROTOM_BROWSER_CONFIRM = "auto-approve-localhost";
			const ref = await refFor("Place order");
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
			for (let attempt = 0; attempt < 20 && !/order-placed/u.test(await text()); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.match(await text(), /order-placed/u);
		});

		await recorder.check("开关的值不对时仍然要确认（不会因为拼错就放行）", async () => {
			process.env.ROTOM_BROWSER_CONFIRM = "auto-approve";
			const ref = await refFor("Continue");
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
			assert.equal(result.details.kind, "needs-approval", JSON.stringify(result.details));
			assert.match(await text(), /order-placed/u, "状态行必须还停在上一格");
		});

		await recorder.check("上传在派发前就要确认：没有 UI 时文件不会被交出去", async () => {
			// The upload page itself needs no confirmation, only the upload action does.
			process.env.ROTOM_BROWSER_CONFIRM = "auto-approve-localhost";
			await tools.inspect({ operation: "open", tabName: "confirm-upload", url: fixtures.url("/upload") });
			await tools.inspect({ operation: "wait", tabName: "confirm-upload", status: "complete", timeoutMs: 10_000 });
			const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "confirm-upload", limit: 200 });
			const input = snapshot.details.observation.nodes.find((node) => node.name === "upload input");
			assert.ok(input, "upload fixture 必须有文件输入");
			const path = `${harness.root}/confirm-upload.txt`;
			await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "confirm upload payload\n"));
			delete process.env.ROTOM_BROWSER_CONFIRM;
			const before = fixtures.uploads.length;
			const refused = await tools.interact({ operation: "execute", tabName: "confirm-upload", action: "upload", targetRef: input.ref, paths: [path] });
			assert.equal(refused.details.kind, "needs-approval", JSON.stringify(refused.details));
			assert.equal(refused.details.reason, "no-ui");
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(fixtures.uploads.length, before, "没有确认时不得真的设置文件");
		});
	} finally {
		if (savedConfirm === undefined) delete process.env.ROTOM_BROWSER_CONFIRM;
		else process.env.ROTOM_BROWSER_CONFIRM = savedConfirm;
		await tools.shutdown();
	}
}
