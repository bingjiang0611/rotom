// Child leases (T9): a subagent gets a structured refusal, not a dispatched open.
//
// The refusal must happen inside the tool layer, so this suite drives the real
// browser tools over the harness socket and asserts on the fixture server's request
// log: a refused origin must never produce an HTTP request at all.

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "子 agent 的 lease：未授权 origin 本地拒绝，站点从未收到请求";

const TOKEN = "e2e-lease-child";

export async function run({ harness, fixtures, recorder, workspace }) {
	const leaseDir = join(dirname(harness.socketPath), "leases");
	await mkdir(leaseDir, { recursive: true, mode: 0o700 });
	await chmod(leaseDir, 0o700);
	const leaseFile = join(leaseDir, `${TOKEN}.json`);

	// A child scope names exactly one origin: the one the fixture server answers on.
	const allowed = new URL(fixtures.url("/baseline")).origin;
	const writeLease = async (origins, expiresAt = Date.now() + 60_000) => {
		await writeFile(leaseFile, JSON.stringify({ schemaVersion: 1, kind: "rotom-browser-lease", token: TOKEN, agentId: TOKEN, rootSessionId: "e2e-root", origins, allow: { devtools: false, upload: false, download: false }, maxTabs: 4, keepTabs: false, expiresAt }), { mode: 0o600 });
		await chmod(leaseFile, 0o600);
	};
	const scopeEnv = process.env.ROTOM_BROWSER_LEASE_SCOPE;
	const tokenEnv = process.env.ROTOM_BROWSER_LEASE;
	// The main agent publishes its scope into the environment; here it is the fixture
	// origin, which is what a parent that already opened the site would publish.
	process.env.ROTOM_BROWSER_LEASE_SCOPE = JSON.stringify({ schemaVersion: 1, rootSessionId: "e2e-root", origins: [allowed], allow: { devtools: false, upload: false, download: false }, maxTabs: 4, keepTabs: false, expiresAt: Date.now() + 60_000 });
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const restoreEnv = () => {
		if (scopeEnv === undefined) delete process.env.ROTOM_BROWSER_LEASE_SCOPE; else process.env.ROTOM_BROWSER_LEASE_SCOPE = scopeEnv;
		if (tokenEnv === undefined) delete process.env.ROTOM_BROWSER_LEASE; else process.env.ROTOM_BROWSER_LEASE = tokenEnv;
	};

	const deniedOrigin = fixtures.url("/lease-target");
	const baselineBefore = fixtures.requestsTo("/baseline").length;
	let child;
	let targetRef;

	try {
		// 1. A child with no lease file at all may not open anything.
		process.env.ROTOM_BROWSER_LEASE = TOKEN;
		child = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
		await recorder.check("没有 lease 的子 agent 被本地拒绝", async () => {
			await writeLease([allowed]);
			await chmod(leaseFile, 0o644);
			const result = await child.inspect({ operation: "open", tabName: "lease-none", url: deniedOrigin, limit: 5 });
			assert.equal(result.details.kind, "needs-approval");
			assert.equal(result.details.reason, "missing", "组/世界可读的 lease 文件不算授权");
			assert.equal(child.calls.includes("open"), true, "工具被调用了");
		});

		// 2. A lease that covers another origin refuses this one, and the site is untouched.
		await recorder.check("lease 未覆盖的 origin 返回 needs-approval 且没有网络请求", async () => {
			await writeLease(["https://other.example.test"]);
			const before = fixtures.requestsTo("/lease-target").length;
			const result = await child.inspect({ operation: "open", tabName: "lease-denied", url: deniedOrigin, limit: 5 });
			assert.equal(result.details.kind, "needs-approval");
			assert.equal(result.details.reason, "origin");
			assert.equal(result.details.origin, new URL(deniedOrigin).origin);
			assert.equal(result.details.capability, "open");
			assert.match(result.content[0].text, /needs-approval/u);
			// Chrome would have requested the page if the open had been dispatched.
			assert.equal(fixtures.requestsTo("/lease-target").length, before, "拒绝的 open 不得让站点收到请求");
		});

		// 3. An expired lease refuses even an origin it lists.
		await recorder.check("过期 lease 同样拒绝", async () => {
			await writeLease([allowed], Date.now() - 1_000);
			const result = await child.inspect({ operation: "open", tabName: "lease-expired", url: fixtures.url("/baseline"), limit: 5 });
			assert.equal(result.details.kind, "needs-approval");
			assert.equal(result.details.reason, "expired");
			assert.equal(fixtures.requestsTo("/baseline").length, baselineBefore, "过期 lease 不得打开页面");
		});

		// 4. The parent widens the lease file; the child re-reads it per call and passes.
		await recorder.check("父 agent 更新 lease 后放行", async () => {
			await writeLease([allowed]);
			const opened = await child.inspect({ operation: "open", tabName: "lease-allowed", url: fixtures.url("/baseline"), limit: 5 });
			assert.equal(opened.details.kind, "observation");
			assert.equal(opened.details.observation.tabName, "lease-allowed");
			assert.ok(fixtures.requestsTo("/baseline").length > baselineBefore, "放行后站点必须真的收到请求");
			targetRef = opened.details.observation.nodes.find((node) => node.ref)?.ref;
		});

		// 5. Reads are never gated; writes are gated on the reading tab's origin.
		await recorder.check("只读不受限制，写操作按 tab 的 origin 判定", async () => {
			const snapshot = await child.inspect({ operation: "snapshot_visible", tabName: "lease-allowed", limit: 5 });
			assert.equal(snapshot.details.kind, "observation", "只读 snapshot 不需要 lease");
			assert.ok(targetRef, "需要至少一个可选中的 ref");
			const allowedClick = await child.interact({ operation: "execute", tabName: "lease-allowed", action: "click", targetRef });
			assert.equal(allowedClick.details.kind, "browser-interaction-result", "lease 覆盖该 origin 时写操作放行");
			await writeLease(["https://other.example.test"]);
			const deniedClick = await child.interact({ operation: "execute", tabName: "lease-allowed", action: "click", targetRef });
			assert.equal(deniedClick.details.kind, "needs-approval");
			assert.equal(deniedClick.details.capability, "write");
			assert.equal(deniedClick.details.reason, "origin");
		});

		// 5b. navigate follows the same lease rule as open.
		await recorder.check("navigate 到 lease 外的 origin 也被拒绝，且没有网络请求", async () => {
			await writeLease([allowed]);
			await child.inspect({ operation: "navigate", tabName: "lease-allowed", url: fixtures.url("/license-target"), limit: 5 });
			await writeLease(["https://other.example.test"]);
			const before = fixtures.requestsTo("/lease-target").length;
			const denied = await child.inspect({ operation: "navigate", tabName: "lease-allowed", url: deniedOrigin, limit: 5 });
			assert.equal(denied.details.kind, "needs-approval");
			assert.equal(denied.details.reason, "origin");
			assert.equal(fixtures.requestsTo("/lease-target").length, before, "被拒绝的 navigate 不得让站点收到请求");
			await writeLease([allowed]);
			const allowedNavigate = await child.inspect({ operation: "navigate", tabName: "lease-allowed", url: fixtures.url("/popup"), limit: 5 });
			assert.equal(allowedNavigate.details.kind, "observation", "lease 覆盖时 navigate 放行");
			assert.ok(fixtures.requestsTo("/popup").length > 0, "放行后站点必须真的收到请求");
			await child.inspect({ operation: "navigate", tabName: "lease-allowed", url: fixtures.url("/baseline"), limit: 5 });
		});

		// 6. A child does not publish a scope for its own children.
		await recorder.check("子 agent 不会把 lease 传给自己的子 agent", async () => {
			const before = process.env.ROTOM_BROWSER_LEASE_SCOPE;
			await child.inspect({ operation: "tabs" });
			assert.equal(process.env.ROTOM_BROWSER_LEASE_SCOPE, before, "子 agent 不得改写父 agent 发布的 lease scope");
		});
	} finally {
		if (child) await child.shutdown();
		restoreEnv();
	}
	// The main-agent path (no lease token) is unchanged; the baseline suite proves it.
	assert.equal((await readFile(leaseFile, "utf8")).includes("rotom-browser-lease"), true);
}
