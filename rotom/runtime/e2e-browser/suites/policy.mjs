// policy (T20): per-site authorization, and the origin re-check after a redirect.
//
// Two layers are under test here, and they are not the same layer:
//   * the Pi tool layer asks (or refuses) before it sends anything, using the policy file;
//   * the relay re-checks the tab's current origin against the origins the caller
//     authorized, so a server-side 30x cannot silently widen a write.
// Neither layer may dispatch the write it refused: the fixture page records a click in
// `document.title`, so "no dispatch" is observed on the page, not in the tool result.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadBrowserTools } from "../browser-tools.mjs";
import { installSuiteBrowserPolicy, relayRequestFor } from "../harness.mjs";

export const description = "policy：blocklist 拒绝、upload 单独授权、重定向后 origin 复核";

const NODE_NAME = "upload input";

export async function run({ harness, fixtures, recorder, workspace }) {
	const read = (policy) => installSuiteBrowserPolicy(harness, policy);
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	let tabName = "policy-1";
	let counter = 1;
	const nextTab = () => { counter += 1; tabName = `policy-${counter}`; return tabName; };
	const nodeNamed = async (name) => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 200 });
		const node = snapshot.details.observation.nodes.find((candidate) => candidate.name === name);
		assert.ok(node, `${name} 必须在快照里；现有：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 16).map((entry) => [entry.role, entry.name]))}`);
		return { node, observation: snapshot.details.observation };
	};

	try {
		await recorder.check("blocklist 优先于一切：本地拒绝且不派发", async () => {
			const policyPath = await read({ blocklist: [fixtures.origin], allowlist: [] });
			const raw = await import("node:fs/promises").then(({ readFile }) => readFile(policyPath, "utf8"));
			assert.equal(JSON.parse(raw).blocklist[0], fixtures.origin, "策略文件必须是 suite 自己写的那份");
			const result = await tools.inspect({ operation: "open", tabName, url: fixtures.url("/baseline") });
			assert.equal(result.details.kind, "needs-approval", JSON.stringify(result.details));
			assert.equal(result.details.reason, "blocklist");
			assert.equal(result.details.capability, "interact");
			assert.equal(fixtures.requestsTo("/baseline").length, 0, "被拒绝的 open 不得真的发出请求");
		});

		await recorder.check("允许 read/interact 不等于允许 upload：capability 分开授权", async () => {
			await read({ blocklist: [], allowlist: [{ origin: fixtures.origin, capabilities: ["read", "interact"] }] });
			await tools.inspect({ operation: "open", tabName, url: fixtures.url("/upload") });
			await tools.inspect({ operation: "wait", tabName, status: "complete", timeoutMs: 10_000 });
			const { node } = await nodeNamed(NODE_NAME);
			const path = `${harness.root}/policy-upload.txt`;
			await writeFile(path, "policy upload payload\n");
			const refused = await tools.interact({ operation: "execute", tabName, action: "upload", targetRef: node.ref, paths: [path] });
			assert.equal(refused.details.kind, "needs-approval", JSON.stringify(refused.details));
			assert.equal(refused.details.capability, "upload");
			assert.equal(fixtures.uploads.length, 0, "没有 upload 授权时不得真的设置文件");
		});

		await recorder.check("授权 upload 后同一操作放行", async () => {
			await read({ blocklist: [], allowlist: [{ origin: fixtures.origin, capabilities: ["read", "interact", "upload"] }] });
			const { node } = await nodeNamed(NODE_NAME);
			const body = "policy upload payload allowed\n";
			const path = `${harness.root}/policy-upload-allowed.txt`;
			await writeFile(path, body);
			const result = await tools.interact({ operation: "execute", tabName, action: "upload", targetRef: node.ref, paths: [path] });
			assert.equal(result.details.kind, "browser-interaction-result", JSON.stringify(result.details));
			for (let attempt = 0; attempt < 50 && fixtures.uploads.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(fixtures.uploads.length, 1, "授权后必须真的上传一次");
		});

		await recorder.check("重定向到未授权 origin：工具层拒绝，页面没有收到点击", async () => {
			// The first origin is allowed, the redirect target is blocklisted: the tab lands
			// somewhere this session never authorized.
			await read({ blocklist: [fixtures.frameOrigin], allowlist: [{ origin: fixtures.origin, capabilities: ["read", "interact", "upload"] }] });
			nextTab();
			await tools.inspect({ operation: "open", tabName, url: fixtures.url("/redirect-out") });
			await tools.inspect({ operation: "wait", tabName, status: "complete", timeoutMs: 10_000 });
			// After the redirect the tab is on a blocklisted origin, so this session cannot
			// even read the page any more — the tool layer refuses before any request.
			const readBack = await tools.inspect({ operation: "snapshot_visible", tabName, limit: 60 });
			assert.equal(readBack.details.kind, "needs-approval", JSON.stringify(readBack.details));
			assert.equal(readBack.details.reason, "blocklist");
			assert.equal(readBack.details.capability, "read");
			// The write is refused the same way, with the interact capability.
			const clicked = await tools.interact({ operation: "execute", tabName, action: "click", targetRef: "ax_1_1" }).catch((error) => error);
			if (clicked instanceof Error) assert.match(clicked.message, /授权|policy|epoch|ref/iu);
			else {
				assert.equal(clicked.details.kind, "needs-approval", JSON.stringify(clicked.details));
				assert.equal(clicked.details.reason, "blocklist");
				assert.equal(clicked.details.capability, "interact");
			}
			// The redirect really happened exactly once: the target page was fetched, and no
			// further navigation happened afterwards.
			assert.equal(fixtures.requestsTo("/redirect-target").length, 1, JSON.stringify(fixtures.requests.map((entry) => entry.path)));
		});

		await recorder.check("relay 在派发写操作前复核 origin，redirect 不能绕过", async () => {
			// Bypass the Pi layer on purpose: the relay has to refuse on its own. The raw
			// client owns its own tab, so it opens the redirect itself.
			await read({ blocklist: [], allowlist: [fixtures.origin, fixtures.frameOrigin].map((origin) => ({ origin, capabilities: ["read", "interact", "upload"] })) });
			const client = await harness.connect("policy-raw");
			const request = relayRequestFor(client, "policy-raw");
			const rawTab = "policy-raw-tab";
			try {
				await request("open", { tabName: rawTab, url: fixtures.url("/redirect-out") });
				await request("wait", { tabName: rawTab, status: "complete", timeoutMs: 10_000 });
				const snapshot = await request("snapshot", { tabName: rawTab, limit: 80 });
				assert.equal(snapshot.kind, "rotom-browser-observation", JSON.stringify(snapshot));
				assert.match(snapshot.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" "), /untouched/u, "raw 客户端也要落到重定向后的页面");
				const button = snapshot.nodes.find((node) => node.name === "Click me");
				assert.ok(button, "重定向目标页必须有按钮");
				const refused = await request("interact", { actionId: "e2e-policy-origin", tabName: rawTab, action: "click", targetRef: button.ref, allowedOrigins: [fixtures.origin] });
				assert.equal(refused.kind, "needs-approval", JSON.stringify(refused));
				assert.equal(refused.reason, "origin", "relay 必须指出是 origin 不匹配");
				assert.equal(refused.origin, fixtures.frameOrigin);
				const afterRefusal = await request("snapshot", { tabName: rawTab, limit: 80 });
				assert.match(afterRefusal.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" "), /untouched/u, "relay 拒绝后页面依然没有收到点击");
				// The same click is accepted once the caller authorizes the current origin.
				const allowed = await request("interact", { actionId: "e2e-policy-origin-ok", tabName: rawTab, action: "click", targetRef: button.ref, allowedOrigins: [fixtures.frameOrigin] });
				assert.equal(allowed.kind, "rotom-browser-interaction-result", JSON.stringify(allowed));
				for (let attempt = 0; attempt < 20; attempt += 1) {
					const latest = await request("snapshot", { tabName: rawTab, limit: 80 });
					if (latest.nodes.some((node) => node.role === "document-text" && /clicked/u.test(node.name))) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				const final = await request("snapshot", { tabName: rawTab, limit: 80 });
				assert.match(final.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" "), /clicked/u, "origin 匹配时点击必须真的发生");
			} finally {
				client.close();
			}
		});
	} finally {
		await tools.shutdown();
	}
}
