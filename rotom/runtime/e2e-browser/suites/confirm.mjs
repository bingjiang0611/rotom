// Main-agent full access over the real relay, without UI or a localhost override.
// Fixture page state and received uploads prove dispatch, not just tool acknowledgements.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadBrowserTools } from "../browser-tools.mjs";
import { installSuiteBrowserPolicy } from "../harness.mjs";

export const description = "confirm：主 agent 无 UI、无逐站授权也能操作敏感名称、支付表单和上传";

export async function run({ harness, fixtures, recorder, workspace }) {
	await installSuiteBrowserPolicy(harness, { blocklist: [], allowlist: [] });
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const tabName = "confirm";
	const snapshotFor = async (name = tabName) => (await tools.inspect({ operation: "snapshot_visible", tabName: name, limit: 200 })).details.observation;
	const refFor = async (name) => {
		const snapshot = await snapshotFor();
		const node = snapshot.nodes.find((candidate) => candidate.name === name);
		assert.ok(node, `${name} 必须在快照里`);
		return node.ref;
	};
	const assertPageText = async (expected) => {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const snapshot = await snapshotFor();
			const text = snapshot.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
			if (expected.test(text)) return;
			if (attempt === 19) assert.match(text, expected);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const savedConfirm = process.env.ROTOM_BROWSER_CONFIRM;
	try {
		delete process.env.ROTOM_BROWSER_CONFIRM;
		await tools.inspect({ operation: "open", tabName, url: fixtures.url("/checkout") });
		await tools.inspect({ operation: "wait", tabName, status: "complete", timeoutMs: 10_000 });

		for (const [name, expected] of [
			["Place order", /order-placed/u],
			["Continue", /pay-clicked/u],
			["Refresh totals", /plain-clicked/u],
		]) {
			await recorder.check(`${name}：无 UI、无授权也真的执行`, async () => {
				const ref = await refFor(name);
				const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: ref });
				assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
				await assertPageText(expected);
			});
		}

		await recorder.check("旧 localhost 开关不再决定主 agent 的敏感操作权限", async () => {
			process.env.ROTOM_BROWSER_CONFIRM = "auto-approve";
			const result = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: await refFor("Continue") });
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
			await assertPageText(/pay-clicked/u);
		});

		await recorder.check("无 UI、无 upload 授权也真正上传一次", async () => {
			delete process.env.ROTOM_BROWSER_CONFIRM;
			await tools.inspect({ operation: "open", tabName: "confirm-upload", url: fixtures.url("/upload") });
			await tools.inspect({ operation: "wait", tabName: "confirm-upload", status: "complete", timeoutMs: 10_000 });
			const input = (await snapshotFor("confirm-upload")).nodes.find((node) => node.name === "upload input");
			assert.ok(input, "upload fixture 必须有文件输入");
			const path = `${harness.root}/confirm-upload.txt`;
			await writeFile(path, "confirm upload payload\n");
			const before = fixtures.uploads.length;
			const result = await tools.interact({ operation: "execute", tabName: "confirm-upload", action: "upload", targetRef: input.ref, paths: [path] });
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
			for (let attempt = 0; attempt < 50 && fixtures.uploads.length === before; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(fixtures.uploads.length, before + 1);
		});
	} finally {
		if (savedConfirm === undefined) delete process.env.ROTOM_BROWSER_CONFIRM;
		else process.env.ROTOM_BROWSER_CONFIRM = savedConfirm;
		await tools.shutdown();
	}
}
