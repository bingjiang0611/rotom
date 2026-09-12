import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function findPiDist(): string {
	for (const directory of (process.env.PATH ?? "").split(":")) {
		const candidate = join(directory, "pi");
		if (existsSync(candidate)) return dirname(realpathSync(candidate));
	}
	throw new Error("测试环境 PATH 中找不到 pi");
}

function findPiDependency(piDist: string, relativePath: string): string {
	let directory = piDist;
	for (;;) {
		const candidate = join(directory, "node_modules", relativePath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`无法从 Pi dist 解析依赖：${relativePath}`);
		directory = parent;
	}
}

test("browser relay：活动标签可 claim、直接交互、敏感输入放行并保留 readback", async (t) => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-extension-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const sessionUrl = pathToFileURL(join(piDist, "core/session-manager.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([import(loaderUrl), import(sessionUrl)]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const loaded = await loadExtensions([], workspace);
	assert.deepEqual(loaded.errors, []);
	const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const tabs = new Map<string, { tabId: number; url: string; documentGeneration: number; current: boolean; browserActive: boolean; ownership: "agent" | "claimed"; relayAttached: boolean }>();
	let closed = false;
	let interactFailure: string | undefined;
	const relay = {
		get closed() { return closed; },
		close() { closed = true; },
		async request(operation: string, payload: Record<string, unknown>) {
			calls.push({ operation, payload });
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [...tabs.entries()].map(([name, tab]) => ({ name, ...tab, title: "password=must-not-reach-model", status: "complete" })) };
			if (operation === "recover") {
				const name = String(payload.tabName); const tab = tabs.get(name); assert.ok(tab);
				return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name, ...tab, title: "", status: "complete" }] };
			}
			if (operation === "open") {
				for (const tab of tabs.values()) tab.current = false;
				const tab = { tabId: 41, url: String(payload.url), documentGeneration: 1, current: true, browserActive: false, ownership: "agent" as const, relayAttached: true };
				tabs.set(String(payload.tabName), tab);
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: payload.tabName, ...tab, observationEpoch: 1, title: "safe title", status: "complete", nodes: [{ ref: "ax_1_1", role: "textbox", name: "Authorization: Bearer secret-token", states: [] }, { ref: "ax_1_2", role: "button", name: "Save draft", states: [] }], truncated: false, contentCoverage: "rendered-dom", contentComplete: false };
			}
			if (operation === "discover") return { schemaVersion: 1, kind: "rotom-browser-discovered-tabs", tabs: [{ tabId: 77, url: "https://signed-in.example.test/account?token=secret", title: `password=fixture-${"x".repeat(1_200)}`, status: "complete", browserActive: true }] };
			if (operation === "claim") {
				for (const tab of tabs.values()) tab.current = false;
				const tab = { tabId: Number(payload.tabId), url: "https://signed-in.example.test/account?token=secret", documentGeneration: 1, current: true, browserActive: true, ownership: "claimed" as const, relayAttached: true };
				tabs.set(String(payload.tabName), tab);
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: payload.tabName, ...tab, observationEpoch: 1, title: "Signed in", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false };
			}
			if (operation === "handoff") { const name = String(payload.tabName); const tab = tabs.get(name); tabs.delete(name); return { schemaVersion: 1, kind: "rotom-browser-handoff", tabName: name, tabId: tab?.tabId, preserved: tab?.ownership === "claimed" }; }
			if (operation === "snapshot" || operation === "switch" || operation === "wait" || operation === "read_full") {
				const name = String(payload.tabName ?? [...tabs.keys()][0]); const tab = tabs.get(name); assert.ok(tab);
				const nodes = operation === "read_full"
					? Array.from({ length: 269 }, (_, index) => ({ ref: `txt_1_full_${index + 1}`, role: "document-text", name: `Document body ${index + 1} ${"x".repeat(80)}`, states: ["read-only=true"] }))
					: operation === "snapshot"
						? Array.from({ length: 40 }, (_, index) => ({ ref: index < 30 ? `ax_1_${index + 1}` : `txt_1_${index + 1}`, role: index < 30 ? "row" : "document-text", name: `${index < 30 ? "Wiki navigation" : "Visible body"} ${index + 1}`, states: [] }))
						: [{ ref: "ax_1_1", role: "heading", name: "visible", states: [] }];
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: 2, title: "safe", status: "complete", nodes, truncated: false, contentCoverage: operation === "read_full" ? "scroll-end" : "rendered-dom", contentComplete: operation === "read_full", ...(operation === "read_full" ? { scanSteps: 7, scannedContainers: 1, scrolledContainers: 1 } : {}) };
			}
			if (operation === "screenshot") return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: payload.tabName, tabId: 41, documentGeneration: 1, observationEpoch: 7, viewport: { width: 1280, height: 800, pageX: 0, pageY: 0, scale: 1 }, mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") };
			if (operation === "interact") {
				const name = String(payload.tabName); const tab = tabs.get(name); assert.ok(tab);
				if (interactFailure) { const failure = interactFailure; interactFailure = undefined; throw new Error(failure); }
				const targetEffect = payload.action === "scroll" || payload.x !== undefined ? {} : { target: { observed: true, changed: true, transitions: ["valueLength=0→43"] }, ...(payload.expect ? { expectation: { requested: payload.expect, outcome: payload.expect === "value=nonempty" ? "met" : "unmet" } } : {}) };
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { ...(payload.action === "scroll" ? { dispatch: "mouseWheel", moved: true, scrollScope: payload.targetRef ? "nearest" : "document" } : payload.x !== undefined ? { dispatch: "mouse", coordinate: true, observationEpoch: payload.observationEpoch, hitTested: true } : { dispatch: "mouse" }), ...targetEffect }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: 8, title: "password: fixture-readback", status: "complete", nodes: [{ ref: "alert_1_r_1", role: "page-alert", name: "手机号格式不正确，请填写 11 位数字", states: ["read-only=true"] }, { ref: "ax_1_2", role: "status", name: "Draft saved", states: [] }], truncated: false, contentCoverage: "rendered-dom", contentComplete: false } };
			}
			if (operation === "close") { tabs.clear(); return { schemaVersion: 1, kind: "rotom-browser-close", closed: 1 }; }
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { closed = false; return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	session.appendMessage({ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: Date.now() });
	loaded.runtime.appendEntry = (customType: string, data: unknown) => session.appendCustomEntry(customType, data);
	let activeTools = ["browser_inspect", "browser_interact"];
	loaded.runtime.getActiveTools = () => [...activeTools];
	loaded.runtime.setActiveTools = (value: string[]) => { activeTools = [...value]; };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	let confirms = 0;
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: false, ui: { notify() {}, setStatus() {}, async confirm() { confirms += 1; return true; }, theme: { fg: (_color: string, value: string) => value } } };
	t.after(async () => {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	});
	for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	const tool = browser.tools.get("browser_inspect")?.definition;
	assert.ok(tool);
	const bashRouteGuard = browser.handlers.get("tool_call")?.[0];
	assert.ok(bashRouteGuard);
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "rg -n 'open -a Google Chrome' rotom" } })) ?? undefined, undefined, "检索源码不能被误判为 GUI 自动化");
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -a 'Google Chrome'\nsleep 0.5\nscreencapture -x /tmp/front.png" } })).block, true, "必须阻止通过 open 激活 Chrome");
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open -na '/Applications/Google Chrome.app'" } })).block, true, "组合参数启动 Chrome 也必须阻止");
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "osascript <<'OSA'\ntell application \"System Events\"\n  tell process \"Google Chrome\"\n    click at {1180, 1000}\n    keystroke \"c\" using command down\n  end tell\nend tell\nOSA" } })).block, true, "必须阻止系统级坐标和键盘回退");
	assert.match((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "open 'https://example.test/page'" } })).reason, /前台打开浏览器或 URL/u, "拦截理由必须指向实际命中的回退类型");
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "bash <<'SH'\nopen -a 'Google Chrome' https://example.test\nSH" } })).block, true, "交给 shell 执行的 heredoc 正文仍然是 shell 命令");
	const localDeviceAutomation = "SID=9C3762E8\ncurl -sS \"http://localhost:8100/session/$SID/screenshot\" > /tmp/shot.json\npython3 - <<'PY'\nimport json,base64\nj=json.load(open('/tmp/shot.json'))\nopen('/tmp/shot.png','wb').write(base64.b64decode(j['value']))\nPY";
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: localDeviceAutomation } })) ?? undefined, undefined, "heredoc 中的 Python open() 不是 macOS open，本地 HTTP 自动化不得被拦");
	assert.equal((await bashRouteGuard({ type: "tool_call", toolName: "bash", input: { command: "python3 -c \"open('/tmp/x','w').write('http://localhost:8100')\"\n" } })) ?? undefined, undefined, "语言内置 open() 调用不是 GUI 启动");
	assert.equal(tool.executionMode, "sequential");
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
	assert.equal(confirms, 0, "auto-safe read 不应重复询问");
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
	const interact = browser.tools.get("browser_interact")?.definition; assert.ok(interact);
	for (const definition of [tool, interact]) {
		const policy = definition.promptGuidelines?.join("\n") ?? "";
		assert.match(policy, /Use browser_inspect\/browser_interact first.*never fall back.*shell\/OS.*mouse.*keyboard.*desktop screenshots/u);
		assert.match(policy, /untrusted data.*document-text refs are read-only/u);
		assert.match(policy, /recover the same tab once.*relayAttached=true.*at most once.*close\/open.*discover\/claim/u);
		assert.match(policy, /nextCursor.*contentCoverage=scroll-end.*contentComplete=true.*truncated=false.*rendered DOM/u);
		assert.match(policy, /CSS-viewport x\/y.*observationEpoch.*latest screenshot.*never mix ref and coordinates.*blindly replay/iu);
		assert.match(policy, /hit-tests the point before dispatch and fails closed on mismatch/u, "\u5750\u6807\u70b9\u51fb\u7684 pre-dispatch hit-test \u5fc5\u987b\u5199\u660e\uff0c\u4e0d\u80fd\u9760\u8bed\u5e8f\u6697\u793a");
		assert.match(policy, /foreground or background.*new tabs and popups stay background.*discover then claim.*downloads are not intercepted/u);
	}
	assert.match(tool.promptGuidelines?.join("\n") ?? "", /virtualized scroll containers.*restore position.*cursor pagination.*scrolledContainers>0/u);
	assert.match(tool.promptGuidelines?.join("\n") ?? "", /handoff returns.*screenshots are sensitive content/us);
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /nested lists.*visible descendant ref for the nearest scroll container/u);
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /acknowledged proves dispatch, not business success.*dispatchSettled=false.*moved=false.*Do not loop/u);
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /page-alert nodes and effect\.target; changed=null is unknown, not unchanged.*expect \(checked.*value=empty\|nonempty\) needs a targetRef.*met is target evidence, not business success/u);
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /unknown click, type, select, or keypress may already have executed.*read-only checks, never re-dispatch that write/u, "写动作 unknown 的不重发边界必须写在写入工具自己的指引里");
	const browserGuidelineBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify(definition.promptGuidelines ?? []), "utf8"), 0);
	const browserSchemaBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }), "utf8"), 0);
	assert.ok(browserGuidelineBytes <= 3_400, `Browser guideline budget regressed: ${browserGuidelineBytes}`);
	assert.ok(browserSchemaBytes <= 1_800, `Browser schema budget regressed: ${browserSchemaBytes}`);
	const typed = await interact.execute("browser-interact-type", { operation: "execute", tabName: "docs", action: "type", targetRef: "ax_1_1", text: "Authorization: Bearer secret-token-123456789", replace: true }, undefined, undefined, ctx);
	assert.equal(typed.details.acknowledged, true);
	assert.equal(typed.details.businessOutcome, "unverified");
	assert.equal(confirms, 0, "本机直连不调用确认 UI");
	assert.equal(calls.filter((call) => call.operation === "interact").length, 1);
	assert.equal(calls.find((call) => call.operation === "interact")?.payload.text, "Authorization: Bearer secret-token-123456789", "敏感输入必须直接传给可信本机 relay");
	assert.equal(JSON.stringify(session.getBranch()).includes("secret-token-123456789"), false, "interaction audit 仍不得持久化输入正文");
	assert.equal(typed.details.readback.observation.title, "password: fixture-readback");
	assert.match(typed.content[0].text, /password: fixture-readback/u);
	assert.equal(JSON.stringify(session.getBranch()).includes("fixture-readback"), false, "interaction audit 不记录 readback 正文");
	assert.equal(typed.details.readback.observation.nodes[0].role, "page-alert", "校验错误必须排在 readback 正文之前");
	assert.deepEqual(typed.details.effect.target, { observed: true, changed: true, transitions: ["valueLength=0→43"] });
	const expected = await interact.execute("browser-interact-expect", { operation: "execute", tabName: "docs", action: "type", targetRef: "ax_1_1", text: "draft", expect: "value=nonempty" }, undefined, undefined, ctx);
	assert.deepEqual(expected.details.effect.expectation, { requested: "value=nonempty", outcome: "met" });
	assert.equal(expected.details.businessOutcome, "unverified", "expect 满足是目标级证据，不能升级成业务成功");
	assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.expect, "value=nonempty");
	assert.equal(session.getBranch().some((entry: any) => entry.data?.kind === "rotom-browser-interaction-terminal" && entry.data?.expectationOutcome === "met" && entry.data?.targetChanged === true), true, "audit 只记录期望结果与目标是否变化这类 metadata");
	await assert.rejects(() => interact.execute("browser-interact-expect-scroll", { operation: "execute", tabName: "docs", action: "scroll", direction: "down", expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
	await assert.rejects(() => interact.execute("browser-interact-expect-syntax", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2", expect: "document.title" }, undefined, undefined, ctx), /interaction expect must be/u, "非法判据必须在本地拒绝，不发到 relay");
	await assert.rejects(() => interact.execute("browser-interact-expect-coordinate", { operation: "execute", tabName: "docs", action: "click", x: 10, y: 10, observationEpoch: 7, expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
	interactFailure = "browser relay interact timeout";
	await assert.rejects(() => interact.execute("browser-interact-write-timeout", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx), /unknown.*只读核对.*禁止重发/su, "写动作 unknown 后必须禁止重发");
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /keypress requires targetRef.*Enter \(Return\).*submit forms/u);
	assert.deepEqual(interact.parameters.properties.key.enum, ["Enter", "Tab", "Escape"]);
	for (const key of ["Enter", "Tab", "Escape"]) {
		const pressed = await interact.execute(`browser-key-${key}`, { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key, expect: "value=empty" }, undefined, undefined, ctx);
		assert.equal(pressed.details.acknowledged, true);
		assert.equal(pressed.details.businessOutcome, "unverified");
		assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.key, key);
	}
	const beforeInvalid = calls.filter((call) => call.operation === "interact").length;
	for (const invalid of [{ key: undefined }, { key: "Return" }, { key: "Meta+Enter" }, { targetRef: undefined }, { text: "\n" }, { replace: true }, { option: "x" }, { direction: "down" }, { amount: 10 }, { x: 10, y: 10 }]) {
		await assert.rejects(() => interact.execute("browser-key-invalid", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "Enter", ...invalid }, undefined, undefined, ctx));
	}
	await assert.rejects(() => interact.execute("browser-click-key", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_1", key: "Enter" }, undefined, undefined, ctx), /key 仅允许/u);
	assert.equal(calls.filter((call) => call.operation === "interact").length, beforeInvalid);
	interactFailure = "browser relay interact timeout";
	await assert.rejects(() => interact.execute("browser-key-timeout", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "Enter" }, undefined, undefined, ctx), /unknown.*只读核对.*禁止重发/su);
	assert.equal(calls.filter((call) => call.operation === "interact").length, beforeInvalid + 1, "未知按键只派发一次");
	interactFailure = "browser relay interact timeout";
	await assert.rejects(() => interact.execute("browser-interact-scroll-timeout", { operation: "execute", tabName: "docs", action: "scroll", direction: "down" }, undefined, undefined, ctx), /recover 后最多重试一次/u, "幂等 scroll 仍允许原动作重试一次");
	tabs.get("docs")!.browserActive = true;
	const clicked = await interact.execute("browser-interact-active-click", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx);
	assert.equal(clicked.details.acknowledged, true, "活动标签必须允许直接 dispatch");
	const screenshot = await tool.execute("browser-screenshot", { operation: "screenshot", tabName: "docs" }, undefined, undefined, ctx);
	assert.equal(screenshot.details.observationEpoch, 7);
	assert.deepEqual(screenshot.details.viewport, { width: 1280, height: 800, pageX: 0, pageY: 0, scale: 1 });
	assert.equal(screenshot.content.some((part: any) => part.type === "image" && part.mimeType === "image/jpeg"), true, "坐标 fallback 必须让模型看到与 epoch 绑定的当前截图");
	const coordinateClicked = await interact.execute("browser-interact-coordinate-click", { operation: "execute", tabName: "docs", action: "click", x: 640, y: 400, observationEpoch: 7 }, undefined, undefined, ctx);
	assert.equal(coordinateClicked.details.effect.coordinate, true);
	const coordinatePayload = calls.filter((call) => call.operation === "interact").at(-1)?.payload;
	assert.deepEqual({ x: coordinatePayload?.x, y: coordinatePayload?.y, observationEpoch: coordinatePayload?.observationEpoch, documentGeneration: coordinatePayload?.documentGeneration, targetRef: coordinatePayload?.targetRef }, { x: 640, y: 400, observationEpoch: 7, documentGeneration: 1, targetRef: undefined }, "坐标 click 必须绑定最新 screenshot epoch 与文档 generation");
	await assert.rejects(() => interact.execute("browser-interact-mixed-click", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2", x: 640, y: 400, observationEpoch: 7 }, undefined, undefined, ctx), /互斥/u);
	await assert.rejects(() => interact.execute("browser-interact-coordinate-type", { operation: "execute", tabName: "docs", action: "type", x: 640, y: 400, observationEpoch: 7, text: "no" }, undefined, undefined, ctx), /仅允许 click/u);
	const confirmationsBeforeScroll = confirms;
	const scrolled = await interact.execute("browser-interact-scroll", { operation: "execute", tabName: "docs", action: "scroll", targetRef: "ax_1_2", direction: "down", amount: 40_000 }, undefined, undefined, ctx);
	assert.equal(scrolled.details.effect.scrollScope, "nearest");
	assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.targetRef, "ax_1_2");
	assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.amount, 40_000);
	assert.equal(confirms, confirmationsBeforeScroll, "scroll 也不调用确认 UI");
	await assert.rejects(() => tool.execute("browser-file", { operation: "open", tabName: "bad", url: "file:///etc/passwd" }, undefined, undefined, ctx), /http|https|URL/u);
	assert.equal(calls.some((call) => call.payload.tabName === "bad"), false);
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
	const snapshot = await tool.execute("browser-no-ui-snapshot", { operation: "snapshot", tabName: "docs", limit: 30 }, undefined, undefined, ctx);
	assert.equal(snapshot.details.observation.tabName, "docs");
	assert.match(String(snapshot.details.nextCursor), /^pi1_browser_cursor_/u);
	assert.ok(Buffer.byteLength(snapshot.content[0].text, "utf8") <= 128 * 1024, "显式 limit 必须保留分页能力");
	const snapshotRelayCalls = calls.filter((call) => call.operation === "read_full").length;
	const nextPage = await tool.execute("browser-no-ui-snapshot-next", { operation: "snapshot", tabName: "docs", cursor: snapshot.details.nextCursor, limit: 30 }, undefined, undefined, ctx);
	assert.ok(nextPage.details.offset > 0, "cursor 必须进入下一页而不是 schema 校验失败");
	assert.equal(calls.filter((call) => call.operation === "read_full").length, snapshotRelayCalls, "cursor 翻页必须复用同一份 observation，不能重新扫描动态页面");
	assert.equal(confirms, 0);
	for (const handler of browser.handlers.get("session_before_switch") ?? []) await handler({ type: "session_before_switch" }, ctx);
	assert.equal(calls.at(-1)?.operation, "close", "正常 session 切换必须显式关闭 agent-owned 标签");
});

test("Relay-first launch gate: local evidence, one attempt, no replay or stale permission", async (t) => {
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const { BrowserRelayUnavailableErrorV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/browser-relay.ts")) as any;
	const unavailable = () => new BrowserRelayUnavailableErrorV1(new Error("fixture missing socket"));
	async function fixture() {
		const tools = new Map<string, any>(), handlers = new Map<string, any>();
		const notices: string[] = [];
		let connectError: Error | undefined, requestError: Error | undefined;
		let delay: Promise<any> | undefined;
		const connectEntered = Promise.withResolvers<void>();
		let active = ["browser_inspect", "browser_interact", "launch_browser"];
		let requests = 0;
		const relay = { closed: false, close() { this.closed = true; }, async request() {
			requests += 1;
			if (requestError) throw requestError;
			return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [] };
		} };
		createBrowserRelayExtensionV1({
			async connectRelay() { if (delay) { connectEntered.resolve(); return delay; } if (connectError) throw connectError; relay.closed = false; return relay; },
			async openArtifactStore() { throw new Error("unexpected artifact store"); },
		})({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on(name: string, handler: any) { handlers.set(name, handler); }, appendEntry() {}, getActiveTools() { return active; } });
		const ctx: any = { sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [] }, hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
		await handlers.get("session_start")({}, ctx);
		return {
			ctx, notices, relay, connectEntered: connectEntered.promise, get requests() { return requests; },
			failConnect(error?: Error) { connectError = error; relay.closed = true; },
			failRequest(error: Error) { requestError = error; },
			delayConnect(value: Promise<any>) { delay = value; },
			select(value: string[]) { active = value; },
			emit: (name: string) => handlers.get(name)({}, ctx),
			launch: () => handlers.get("tool_call")({ toolName: "launch_browser", input: {} }, ctx),
			inspect: (params = { operation: "tabs" }, signal?: AbortSignal) => tools.get("browser_inspect").execute("fixture", params, signal, undefined, ctx),
		};
	}
	await t.test("blocks launch first, healthy Relay and empty tabs", async () => {
		const f = await fixture();
		assert.equal((await f.launch()).block, true);
		await f.inspect();
		assert.equal((await f.launch()).block, true);
		assert.equal(f.notices.length, 0);
	});
	await t.test("typed unavailable permits one launch, never an implicit spawn or second attempt", async () => {
		const f = await fixture(); f.failConnect(unavailable());
		await assert.rejects(f.inspect(), /未派发.*launch_browser.*不继承 Chrome 登录态/u);
		assert.equal(f.requests, 0);
		assert.equal(f.notices.length, 0);
		assert.equal(await f.launch(), undefined);
		assert.match(f.notices[0], /不继承 Chrome 登录态/u);
		assert.equal((await f.launch()).block, true);
		await assert.rejects(f.inspect());
		assert.equal((await f.launch()).block, true, "another failed probe cannot authorize a retry of an unknown launch");
	});
	for (const message of ["browser relay 不可用", "browser relay hello timeout", "debugger is not attached", "stale ref", "permission denied", "browser relay 版本过旧", "response binding 无效", "Sign in to continue"]) {
		await t.test(`untyped error is not authority: ${message}`, async () => {
			const f = await fixture(); f.failConnect(new Error(message));
			await assert.rejects(f.inspect()); assert.equal((await f.launch()).block, true);
		});
	}
	await t.test("request failure followed by unavailable reconnect cannot unlock fallback", async () => {
		const f = await fixture(); f.failRequest(new Error("browser relay open timeout; unknown"));
		await assert.rejects(f.inspect({ operation: "open", tabName: "docs", url: "https://example.test" } as any));
		f.failConnect(unavailable());
		await assert.rejects(f.inspect()); assert.equal((await f.launch()).block, true);
	});
	await t.test("successful probe revokes a previous permit", async () => {
		const f = await fixture(); f.failConnect(unavailable()); await assert.rejects(f.inspect());
		f.failConnect(); await f.inspect(); assert.equal((await f.launch()).block, true);
	});
	for (const event of ["before_agent_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
		await t.test(`${event} retires permission and late failures`, async () => {
			const f = await fixture(); f.failConnect(unavailable()); await assert.rejects(f.inspect());
			const delayed = Promise.withResolvers<any>(); f.delayConnect(delayed.promise);
			const pending = f.inspect(); const rejected = assert.rejects(pending);
			await f.connectEntered; await f.emit(event); delayed.reject(unavailable()); await rejected;
			assert.equal((await f.launch()).block, true);
		});
	}
	await t.test("cancelled connect and cancelled launch cannot grant permission", async () => {
		const f = await fixture(); const delayed = Promise.withResolvers<any>(); f.delayConnect(delayed.promise);
		const controller = new AbortController(); const pending = f.inspect(undefined, controller.signal); const rejected = assert.rejects(pending);
		await f.connectEntered; controller.abort(); delayed.reject(unavailable()); await rejected;
		assert.equal((await f.launch()).block, true);
		const g = await fixture(); g.failConnect(unavailable()); await assert.rejects(g.inspect());
		g.ctx.signal = AbortSignal.abort(); assert.equal((await g.launch()).block, true);
	});
	await t.test("explicit tool selection is preserved", async () => {
		const f = await fixture(); f.select(["launch_browser"]);
		assert.equal(await f.launch(), undefined);
	});
});

test("/browser: explicit commands, local-only diagnostics, cancellation and ownership", async (t) => {
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const { BrowserRelayUnavailableErrorV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/browser-relay.ts")) as any;
	async function fixture(overrides: Record<string, unknown> = {}, realIO = false) {
		const commands = new Map<string, any>(), handlers = new Map<string, any>();
		const notices: string[] = [], messages: Array<{ text: string; options: unknown }> = [], calls: string[] = [];
		let confirmed = false, choice: string | undefined, input: string | undefined;
		let active = ["browser_inspect", "browser_interact"], idle = true, sessionId = "command-session";
		let resolveConfirm: (() => Promise<boolean>) | undefined;
		let resolveInput: (() => Promise<string | undefined>) | undefined;
		const ctx: any = { hasUI: true, mode: "tui", isIdle: () => idle,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
			ui: {
				notify(message: string) { notices.push(message); },
				async select(_title: string, options: string[]) { return options.find((option) => option.startsWith(choice ?? "absent")); },
				async confirm() { calls.push("confirm"); return resolveConfirm ? resolveConfirm() : confirmed; },
				async input() { return resolveInput ? resolveInput() : input; },
			},
		};
		createBrowserRelayExtensionV1({
			async connectRelay() { throw new Error("command must not use live session relay"); },
			async openArtifactStore() { throw new Error("command must not create artifacts"); },
			commands: {
				platform: "darwin",
				...(!realIO ? {
					async runInstaller(operation: string) { calls.push(operation); return operation === "status" ? { installed: true } : { status: "installed" }; },
					async probeRelay() { calls.push("probe"); },
				} : {}),
				...overrides,
			},
		})({
			registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command); },
			on(name: string, handler: unknown) { handlers.set(name, handler); },
			appendEntry() { throw new Error("command must not persist metadata to session"); },
			sendMessage() { throw new Error("diagnostics must not enter model context"); },
			sendUserMessage(text: string, options: unknown) { messages.push({ text, options }); },
			getActiveTools() { return active; }, setActiveTools() { throw new Error("must not override tool selection"); },
		});
		await handlers.get("session_start")({}, ctx);
		const command = commands.get("browser"); assert.ok(command);
		return { command, ctx, calls, notices, messages,
			run: (args = "") => command.handler(args, ctx),
			emit: (event: string, payload: unknown = {}) => handlers.get(event)(payload, ctx),
			confirm(value = true) { confirmed = value; }, pick(value: string) { choice = value; },
			input(value: string) { input = value; }, selectTools(value: string[]) { active = value; },
			busy() { idle = false; }, switchId() { sessionId = "replacement-session"; },
			waitConfirm(fn: () => Promise<boolean>) { resolveConfirm = fn; },
			waitInput(fn: () => Promise<string | undefined>) { resolveInput = fn; },
		};
	}
	await t.test("startup, menu cancellation, help and invalid arguments have no IO/model effects", async () => {
		const f = await fixture(); assert.deepEqual(f.calls, []);
		await f.run(); assert.deepEqual(f.calls, []); assert.deepEqual(f.notices, []);
		await f.run("help"); assert.match(f.notices.at(-1)!, /chrome:\/\/extensions/u);
		for (const bad of ["uninstall", "install extra", "status extra", "unknown", "x".repeat(4097), "use a\0b"]) await f.run(bad);
		assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []);
		assert.deepEqual(f.command.getArgumentCompletions("st").map((item: any) => item.value), ["status"]);
		assert.equal(f.command.getArgumentCompletions("use private task"), null);
	});
	await t.test("install needs explicit confirmation and reads back once; never probes or calls a model", async () => {
		const f = await fixture(); await f.run("install"); assert.deepEqual(f.calls, ["confirm"]);
		f.calls.length = 0; f.confirm(); await f.run("install");
		assert.deepEqual(f.calls, ["confirm", "install", "status"]);
		assert.match(f.notices.at(-1)!, /注册已回读确认.*仍需手动/su);
		assert.deepEqual(f.messages, []);
		const menu = await fixture(); menu.pick("安装 / 更新"); menu.confirm(); await menu.run();
		assert.deepEqual(menu.calls, ["confirm", "install", "status"]);
	});
	for (const failure of ["timeout after write", "permission denied", "cancelled", "secret child stderr"]) {
		await t.test(`installer error stays unknown without retry: ${failure}`, async () => {
			let writes = 0;
			const f = await fixture({ async runInstaller() { writes += 1; throw new Error(failure); } });
			f.confirm(); await f.run("install"); assert.equal(writes, 1);
			assert.match(f.notices.at(-1)!, /unknown.*未自动重试或回滚/u);
			assert.ok(!f.notices.join("\n").includes(failure));
		});
	}
	for (const value of [{}, { installed: false }, { installed: "true" }]) {
		await t.test(`bad installation readback ${JSON.stringify(value)} cannot become success`, async () => {
			const f = await fixture({ async runInstaller(operation: string) { return operation === "install" ? { status: "installed" } : value; } });
			f.confirm(); await f.run("install"); assert.match(f.notices.at(-1)!, /unknown/u);
		});
	}
	await t.test("status distinguishes registration and connection, never shares diagnostics with model or fallback gate", async () => {
		const f = await fixture({ async runInstaller() { return { installed: false, title: "page-controlled injection", extensionDir: "untrusted path" }; } });
		await f.run("status"); assert.deepEqual(f.calls, ["probe"]);
		assert.match(f.notices.at(-1)!, /未确认匹配.*已连接.*未访问页面/su);
		assert.ok(!f.notices.join("\n").includes("page-controlled")); assert.ok(!f.notices.join("\n").includes("untrusted path"));
		assert.deepEqual(f.messages, []);
	});
	await t.test("typed missing socket is unavailable; generic timeout/old protocol is unknown", async () => {
		for (const [error, expected] of [[new BrowserRelayUnavailableErrorV1(new Error("missing")), /不可用/u], [new Error("protocol failure secret"), /unknown/u]]) {
			const f = await fixture({ async probeRelay() { throw error; } }); await f.run("status");
			assert.match(f.notices.at(-1)!, expected as RegExp); assert.ok(!f.notices.join("\n").includes("secret"));
			f.selectTools(["browser_inspect", "browser_interact", "launch_browser"]);
			assert.equal((await f.emit("tool_call", { toolName: "launch_browser", input: {} })).block, true);
		}
		const f = await fixture({ async runInstaller() { throw new Error("bad status"); } }); await f.run("status");
		assert.match(f.notices.at(-1)!, /Native host：unknown.*Chrome Relay：已连接/su);
	});
	await t.test("use submits exactly one bounded user task, with no template expansion or direct browser action", async () => {
		const f = await fixture(); await f.run("use 打开 example.com，读标题");
		assert.equal(f.messages.length, 1); assert.match(f.messages[0].text, /用户任务：\n打开 example.com，读标题/u);
		assert.deepEqual(f.messages[0].options, { expandPromptTemplates: false }); assert.deepEqual(f.calls, []);
		const menu = await fixture(); menu.pick("开始使用"); menu.input("/browser install"); await menu.run();
		assert.equal(menu.messages.length, 1); assert.deepEqual(menu.calls, []);
		assert.match(menu.messages[0].text, /用户任务：\n\/browser install/u);
	});
	await t.test("cancelled/oversized use, busy agent and excluded tools do not submit or enable anything", async () => {
		const f = await fixture(); await f.run("use"); assert.deepEqual(f.messages, []);
		f.input("文".repeat(2000)); await f.run("use"); assert.deepEqual(f.messages, []);
		f.selectTools(["launch_browser"]); await f.run("use read a page"); assert.deepEqual(f.messages, []);
		f.busy(); await f.run("use read a page"); await f.run("install"); assert.deepEqual(f.calls, []);
		f.ctx.hasUI = false; await assert.rejects(f.run("install"), /需要交互界面/u); assert.deepEqual(f.calls, []);
	});
	await t.test("unsupported installer platform has no subprocess or probe", async () => {
		const f = await fixture({ platform: "linux" }); await f.run("install"); await f.run("status");
		assert.deepEqual(f.calls, []); assert.match(f.notices.at(-1)!, /仅支持 macOS/u);
	});
	for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) {
		await t.test(`${event} cancels old confirmations before any write`, async () => {
			const f = await fixture(), entered = Promise.withResolvers<void>(), response = Promise.withResolvers<boolean>();
			f.waitConfirm(() => { entered.resolve(); return response.promise; });
			const pending = f.run("install"); await entered.promise; await f.emit(event); response.resolve(true); await pending;
			assert.deepEqual(f.calls, ["confirm"]); assert.deepEqual(f.messages, []); assert.deepEqual(f.notices, []);
		});
	}
	await t.test("late input cannot submit into a changed session or newly busy agent", async () => {
		for (const change of ["session", "busy"]) {
			const f = await fixture(), entered = Promise.withResolvers<void>(), response = Promise.withResolvers<string>();
			f.waitInput(() => { entered.resolve(); return response.promise; });
			const pending = f.run("use"); await entered.promise;
			if (change === "session") f.switchId(); else f.busy();
			response.resolve("read a page"); await pending; assert.deepEqual(f.messages, []);
		}
	});
	await t.test("real installer/diagnostic use frozen isolated HOME, not later environment changes", { skip: process.platform !== "darwin" }, async () => {
		// macOS sockaddr_un cannot fit the long default per-user TMPDIR plus the relay suffix.
		const home = await mkdtemp("/tmp/browser-command-home-");
		await mkdir(join(home, "Library", "Application Support"), { recursive: true });
		const previousHome = process.env.HOME;
		let f: Awaited<ReturnType<typeof fixture>>;
		try { process.env.HOME = home; f = await fixture({}, true); }
		finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
		try {
			await f.run("status"); assert.match(f.notices.at(-1)!, /未确认匹配.*不可用/su);
			f.confirm(); await f.run("install"); assert.match(f.notices.at(-1)!, /注册已回读确认/u);
			const manifestPath = join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.rotom.browser_relay.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			assert.equal(manifest.path, join(home, "Library/Application Support/rotom/browser-relay/native-host-launcher.sh"));
			assert.deepEqual(manifest.allowed_origins, ["chrome-extension://kgadcllokaodnoknakblocmhidemimdi/"]);
			await f.run("status"); assert.match(f.notices.at(-1)!, /与当前安装匹配.*不可用/su);
			assert.deepEqual(f.messages, []);
		} finally { await rm(home, { recursive: true, force: true }); }
	});
	await t.test("one command in flight; shutdown aborts IO and suppresses late publication/readback", async () => {
		const entered = Promise.withResolvers<void>(), completed = Promise.withResolvers<unknown>();
		let calls = 0, signal: AbortSignal | undefined;
		const f = await fixture({ async runInstaller(_op: string, input: AbortSignal) { calls += 1; signal = input; entered.resolve(); return completed.promise; } });
		f.confirm(); const pending = f.run("install"); await entered.promise; await f.run("install");
		assert.equal(calls, 1); assert.match(f.notices.at(-1)!, /尚未结束/u); f.notices.length = 0;
		await f.emit("session_shutdown"); assert.equal(signal?.aborted, true);
		completed.resolve({ status: "installed" }); await pending;
		assert.equal(calls, 1); assert.deepEqual(f.notices, []);
	});
});
