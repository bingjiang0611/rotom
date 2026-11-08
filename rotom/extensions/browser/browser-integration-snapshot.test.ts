import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserIntegrationFixture } from "./browser-test-helpers.ts";

test("browser relay：全文、可见快照与分页证据保持分层", async (t) => {
	const fixture = await createBrowserIntegrationFixture();
	const { browser, ctx, tool, calls, tabs } = fixture;
	try {
		await tool.execute("fixture-docs", { operation: "open", tabName: "docs", url: "https://example.test/path?token=secret#fragment", limit: 10 }, undefined, undefined, ctx);
		const completeSnapshot = await tool.execute("browser-default-complete-snapshot", { operation: "snapshot", tabName: "docs" }, undefined, undefined, ctx);
		assert.equal(calls.at(-1)?.operation, "read_full", "默认 snapshot 必须确定性走虚拟化全文读取");
		assert.equal(completeSnapshot.details.observation.nodes.length, 269, "默认 snapshot 应返回字节上限内的全部正文节点");
		assert.equal(completeSnapshot.details.observation.nodes.some((node: any) => node.name.startsWith("Document body")), true);
		assert.equal(completeSnapshot.details.nextCursor, undefined, "默认 snapshot 未触发字节上限时不应要求模型翻页");
		assert.equal(completeSnapshot.details.observation.contentCoverage, "scroll-end");
		assert.equal(completeSnapshot.details.observation.contentComplete, true, "默认 snapshot 必须携带全文完成证据");
		assert.ok(Buffer.byteLength(completeSnapshot.content[0].text, "utf8") <= 128 * 1024);
		const fullRead = await tool.execute("browser-full-read", { operation: "read_full", tabName: "docs" }, undefined, undefined, ctx);
		assert.equal(calls.at(-1)?.operation, "read_full", "read_full 兼容入口必须复用同一全文实现");
		assert.equal(fullRead.details.observation.contentCoverage, "scroll-end");
		assert.equal(fullRead.details.observation.contentComplete, true);
		assert.equal(fullRead.details.observation.scanSteps, 7);
		assert.equal(fullRead.details.observation.scrolledContainers, 1);
		const visibleSnapshot = await tool.execute("browser-visible-snapshot", { operation: "snapshot_visible", tabName: "docs" }, undefined, undefined, ctx);
		assert.equal(calls.at(-1)?.operation, "snapshot", "snapshot_visible 才允许只读取当前渲染 DOM");
		assert.equal(visibleSnapshot.details.observation.contentCoverage, "rendered-dom");
		assert.equal(visibleSnapshot.details.observation.contentComplete, false);
		assert.equal(visibleSnapshot.details.observation.nodes.some((node: any) => node.name.startsWith("Wiki navigation")), true);
		await t.test("snapshot_visible forwards queries and preserves Relay evidence across pagination", async () => {
			const query = async (params: Record<string, unknown>) => tool.execute("visible-query", { operation: "snapshot_visible", tabName: "docs", ...params }, undefined, undefined, ctx);
			const match = await query({ text: "NAVIGATION 29", role: "row" });
			assert.deepEqual(match.details.observation.nodes, [visibleSnapshot.details.observation.nodes[28]]);
			assert.deepEqual(match.details.selection, { text: "NAVIGATION 29", role: "row", sourceNodes: 40, scannedAxNodes: 30, scanTruncated: false, matchesTruncated: false });
			assert.equal(match.details.observation.contentCoverage, "rendered-dom");
			assert.equal(match.details.observation.contentComplete, false);
			assert.equal(match.details.observation.documentGeneration, visibleSnapshot.details.observation.documentGeneration);
			assert.equal(match.details.observation.observationEpoch, visibleSnapshot.details.observation.observationEpoch);
			assert.notEqual(match.details.observation.digest, visibleSnapshot.details.observation.digest);
			assert.ok(match.content[0].text.length < visibleSnapshot.content[0].text.length / 2);
			assert.deepEqual(calls.at(-1), { operation: "snapshot", payload: { tabName: "docs", text: "NAVIGATION 29", role: "row" } }, "query must reach Relay before truncation");
			assert.equal(visibleSnapshot.details.selection, undefined);
			assert.equal((await query({ text: "navigation 29", role: "button" })).details.availableNodes, 0, "predicates use AND");
			assert.equal((await query({ text: "Visible body" })).details.availableNodes, 10);
			assert.equal((await query({ role: "ROW" })).details.availableNodes, 0, "role is exact and case-sensitive");
			const paged = await query({ role: "document-text", limit: 3 });
			assert.equal(paged.details.availableNodes, 10);
			const nodes = [...paged.details.observation.nodes];
			let cursor = paged.details.nextCursor;
			const beforePages = calls.length;
			while (cursor) {
				const page = await query({ cursor, limit: 3 });
				assert.deepEqual(page.details.selection, paged.details.selection);
				assert.equal(page.details.observation.digest, paged.details.observation.digest);
				nodes.push(...page.details.observation.nodes);
				cursor = page.details.nextCursor;
			}
			assert.equal(calls.length, beforePages, "cursor reads the same observation without another scan");
			assert.deepEqual(nodes, visibleSnapshot.details.observation.nodes.slice(30));
			assert.ok(nodes.every((node: any) => node.role === "document-text" && node.ref.startsWith("txt_")), "text refs remain read-only");
			fixture.state.visibleTruncated = true;
			const absent = await query({ text: "not in this observation" });
			assert.equal(absent.details.availableNodes, 0);
			assert.equal(absent.details.observation.truncated, true, "no match must not hide source truncation");
			assert.equal(absent.details.observation.contentComplete, false);
			fixture.state.visibleTruncated = false;
			for (fixture.state.queryReceipt of ["missing", "mismatch"]) {
				await assert.rejects(() => query({ text: "Visible body" }), /query.*缺失或不匹配/u, "never silently use a legacy unfiltered receipt");
			}
			fixture.state.queryReceipt = "valid";
			tabs.get("docs")!.documentGeneration += 1;
			const fresh = await query({ role: "row" });
			assert.equal(fresh.details.observation.documentGeneration, match.details.observation.documentGeneration + 1, "new query must not reuse a cached observation");
			tabs.get("docs")!.documentGeneration -= 1;
			const beforeInvalid = calls.length;
			for (const params of [{ text: "" }, { text: "x".repeat(257) }, { role: "" }, { role: "x".repeat(129) }, { text: "a\u0000b" }, { cursor: "existing-cursor", role: "row" }, { operation: "read_full", text: "body" }, { operation: "open", tabName: "bad", url: "https://example.test", role: "row" }]) {
				await assert.rejects(() => query(params), /text|role|snapshot_visible|cursor/u);
			}
			assert.equal(calls.length, beforeInvalid, "invalid selectors must not dispatch");
		});
		const snapshot = await tool.execute("browser-no-ui-snapshot", { operation: "snapshot", tabName: "docs", limit: 30 }, undefined, undefined, ctx);
		assert.equal(snapshot.details.observation.tabName, "docs");
		assert.match(String(snapshot.details.nextCursor), /^pi1_browser_cursor_/u);
		assert.ok(Buffer.byteLength(snapshot.content[0].text, "utf8") <= 128 * 1024, "显式 limit 必须保留分页能力");
		const snapshotRelayCalls = calls.filter((call) => call.operation === "read_full").length;
		const nextPage = await tool.execute("browser-no-ui-snapshot-next", { operation: "snapshot", tabName: "docs", cursor: snapshot.details.nextCursor, limit: 30 }, undefined, undefined, ctx);
		assert.ok(nextPage.details.offset > 0, "cursor 必须进入下一页而不是 schema 校验失败");
		assert.equal(calls.filter((call) => call.operation === "read_full").length, snapshotRelayCalls, "cursor 翻页必须复用同一份 observation，不能重新扫描动态页面");
		assert.equal(fixture.confirms, 0);
		for (const handler of browser.handlers.get("session_before_switch") ?? []) await handler({ type: "session_before_switch" }, ctx);
		assert.equal(calls.at(-1)?.operation, "close", "正常 session 切换必须显式关闭 agent-owned 标签");

	} finally {
		await fixture.cleanup();
	}
});
