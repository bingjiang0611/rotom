import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserIntegrationFixture } from "./browser-test-helpers.ts";

test("browser relay：活动标签可 claim、直接交互、敏感输入放行并保留 readback", async () => {
	const fixture = await createBrowserIntegrationFixture();
	const { browser, session, ctx, tool, bashRouteGuard, calls } = fixture;
	try {
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "rg -n 'open -a Google Chrome' rotom" } })) ?? undefined, undefined, "检索源码不能被误判为 GUI 自动化");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -a 'Google Chrome'\nsleep 0.5\nscreencapture -x /tmp/front.png" } })).block, true, "必须阻止通过 open 激活 Chrome");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -na '/Applications/Google Chrome.app'" } })).block, true, "组合参数启动 Chrome 也必须阻止");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "osascript <<'OSA'\ntell application \"System Events\"\n  tell process \"Google Chrome\"\n    click at {1180, 1000}\n    keystroke \"c\" using command down\n  end tell\nend tell\nOSA" } })).block, true, "必须阻止系统级坐标和键盘回退");
		assert.match((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open 'https://example.test/page'" } })).reason, /前台打开浏览器或 URL/u, "拦截理由必须指向实际命中的回退类型");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "bash <<'SH'\nopen -a 'Google Chrome' https://example.test\nSH" } })).block, true, "交给 shell 执行的 heredoc 正文仍然是 shell 命令");
		const localDeviceAutomation = "SID=9C3762E8\ncurl -sS \"http://localhost:8100/session/$SID/screenshot\" > /tmp/shot.json\npython3 - <<'PY'\nimport json,base64\nj=json.load(open('/tmp/shot.json'))\nopen('/tmp/shot.png','wb').write(base64.b64decode(j['value']))\nPY";
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: localDeviceAutomation } })) ?? undefined, undefined, "heredoc 中的 Python open() 不是 macOS open，本地 HTTP 自动化不得被拦");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "python3 -c \"open('/tmp/x','w').write('http://localhost:8100')\"\n" } })) ?? undefined, undefined, "语言内置 open() 调用不是 GUI 启动");
		// Reads are serialized per tab by the relay, not per session, so one tab's
		// inspection no longer blocks another tab's; writes stay sequential.
		assert.equal(tool.executionMode, "parallel");
		assert.equal((tool.parameters as any).properties.limit.maximum, undefined, "snapshot limit 不应在 tool schema 中设置人工上限");
		const opened = await tool.execute("browser-open", { operation: "open", tabName: "docs", url: "https://example.test/path?token=secret#fragment", limit: 10 }, undefined, undefined, ctx);
		const desktopCapture = await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "screencapture -x /tmp/front.png" } });
		assert.equal(desktopCapture.block, true, "进入 browser route 后不得回退到桌面截图");
		assert.match(desktopCapture.reason, /系统级鼠标\/键盘或桌面截图回退/u, "桌面截图不得复用浏览器启动的理由文案");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: localDeviceAutomation } })) ?? undefined, undefined, "browser route 激活后仍不得误杀本地设备自动化");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -a 'iPhone Mirroring'" } })) ?? undefined, undefined, "非浏览器 GUI 应用不属于浏览器路由边界");
		assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -a Safari" } })).block, true, "browser route 激活后其他浏览器同样不得前台启动");
		assert.equal(calls.filter((call) => call.operation === "open").length, 1);
		assert.equal(opened.details.observation.nodes[0].name, "Authorization: Bearer secret-token");
		assert.match(opened.content[0].text, /Authorization: Bearer secret-token/u, "模型可见文本不再替换凭据形状");
		assert.equal(JSON.stringify(opened.details).includes("token=secret"), false, "URL query/hash 隐藏不受影响");
		const listed = await tool.execute("browser-tabs", { operation: "tabs" }, undefined, undefined, ctx);
		assert.equal(JSON.stringify(listed.details).includes("must-not-reach-model"), false);
		assert.equal(JSON.stringify(listed.details).includes("token=secret"), false);
		const recovered = await tool.execute("browser-recover", { operation: "recover", tabName: "docs" }, undefined, undefined, ctx);
		assert.equal(recovered.details.tabs.length, 1, "recover 回读不得遍历或清理无关标签");
		assert.equal(recovered.details.tabs.find((tab: any) => tab.name === "docs")?.relayAttached, true);
		assert.deepEqual(calls.at(-1), { operation: "recover", payload: { tabName: "docs" } }, "recover 必须只把原 tabName 传给 relay");
		assert.equal(fixture.confirms, 0, "auto-safe read 不应重复询问");
		const discovered = await tool.execute("browser-discover", { operation: "discover" }, undefined, undefined, ctx);
		assert.equal(discovered.details.tabs[0].origin, "https://signed-in.example.test");
		assert.equal(discovered.details.tabs[0].title, `password=fixture-${"x".repeat(1_200)}`.slice(0, 1_024));
		assert.match(discovered.content[0].text, /password=fixture-/u);
		assert.equal(JSON.stringify(discovered.details).includes("token=secret"), false);
		const claimed = await tool.execute("browser-claim", { operation: "claim", tabId: 77, tabName: "account" }, undefined, undefined, ctx);
		assert.equal(claimed.details.observation.tabName, "account");
		const handedOff = await tool.execute("browser-handoff", { operation: "handoff", tabName: "account" }, undefined, undefined, ctx);
		assert.equal(handedOff.details.preserved, true);
		session.appendCustomEntry("rotom-browser-interaction-audit/v1", { schemaVersion: 1, kind: "rotom-browser-interaction-intent", actionId: "pi1_browser_action_recovery", sessionId: session.getSessionId() });
		await tool.execute("browser-recover-pending-intent", { operation: "tabs" }, undefined, undefined, ctx);
		assert.equal(session.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === "rotom-browser-interaction-audit/v1" && entry.data?.kind === "rotom-browser-interaction-terminal" && entry.data?.actionId === "pi1_browser_action_recovery" && entry.data?.status === "unknown"), true, "未闭合 intent 必须恢复为 unknown，不能重放");

	} finally {
		await fixture.cleanup();
	}
});
