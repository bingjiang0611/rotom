// batch (T19): one call fills and submits a whole form, and every stop condition really
// stops. The page writes the submitted values into a status line, so "the form was
// submitted" is page evidence, not an acknowledgement.

import assert from "node:assert/strict";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "batch：一次 batch 填完表单并提交，失败/expect 不满足立即停下";

export async function run({ harness, fixtures, recorder, workspace }) {
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");
	const refs = async () => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "form", limit: 200 });
		assert.equal(snapshot.details.kind, "observation", textOf(snapshot));
		const byName = new Map(snapshot.details.observation.nodes.map((node) => [node.name, node.ref]));
		return (name) => {
			const ref = byName.get(name);
			assert.ok(ref, `${name} 必须在快照里；现有：${JSON.stringify([...byName.keys()].slice(0, 20))}`);
			return ref;
		};
	};
	const pageText = async () => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "form", limit: 100 });
		return snapshot.details.observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
	};

	try {
		await tools.inspect({ operation: "open", tabName: "form", url: fixtures.url("/form"), limit: 5 });
		await tools.inspect({ operation: "wait", tabName: "form", status: "complete", timeoutMs: 10_000 });

		await recorder.check("一次 batch 填完并提交表单，逐步返回证据", async () => {
			const find = await refs();
			const result = await tools.interact({
				operation: "execute",
				tabName: "form",
				actions: [
					{ action: "type", targetRef: find("Agent name"), text: "Ada", replace: true },
					{ action: "select", targetRef: find("Agent plan"), option: "active" },
					{ action: "click", targetRef: find("Submit form"), expect: "focused=false" },
				],
			});
			assert.equal(result.details.kind, "browser-batch-result", textOf(result));
			assert.equal(result.details.completed, true, JSON.stringify(result.details));
			assert.equal(result.details.steps.length, 3);
			for (const step of result.details.steps) {
				assert.equal(step.status, "ok", JSON.stringify(step));
				assert.equal(step.acknowledged, true);
				assert.equal(typeof step.readbackDigest, "string");
			}
			assert.equal(result.details.steps[0].action, "type");
			assert.equal(result.details.steps[2].expectation, "met");
			assert.equal(JSON.stringify(result.details).includes("nodes"), false, "批量结果不带整页节点");
			assert.match(await pageText(), /name=Ada plan=active/u, "页面必须真的提交了这些值");
		});

		await recorder.check("expect 不满足时停下，后面的步骤不执行", async () => {
			const find = await refs();
			const before = await pageText();
			const result = await tools.interact({
				operation: "execute",
				tabName: "form",
				actions: [
					// The name field already holds "Ada", so `value=empty` cannot be met.
					{ action: "click", targetRef: find("Agent name"), expect: "value=empty" },
					{ action: "type", targetRef: find("Agent name"), text: "never", replace: true },
				],
			});
			assert.equal(result.details.kind, "browser-batch-result", textOf(result));
			assert.equal(result.details.completed, false);
			assert.equal(result.details.stopReason, "expect-unmet");
			assert.equal(result.details.stoppedAt, 0);
			assert.equal(result.details.steps.length, 1, "第二步不得执行");
			assert.equal(result.details.steps[0].status, "expect-unmet");
			assert.equal(await pageText(), before, "页面不应被第二步改动");
		});

		await recorder.check("单步校验失败即停下并说明是 failed，不是 unknown", async () => {
			const find = await refs();
			const result = await tools.interact({
				operation: "execute",
				tabName: "form",
				actions: [
					{ action: "select", targetRef: find("Agent plan"), option: "active" },
					{ action: "keypress", targetRef: find("Agent name"), key: "F13" },
					{ action: "select", targetRef: find("Agent plan"), option: "draft" },
				],
			});
			assert.equal(result.details.completed, false);
			assert.equal(result.details.stopReason, "failed");
			assert.equal(result.details.stoppedAt, 1);
			assert.equal(result.details.steps.length, 2);
			assert.match(String(result.details.steps[1].error), /keypress key|白名单/u);
			// The first step already ran and the third must not: submitting now shows the
			// value the batch really left behind.
			assert.match(await pageText(), /name=Ada plan=active/u);
			await tools.interact({ operation: "execute", tabName: "form", action: "click", targetRef: find("Submit form") });
			assert.match(await pageText(), /name=Ada plan=active/u, "第三步被跳过后 plan 仍是 active");
		});

		await recorder.check("批次里的弹窗阻塞立即停下", async () => {
			await tools.inspect({ operation: "open", tabName: "dialog", url: fixtures.url("/dialog"), limit: 5 });
			await tools.inspect({ operation: "wait", tabName: "dialog", status: "complete", timeoutMs: 10_000 });
			const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "dialog", limit: 100 });
			const button = snapshot.details.observation.nodes.find((node) => node.name === "open alert");
			assert.ok(button, "需要 alert 按钮");
			const opening = await tools.interact({ operation: "execute", tabName: "dialog", actions: [{ action: "click", targetRef: button.ref }, { action: "click", targetRef: button.ref }] });
			assert.equal(opening.details.completed, false);
			assert.equal(opening.details.stopReason, "dialog-blocking");
			assert.equal(opening.details.stoppedAt, 0);
			assert.equal(opening.details.steps[0].dialog, "alert");
			// Leave the fixture behind in a handled state.
			await tools.interact({ operation: "execute", tabName: "dialog", action: "dialog", accept: true });
		});
	} finally {
		await tools.shutdown();
	}
}
