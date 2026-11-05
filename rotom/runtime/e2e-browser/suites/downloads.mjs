// downloads (T22): agent downloads land under rotom/<agentId>/, the user's do not move.
//
// The fixture serves `/download` with a Content-Disposition filename, so the page's own
// suggested name is "fixture.txt". An agent tab download must end up in the agent's
// subdirectory with a matching digest; a download started from a claimed *user* tab must
// keep the browser's default location.

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadBrowserTools } from "../browser-tools.mjs";
import { relayRequestFor } from "../harness.mjs";

/** Waits for a finished download file in one directory and returns its absolute path. */
async function waitForFile(directory, prefix) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
		const found = names.find((entry) => entry.isFile() && entry.name.startsWith(prefix));
		if (found) return join(directory, found.name);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`${directory} 里没有出现 ${prefix} 下载文件`);
}

export const startUrlPage = "/baseline";

export const description = "downloads：agent 下载落到 rotom/<agentId>/ 且 sha256 一致，用户 tab 的下载不被改路径";

export async function run({ harness, fixtures, recorder, workspace }) {
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const agentTab = "download-agent";
	const waitFor = async (predicate, timeoutMs = 15_000) => {
		const started = Date.now();
		for (;;) {
			const listed = await tools.inspect({ operation: "downloads" });
			if (predicate(listed.details)) return listed;
			if (Date.now() - started > timeoutMs) return listed;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};
	try {
		await tools.inspect({ operation: "open", tabName: agentTab, url: fixtures.url("/download-page") });
		await tools.inspect({ operation: "wait", tabName: agentTab, status: "complete", timeoutMs: 10_000 });

		await recorder.check("agent tab 的下载落到 rotom/<agentId>/，sha256 与服务端字节一致", async () => {
			const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: agentTab, limit: 200 });
			const link = snapshot.details.observation.nodes.find((node) => node.name === "Download fixture");
			assert.ok(link, `下载链接必须在快照里：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 20).map((entry) => [entry.role, entry.name]))}`);
			const click = await tools.interact({ operation: "execute", tabName: agentTab, action: "click", targetRef: link.ref });
			assert.equal(click.details.kind, "browser-interaction-result", JSON.stringify(click.details));
			const listed = await waitFor((details) => (details.downloads ?? []).some((entry) => entry.state === "complete"));
			const record = (listed.details.downloads ?? []).find((entry) => entry.state === "complete");
			assert.ok(record, `必须有一条已完成的下载：${JSON.stringify(listed.details)}`);
			// Content-Disposition wins over the link's `download` attribute, and Chrome
			// uniquifies a repeated name, so the basename may carry " (n)".
			assert.match(record.relativePath, /^rotom\/[A-Za-z0-9_-]+\/fixture( \(\d+\))?\.txt$/u, `${record.relativePath} 必须在 agent 子目录里`);
			assert.equal(record.mimeType.startsWith("text/plain"), true, `mime 必须来自 Chrome：${record.mimeType}`);
			assert.match(String(record.sha256 ?? ""), /^[0-9a-f]{64}$/u, "完成态必须有 sha256");
			// 与 fixture 里的正文逐字节一致。
			const expected = await import("node:crypto").then(({ createHash }) => createHash("sha256").update("fixture download body\n").digest("hex"));
			assert.equal(record.sha256, expected);
			assert.equal(record.bytes, "fixture download body\n".length);
			// 模型可见的结果里没有绝对路径。
			const text = JSON.stringify(listed.details);
			assert.equal(/\/Users\/|\/var\/folders\//u.test(text), false, "结果里不得出现绝对路径");
		});

		await recorder.check("用户 tab 的下载不被改路径：站点收到两次请求，agent 列表里仍只有一条", async () => {
			// A claimed tab belongs to the user, so its download must keep the browser's own
			// location. The fixture proves the download happened; the listing proves it was
			// not recorded under the agent directory.
			const discovered = await tools.inspect({ operation: "discover" });
			const candidate = discovered.details.tabs[0];
			assert.ok(candidate, `必须有可 claim 的用户 tab：${JSON.stringify(discovered.details)}`);
			await tools.inspect({ operation: "claim", tabId: candidate.tabId, tabName: "download-user" });
			const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "download-user", limit: 200 });
			const link = snapshot.details.observation.nodes.find((node) => node.name === "Download fixture");
			assert.ok(link, `claimed tab 必须有下载链接：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 20).map((entry) => [entry.role, entry.name]))}`);
			const before = fixtures.requestsTo("/download").length;
			await tools.interact({ operation: "execute", tabName: "download-user", action: "click", targetRef: link.ref });
			for (let attempt = 0; attempt < 60 && fixtures.requestsTo("/download").length === before; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(fixtures.requestsTo("/download").length, before + 1, "用户 tab 的下载必须真的发生");
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const listed = await tools.inspect({ operation: "downloads" });
			assert.equal((listed.details.downloads ?? []).length, 1, `用户下载不得进入 agent 目录：${JSON.stringify(listed.details.downloads)}`);
			// The user's file must also finish where Chrome put it: a listener that answers
			// `true` without calling `suggest()` would leave the download determining forever.
			const placed = await waitForFile(harness.downloadsDir, "fixture");
			assert.match(placed, /\/fixture(?: \(\d+\))?\.txt$/u, `用户下载应留在浏览器默认目录：${placed}`);
			assert.equal(placed.includes("/romot/"), false, "用户下载不得被重定向进 agent 目录");
			assert.equal(placed.includes("/rotom/"), false, "用户下载不得被重定向进 agent 目录");
		});
		await recorder.check("子 agent 未声明 allow.download 时下载被取消并报 blocked，声明后放行", async () => {
			// Close the main agent's page first: two agent tabs on the same page would make the
			// referrer ambiguous, which is exactly the case the owner lookup refuses to guess.
			await tools.inspect({ operation: "close", tabName: agentTab });
			// A child of this run: same root session, its own agent id and lease token.
			const parent = await harness.connect("downloads-parent");
			const child = await harness.connect("downloads-child", { principal: { agentId: "run_childdownload", rootSessionId: parent.rootSessionId, leaseToken: "child-download" } });
			const request = relayRequestFor(child, "downloads-child");
			const childTab = "child-download";
			try {
				await request("open", { tabName: childTab, url: fixtures.url("/download-page") });
				await request("wait", { tabName: childTab, status: "complete", timeoutMs: 10_000 });
				const before = fixtures.requestsTo("/download").length;
				const clickAt = async () => {
					const snapshot = await request("snapshot", { tabName: childTab, limit: 120 });
					const link = snapshot.nodes.find((node) => node.name === "Download fixture");
					assert.ok(link, "child 页面必须有下载链接");
					return link.ref;
				};
				// No declaration yet: the relay must cancel it.
				await request("interact", { actionId: "child-download-1", tabName: childTab, action: "click", targetRef: await clickAt() });
				for (let attempt = 0; attempt < 50 && fixtures.requestsTo("/download").length === before; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
				assert.equal(fixtures.requestsTo("/download").length, before + 1, "下载请求必须真的发生");
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				const refused = await request("downloads", {});
				assert.equal(refused.downloads.length, 0, `未授权的下载不得出现在列表里：${JSON.stringify(refused.downloads)}`);
				assert.equal(refused.blocked.length >= 1, true, `必须记录一次被取消的下载：${JSON.stringify(refused.blocked)}`);
				// Now declare the lease permission, as a child with allow.download would.
				await request("interact", { actionId: "child-download-2", tabName: childTab, action: "click", targetRef: await clickAt(), allowDownload: true });
				for (let attempt = 0; attempt < 60; attempt += 1) {
					const listed = await request("downloads", {});
					if (listed.downloads.length > 0) break;
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				const allowed = await request("downloads", {});
				assert.equal(allowed.downloads.length >= 1, true, `声明后下载必须落地：${JSON.stringify(allowed)}`);
				assert.match(allowed.downloads[0].relativePath, /^rotom\/run_childdownload\//u, "必须落在该 agent 自己的目录");
			} finally {
				child.close();
				parent.close();
			}
		});
	} finally {
		await tools.shutdown();
	}
}
