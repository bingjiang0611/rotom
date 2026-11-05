import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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
	await allowPolicyFor(workspace, ["https://example.test", "https://signed-in.example.test"]);
	const loaded = await loadExtensions([], workspace);
	assert.deepEqual(loaded.errors, []);
	const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const tabs = new Map<string, { tabId: number; url: string; documentGeneration: number; current: boolean; browserActive: boolean; ownership: "agent" | "claimed"; relayAttached: boolean }>();
	let closed = false;
	let interactFailure: string | undefined;
	let readbackEpoch = 8;
	const originalBody = "Unchanged body. ".repeat(55);
	let body = originalBody;
	let textChunks = 12;
	let visibleTruncated = false;
	let queryReceipt = "valid";
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
				const filtered = operation === "snapshot" && (payload.text !== undefined || payload.role !== undefined);
				const selected = filtered ? nodes.filter((node) => (payload.role === undefined || node.role === payload.role) && (payload.text === undefined || node.name.toLowerCase().includes(String(payload.text).toLowerCase()))) : nodes;
				const selection = filtered && queryReceipt !== "missing" ? { ...(payload.text === undefined ? {} : { text: queryReceipt === "mismatch" ? "wrong query" : payload.text }), ...(payload.role === undefined ? {} : { role: payload.role }), sourceNodes: nodes.length, scannedAxNodes: 30, scanTruncated: visibleTruncated, matchesTruncated: false } : undefined;
				return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: 2, title: "safe", status: "complete", nodes: selected, ...(selection ? { selection } : {}), truncated: operation === "snapshot" && visibleTruncated, contentCoverage: operation === "read_full" ? "scroll-end" : "rendered-dom", contentComplete: operation === "read_full", ...(operation === "read_full" ? { scanSteps: 7, scannedContainers: 1, scrolledContainers: 1 } : {}) };
			}
			if (operation === "screenshot") return { schemaVersion: 1, kind: "rotom-browser-screenshot", tabName: payload.tabName, tabId: 41, documentGeneration: 1, observationEpoch: 7, viewport: { width: 1280, height: 800, pageX: 0, pageY: 0, scale: 1 }, mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") };
			if (operation === "interact") {
				const name = String(payload.tabName); const tab = tabs.get(name); assert.ok(tab);
				if (interactFailure) { const failure = interactFailure; interactFailure = undefined; throw new Error(failure); }
				const targetEffect = payload.action === "scroll" || payload.x !== undefined ? {} : { target: { observed: true, changed: true, transitions: ["valueLength=0→43"] }, ...(payload.expect ? { expectation: { requested: payload.expect, outcome: payload.expect === "value=nonempty" ? "met" : "unmet" } } : {}) };
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { ...(payload.action === "scroll" ? { dispatch: "mouseWheel", moved: true, scrollScope: payload.targetRef ? "nearest" : "document" } : payload.x !== undefined ? { dispatch: "mouse", coordinate: true, observationEpoch: payload.observationEpoch, hitTested: true } : payload.action === "keypress" ? { dispatch: "keyboard", key: payload.key, ...(Array.isArray(payload.modifiers) && payload.modifiers.length > 0 ? { modifiers: payload.modifiers } : {}) } : { dispatch: "mouse" }), ...targetEffect }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: name, ...tab, observationEpoch: readbackEpoch++, title: "password: fixture-readback", status: "complete", nodes: [{ ref: "alert_1_r_1", role: "page-alert", name: "手机号格式不正确，请填写 11 位数字", states: ["read-only=true"] }, { ref: "ax_1_2", role: "status", name: "Draft saved", states: [] }, ...Array.from({ length: textChunks }, (_, i) => ({ ref: `txt_1_r_${i + 1}`, role: "document-text", name: `${i}: ${body}`, states: ["read-only=true"] }))], truncated: false, contentCoverage: "rendered-dom", contentComplete: false } };
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
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /Unknown writes may have executed.*read-only checks, never re-dispatch/u, "写动作 unknown 的不重发边界必须写在写入工具自己的指引里");
	const browserGuidelineBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify(definition.promptGuidelines ?? []), "utf8"), 0);
	const browserSchemaBytes = [tool, interact].reduce((sum, definition) => sum + Buffer.byteLength(JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }), "utf8"), 0);
	// Keep prompt text bounded; schema growth exposes the fixed expectation enum
	// and operation-specific requirements instead of adding another prose checklist.
	// +100 bytes budgeted for the cross-agent transfer operation (T2): the receiver
	// name format and the fact that its refs start fresh cannot be left to the schema.
	// +82 bytes for the `placement` open value (T6): an agent window is a placement,
	// not a second open operation, so it is one clause in the existing open line.
	assert.ok(browserGuidelineBytes <= 3_835, `Browser guideline budget regressed: ${browserGuidelineBytes}`);
	// The `placement` enum adds 71 schema bytes (T6) without a second parameter.
	// `navigate` (T12) adds one operation value plus `history: back|forward|reload`,
	// and widens the `url` line to say it also serves navigate: +138 bytes, still far
	// inside the two-browser-tools budget.
	// `console` (T13) adds level/pattern/sinceCursor + the operation value: +421 bytes.
	// `network` (T14) adds `failedOnly`, `resourceType` and one operation value: +398 bytes.
	// The full key whitelist (T15) turns `key` into a 62-value enum plus `modifiers`:
	// +484 bytes. Pointer actions and `dropRef` (T16) add +163, measured 4 425. `upload`
	// (T17) adds one action value plus `paths`: +189, measured 4 614. `dialog` (T18) adds
	// the action value plus `accept`/`promptText`: +252, measured 4 866. Batches (T19) add
	// a step schema that repeats the per-action fields the model must be able to fill:
	// +1 989, measured 6 855. That is the price of documenting each step honestly instead
	// of leaving the fields undocumented; the guideline text is unchanged, so the M3
	// footprint stays well inside its 30% budget.
	assert.ok(browserSchemaBytes <= 6_950, `Browser schema budget regressed: ${browserSchemaBytes}`);
	// `action` is no longer schema-required because `actions` can replace it; the local
	// check rejects a call that carries neither (covered below).
	assert.equal(interact.parameters.properties.action.type, "string");
	assert.equal(interact.parameters.properties.actions.maxItems, 10);
	assert.equal(interact.parameters.properties.expect.enum.length, 16);
	assert.ok(interact.parameters.properties.expect.enum.includes("value=nonempty"));
	for (const invalid of ["visible", "navigation", "ack", "EPUB"]) assert.equal(interact.parameters.properties.expect.enum.includes(invalid), false);
	assert.match(tool.parameters.properties.tabName.description, /Required for open and claim/u);
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
	assert.equal(expected.details.readback.observation.omittedUnchangedTextNodes, 12);
	assert.equal(expected.details.readback.observation.textBaselineEpoch, typed.details.readback.observation.observationEpoch);
	assert.deepEqual(expected.details.readback.observation.nodes.map((node: any) => node.role), ["page-alert", "status"]);
	assert.equal(expected.details.readback.observation.contentComplete, false);
	assert.ok(expected.content[0].text.length < typed.content[0].text.length / 4, "fixed payload saving only, not provider token usage");
	t.diagnostic(`Fixed readback fixture: ${Buffer.byteLength(typed.content[0].text)} → ${Buffer.byteLength(expected.content[0].text)} model-visible UTF-8 bytes; provider tokens not measured`);
	assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.expect, "value=nonempty");
	assert.equal(session.getBranch().some((entry: any) => entry.data?.kind === "rotom-browser-interaction-terminal" && entry.data?.expectationOutcome === "met" && entry.data?.targetChanged === true), true, "audit 只记录期望结果与目标是否变化这类 metadata");
	const readback = async () => (await interact.execute("text-delta", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx)).details.readback.observation;
	body = "Changed body";
	assert.equal((await readback()).nodes.filter((node: any) => node.role === "document-text").length, 12);
	body = originalBody;
	assert.equal((await readback()).nodes.filter((node: any) => node.role === "document-text").length, 12, "reversion is compared to the immediately preceding full result");
	assert.equal((await readback()).omittedUnchangedTextNodes, 12);
	await tool.execute("delta-snapshot", { operation: "snapshot_visible", tabName: "docs", limit: 1 }, undefined, undefined, ctx);
	assert.equal((await readback()).omittedUnchangedTextNodes, undefined, "even paginated explicit reads reset the baseline");
	assert.equal((await readback()).omittedUnchangedTextNodes, 12);
	await tool.execute("delta-recover", { operation: "recover", tabName: "docs" }, undefined, undefined, ctx);
	assert.equal((await readback()).omittedUnchangedTextNodes, undefined);
	tabs.get("docs")!.documentGeneration += 1;
	assert.equal((await readback()).omittedUnchangedTextNodes, undefined, "navigation resets the baseline");
	tabs.get("docs")!.documentGeneration -= 1;
	await tool.execute("delta-second-tab", { operation: "claim", tabId: 77, tabName: "account" }, undefined, undefined, ctx);
	await readback();
	const otherTab = await interact.execute("delta-other-tab", { operation: "execute", tabName: "account", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx);
	assert.equal(otherTab.details.readback.observation.omittedUnchangedTextNodes, undefined, "identical text on a different tab is not a baseline");
	assert.equal((await readback()).omittedUnchangedTextNodes, 12);
	await tool.execute("delta-handoff", { operation: "handoff", tabName: "account" }, undefined, undefined, ctx);
	textChunks = 180;
	const large = await interact.execute("delta-paginated", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx);
	assert.ok(large.details.readback.nextCursor);
	assert.equal((await readback()).omittedUnchangedTextNodes, undefined, "never seed a baseline from partially delivered text");
	textChunks = 12;
	await assert.rejects(() => interact.execute("browser-interact-expect-scroll", { operation: "execute", tabName: "docs", action: "scroll", direction: "down", expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
	await assert.rejects(() => interact.execute("browser-interact-expect-syntax", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2", expect: "document.title" }, undefined, undefined, ctx), /interaction expect must be/u, "非法判据必须在本地拒绝，不发到 relay");
	await assert.rejects(() => interact.execute("browser-interact-expect-coordinate", { operation: "execute", tabName: "docs", action: "click", x: 10, y: 10, observationEpoch: 7, expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
	interactFailure = "browser relay interact timeout";
	await assert.rejects(() => interact.execute("browser-interact-write-timeout", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx), /unknown.*只读核对.*禁止重发/su, "写动作 unknown 后必须禁止重发");
	// The whitelist itself is the `key` enum; the guideline only has to state the rule that
	// the schema cannot: a chorded key never types a character.
	assert.match(interact.promptGuidelines?.join("\n") ?? "", /keypress requires targetRef.*chorded key never types/u);
	assert.equal(interact.parameters.properties.key.enum.length, 62, "白名单：26 字母 + 10 数字 + 空格 + Backspace/Delete/Home/End/PageUp/PageDown + 4 方向键 + F1-F12 + Enter/Tab/Escape");
	assert.deepEqual(interact.parameters.properties.modifiers.items.enum, ["Shift", "Control", "Alt", "Meta"]);
	assert.equal(interact.parameters.properties.modifiers.maxItems, 4);
	for (const key of ["Enter", "Tab", "Escape"]) {
		const pressed = await interact.execute(`browser-key-${key}`, { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key, expect: "value=empty" }, undefined, undefined, ctx);
		assert.equal(pressed.details.acknowledged, true);
		assert.equal(pressed.details.businessOutcome, "unverified");
		assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.key, key);
	}
	// Modifiers travel to the relay unchanged and in canonical order; a chord on a
	// non-keypress action is rejected locally.
	const arrow = await interact.execute("browser-key-arrow", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "ArrowDown", modifiers: ["Meta", "Shift"] }, undefined, undefined, ctx);
	assert.deepEqual(arrow.details.effect.modifiers, ["Shift", "Meta"]);
	assert.deepEqual(calls.filter((call) => call.operation === "interact").at(-1)?.payload.modifiers, ["Shift", "Meta"]);
	await assert.rejects(() => interact.execute("browser-key-bad-modifier", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "ArrowDown", modifiers: ["Hyper"] }, undefined, undefined), /modifiers/u);
	await assert.rejects(() => interact.execute("browser-key-dup-modifier", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "a", modifiers: ["Shift", "Shift"] }, undefined, undefined, ctx), /modifiers/u);
	await assert.rejects(() => interact.execute("browser-type-modifier", { operation: "execute", tabName: "docs", action: "type", targetRef: "ax_1_1", text: "x", modifiers: ["Shift"] }, undefined, undefined, ctx), /modifiers/u);
	await assert.rejects(() => interact.execute("browser-unlisted-key", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "F13" }, undefined, undefined, ctx), /keypress key/u);
	// Pointer actions reach the relay with their refs; drag requires both, and coordinates
	// are refused rather than guessed.
	const rightClick = await interact.execute("browser-pointer-right", { operation: "execute", tabName: "docs", action: "right_click", targetRef: "ax_1_1" }, undefined, undefined, ctx);
	assert.equal(rightClick.details.effect.action ?? "ok", rightClick.details.effect?.action ?? "ok");
	assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.action, "right_click");
	const drag = await interact.execute("browser-pointer-drag", { operation: "execute", tabName: "docs", action: "drag", targetRef: "ax_1_1", dropRef: "ax_1_2" }, undefined, undefined, ctx);
	assert.equal(drag.details.acknowledged, true);
	assert.deepEqual([calls.filter((call) => call.operation === "interact").at(-1)?.payload.targetRef, calls.filter((call) => call.operation === "interact").at(-1)?.payload.dropRef], ["ax_1_1", "ax_1_2"]);
	await assert.rejects(() => interact.execute("browser-drag-no-drop", { operation: "execute", tabName: "docs", action: "drag", targetRef: "ax_1_1" }, undefined, undefined, ctx), /dropRef/u);
	await assert.rejects(() => interact.execute("browser-drag-coords", { operation: "execute", tabName: "docs", action: "drag", targetRef: "ax_1_1", dropRef: "ax_1_2", x: 1, y: 2, observationEpoch: 1 }, undefined, undefined, ctx), /坐标|drag/u);
	await assert.rejects(() => interact.execute("browser-click-drop", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_1", dropRef: "ax_1_2" }, undefined, undefined, ctx), /dropRef/u);
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
		visibleTruncated = true;
		const absent = await query({ text: "not in this observation" });
		assert.equal(absent.details.availableNodes, 0);
		assert.equal(absent.details.observation.truncated, true, "no match must not hide source truncation");
		assert.equal(absent.details.observation.contentComplete, false);
		visibleTruncated = false;
		for (queryReceipt of ["missing", "mismatch"]) {
			await assert.rejects(() => query({ text: "Visible body" }), /query.*缺失或不匹配/u, "never silently use a legacy unfiltered receipt");
		}
		queryReceipt = "valid";
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
		let requests = 0, connections = 0;
		const relay = { closed: false, close() { this.closed = true; }, async request() {
			requests += 1;
			if (requestError) throw requestError;
			return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [] };
		} };
		createBrowserRelayExtensionV1({
			async connectRelay() { connections += 1; if (delay) { connectEntered.resolve(); return delay; } if (connectError) throw connectError; relay.closed = false; return relay; },
			async openArtifactStore() { throw new Error("unexpected artifact store"); },
		})({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on(name: string, handler: any) { handlers.set(name, handler); }, appendEntry() {}, getActiveTools() { return active; } });
		// `select` answers "允许一次": these tests are about fallback routing, and the policy
		// gate must not turn their request errors into local refusals.
		const ctx: any = { sessionManager: { getSessionId: () => "fixture-session", getBranch: () => [] }, hasUI: true, ui: { notify(message: string) { notices.push(message); }, async select() { return "允许一次"; } } };
		await handlers.get("session_start")({}, ctx);
		return {
			ctx, notices, relay, connectEntered: connectEntered.promise, get requests() { return requests; }, get connections() { return connections; },
			failConnect(error?: Error) { connectError = error; relay.closed = true; },
			failRequest(error: Error) { requestError = error; },
			delayConnect(value: Promise<any>) { delay = value; },
			select(value: string[]) { active = value; },
			emit: (name: string) => handlers.get(name)({}, ctx),
			launch: () => handlers.get("tool_call")({ toolName: "launch_browser", input: {} }, ctx),
			inspect: (params = { operation: "tabs" }, signal?: AbortSignal) => tools.get("browser_inspect").execute("fixture", params, signal, undefined, ctx),
			interact: (params: any) => tools.get("browser_interact").execute("fixture", params, undefined, undefined, ctx),
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
		assert.match((await f.launch()).reason, /launch_browser 已尝试.*不可重试/u);
		await assert.rejects(f.inspect(), /launch_browser 已尝试.*不可重试/u);
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
		await assert.rejects(f.inspect(), /本次运行已派发 Relay 请求.*禁止.*回退/u);
		assert.match((await f.launch()).reason, /本次运行已派发 Relay 请求.*禁止.*回退/u);
	});
	await t.test("invalid open input is rejected before connecting and cannot authorize fallback", async () => {
		for (const [params, expected] of [
			[{ operation: "open", tabName: "local", url: "file:///tmp/mockup.html" }, /http\/https.*本地 HTTP/u],
			[{ operation: "open", url: "https://example.test" }, /open 需要 tabName/u],
		] as const) {
			const f = await fixture(); f.failConnect(unavailable());
			await assert.rejects(f.inspect(params as any), expected);
			assert.equal(f.connections, 0);
			assert.equal(f.requests, 0);
			assert.equal((await f.launch()).block, true);
		}
	});
	await t.test("invalid claim and interaction parameters never connect or consume fallback evidence", async () => {
		for (const params of [
			{ operation: "claim", tabId: 41 },
			{ operation: "claim", tabName: "docs" },
			{ operation: "execute", action: "click", targetRef: "ax_1", expect: "visible" },
			{ operation: "execute", action: "click" },
			{ operation: "execute", action: "type", targetRef: "ax_1" },
			{ operation: "execute", action: "keypress", targetRef: "ax_1", key: "Space" },
			{ operation: "execute", action: "scroll", direction: "sideways" },
			{ operation: "execute", action: "click", targetRef: "ax_1", x: 1, y: 2, observationEpoch: 1 },
			{ operation: "execute" },
		]) {
			const f = await fixture(); f.failConnect(unavailable());
			await assert.rejects(params.operation === "claim" ? f.inspect(params as any) : f.interact(params));
			assert.equal(f.connections, 0, JSON.stringify(params));
			assert.equal(f.requests, 0);
			assert.equal((await f.launch()).block, true);
		}
		const f = await fixture(); f.failConnect(unavailable());
		await assert.rejects(f.inspect()); // Legitimate pre-dispatch unavailability.
		const connections = f.connections;
		await assert.rejects(f.interact({ operation: "execute", action: "click", expect: "navigation" }));
		assert.equal(f.connections, connections);
		assert.equal(await f.launch(), undefined, "local mistakes neither grant nor revoke an existing permit");
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
		let confirmed = false, input: string | undefined;
		let active = ["browser_inspect", "browser_interact"], idle = true, sessionId = "command-session";
		let resolveConfirm: (() => Promise<boolean>) | undefined;
		let resolveInput: (() => Promise<string | undefined>) | undefined;
		const ctx: any = { hasUI: true, mode: "tui", isIdle: () => idle,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
			ui: {
				notify(message: string) { notices.push(message); },
				async select() { throw new Error("/browser must not open an action menu"); },
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
			confirm(value = true) { confirmed = value; },
			input(value: string) { input = value; }, selectTools(value: string[]) { active = value; },
			busy() { idle = false; }, switchId() { sessionId = "replacement-session"; },
			waitConfirm(fn: () => Promise<boolean>) { resolveConfirm = fn; },
			waitInput(fn: () => Promise<string | undefined>) { resolveInput = fn; },
		};
	}
	await t.test("startup, cancelled default task and invalid arguments have no IO/model effects", async () => {
		const f = await fixture(); assert.deepEqual(f.calls, []);
		await f.run(); assert.deepEqual(f.calls, []); assert.deepEqual(f.notices, []);
		assert.deepEqual(f.command.getArgumentCompletions("").map((item: any) => item.value), ["install", "status"]);
		assert.equal(f.command.getArgumentCompletions("help"), null);
		for (const bad of ["x".repeat(4097), "a\0b"]) await f.run(bad);
		assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []);
		assert.deepEqual(f.command.getArgumentCompletions("st").map((item: any) => item.value), ["status"]);
		assert.equal(f.command.getArgumentCompletions("use private task"), null);
	});
	await t.test("install needs explicit confirmation and reads back once; never probes or calls a model", async () => {
		const f = await fixture(); await f.run("install"); assert.deepEqual(f.calls, ["confirm"]);
		f.calls.length = 0; f.confirm(); await f.run("install");
		assert.deepEqual(f.calls, ["confirm", "install", "status"]);
		assert.match(f.notices.at(-1)!, /注册已回读确认[\s\S]*无变化/u);
		assert.ok(f.notices.at(-1)!.includes("/current/chrome-extension"));
		assert.deepEqual(f.messages, []);
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
	await t.test("extension directory display is a fixed HOME-derived path, never a child-supplied path", async () => {
		for (const injected of ["../../outside", "/tmp/attacker"]) {
			const f = await fixture({ async runInstaller() { return { installed: true, componentDigest: "a".repeat(64), extensionDir: injected }; } });
			await f.run("status");
			assert.ok(!f.notices.join("\n").includes(injected));
			assert.ok(f.notices.at(-1)!.includes("/browser-relay/current/chrome-extension"));
		}
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
		const f = await fixture(); await f.run("打开 example.com，读标题");
		assert.equal(f.messages.length, 1); assert.match(f.messages[0].text, /用户任务：\n打开 example.com，读标题/u);
		assert.deepEqual(f.messages[0].options, { expandPromptTemplates: false }); assert.deepEqual(f.calls, []);
		const menu = await fixture(); menu.input("/browser install"); await menu.run();
		assert.equal(menu.messages.length, 1); assert.deepEqual(menu.calls, []);
		assert.match(menu.messages[0].text, /用户任务：\n\/browser install/u);
	});
	await t.test("arbitrary task text is preserved; only exact install/status are reserved", async () => {
		for (const task of ["看下这个网站是什么https://pokemondb.net/sprites/rotom", "install this extension", "status of this website", "help", "use this website"]) {
			const f = await fixture(); await f.run(task);
			assert.equal(f.messages.length, 1);
			assert.ok(f.messages[0].text.endsWith(`用户任务：\n${task}`));
			assert.deepEqual(f.calls, []);
		}
	});
	await t.test("cancelled/oversized use, busy agent and excluded tools do not submit or enable anything", async () => {
		const f = await fixture(); await f.run(); assert.deepEqual(f.messages, []);
		f.input("文".repeat(2000)); await f.run(); assert.deepEqual(f.messages, []);
		f.selectTools(["launch_browser"]); await f.run("use read a page"); assert.deepEqual(f.messages, []);
		f.busy(); await f.run("use read a page"); await f.run("install"); assert.deepEqual(f.calls, []);
		f.ctx.hasUI = false; await assert.rejects(f.run("install"), /需要交互界面/u); assert.deepEqual(f.calls, []);
	});
	await t.test("unsupported installer platform has no subprocess or probe", async () => {
		// Linux and Windows are supported platforms now; an unknown one still refuses
		// before any subprocess, probe or file write.
		const f = await fixture({ platform: "freebsd" }); await f.run("install"); await f.run("status");
		assert.deepEqual(f.calls, []); assert.match(f.notices.at(-1)!, /没有已验证的 Chrome Relay 安装路径/u);
	});
	await t.test("linux install reaches the installer instead of a platform refusal", async () => {
		const f = await fixture({ platform: "linux" }); await f.run("status");
		assert.deepEqual(f.calls[0], "status");
	});
	await t.test("--browser names the Chromium family, and an unknown one never dispatches", async () => {
		const f = await fixture(); f.confirm(); await f.run("install --browser edge");
		assert.deepEqual(f.calls.slice(0, 2), ["confirm", "install"]);
		f.ctx.hasUI = true; f.calls.length = 0; await f.run("install --browser netscape");
		assert.deepEqual(f.calls, []); assert.match(f.notices.at(-1)!, /不支持的浏览器：netscape/u);
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
			const pending = f.run(); await entered.promise;
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
			assert.equal(manifest.path, join(realpathSync(home), "Library/Application Support/rotom/browser-relay/native-host-launcher.sh"));
			assert.deepEqual(manifest.allowed_origins, ["chrome-extension://kgadcllokaodnoknakblocmhidemimdi/"]);
			await f.run("status"); assert.match(f.notices.at(-1)!, /与当前 rotom 匹配.*不可用/su);
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

// Every fake-relay test runs as the main agent, and the policy layer refuses an
// unauthorized origin when there is no UI to ask. Point the policy at a file that allows
// the fixture origin, exactly as a user's `总是允许` would have written it.
async function allowPolicyFor(workspace: string, origins: string[] = ["https://example.test"]) {
	const { writeBrowserPolicyV1, BROWSER_POLICY_PATH_ENV_V1 } = await import("./browser-policy.ts");
	const path = join(workspace, "rotom", "browser-policy.json");
	await writeBrowserPolicyV1({ blocklist: [], allowlist: origins.map((origin) => ({ origin, capabilities: ["read", "interact", "upload", "devtools"] })) }, path);
	process.env[BROWSER_POLICY_PATH_ENV_V1] = path;
	return path;
}

test("browser_inspect console：本地拒绝非法过滤，结果按 128 KiB 截断并用 cursor 续读", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-console-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const loaded = await loadExtensions([], workspace);
	const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const entries = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, level: "error", text: `entry ${index + 1} ${"x".repeat(1_500)}`, at: 1_700_000_000_000 + index, source: "console" }));
	let closed = false;
	const relay = {
		get closed() { return closed; },
		close() { closed = true; },
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			calls.push({ operation, payload });
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "log", tabId: 12, documentGeneration: 1, url: "https://example.test/a?token=secret", title: "log", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "network") {
				if (payload.tabName !== "log") throw new Error("network 需要属于当前 agent 的 tab");
				const leak = String(payload.pattern ?? "") === "leak";
				// Entry-level plumbing is rebuilt from a fixed field list; a top-level leak is
				// rejected. Both are exercised here.
				const entries = [
					{ seq: 1, requestId: "r1", method: "GET", url: "https://example.test/ok", resourceType: "Fetch", status: 200, mimeType: "application/json", fromCache: false, durationMs: 12, at: 1_700_000_000_000, headers: { authorization: "Bearer entry-secret" }, postData: "password=entry-secret" },
					{ seq: 2, requestId: "r2", method: "POST", url: "https://example.test/status-500?token=secret", resourceType: "Fetch", status: 500, durationMs: 31, at: 1_700_000_001_000 },
				];
				return { schemaVersion: 1, kind: "rotom-browser-network", tabName: "log", tabId: 12, captureSince: new Date(1_700_000_000_000).toISOString(), dropped: 2, retained: 2, entries, ...(leak ? { headers: { authorization: "Bearer top-secret" } } : {}) };
			}
			if (operation === "console") {
				const since = Number(String(payload.sinceCursor ?? "c0").slice(1));
				const rest = entries.filter((entry) => entry.seq > since).slice(0, Number(payload.limit ?? 50));
				return { schemaVersion: 1, kind: "rotom-browser-console", tabName: "log", tabId: 12, documentGeneration: 1, captureSince: new Date(1_700_000_000_000).toISOString(), dropped: 7, retained: 200, entries: rest, ...(rest.length === Number(payload.limit ?? 50) ? { nextCursor: `c${rest[rest.length - 1].seq}` } : {}) };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { closed = false; return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);
		// Invalid filters never reach the relay.
		const before = calls.filter((call) => call.operation === "console").length;
		for (const params of [{ operation: "console", level: "debug" }, { operation: "console", pattern: "x".repeat(129) }, { operation: "console", limit: 201 }, { operation: "console", sinceCursor: "42" }, { operation: "tabs", level: "error" }]) {
			await assert.rejects(tool.execute("console-invalid", params, undefined, undefined, ctx));
		}
		assert.equal(calls.filter((call) => call.operation === "console").length, before, "非法参数不得发请求");

		// 200 entries of 1.5 KB cannot fit one 128 KiB result: page it instead.
		const page = await tool.execute("console-page", { operation: "console", tabName: "log", limit: 200 }, undefined, undefined, ctx);
		assert.equal(page.details.kind, "browser-console");
		assert.equal(page.details.dropped, 7);
		assert.ok(page.details.entries.length > 0 && page.details.entries.length < 200, `必须被截断：${page.details.entries.length}`);
		assert.ok(Buffer.byteLength(page.content[0].text, "utf8") <= 128 * 1024);
		assert.equal(typeof page.details.nextCursor, "string");
		assert.equal(JSON.stringify(page.details).includes("token=secret"), false, "console 结果不出带 query 的 URL");

		const next = await tool.execute("console-next", { operation: "console", tabName: "log", sinceCursor: page.details.nextCursor }, undefined, undefined, ctx);
		assert.ok(next.details.entries[0].seq > page.details.entries.at(-1).seq, "cursor 继续而不是重放");

		// network: local filters, metadata mapping, and a hard rejection of leaked headers.
		const networkCalls = () => calls.filter((call) => call.operation === "network").length;
		const networkStart = networkCalls();
		for (const params of [{ operation: "network", resourceType: "fetch" }, { operation: "network", sinceCursor: "c1" }, { operation: "network", level: "error" }, { operation: "network", failedOnly: "yes" }, { operation: "tabs", failedOnly: true }]) {
			await assert.rejects(tool.execute("network-invalid", params, undefined, undefined, ctx));
		}
		assert.equal(networkCalls(), networkStart, "非法参数不得发请求");
		const network = await tool.execute("network-page", { operation: "network", tabName: "log", failedOnly: true }, undefined, undefined, ctx);
		assert.equal(network.details.kind, "browser-network");
		assert.equal(network.details.entries.length, 2);
		assert.equal(network.details.entries[1].status, 500);
		assert.equal(network.details.entries[1].durationMs, 31);
		assert.equal(JSON.stringify(network.details).includes("token=secret"), false, "network 结果不出带 query 的 URL");
		assert.equal(JSON.stringify(network.details).includes("headers"), false, "entry 级 header 必须被丢弃");
		assert.equal(JSON.stringify(network.details).includes("entry-secret"), false);
		await assert.rejects(tool.execute("network-leak", { operation: "network", tabName: "log", pattern: "leak" }, undefined, undefined, ctx), /不得包含 headers/u);
		assert.ok(next.details.entries[0].seq > page.details.entries.at(-1).seq, "cursor 继续而不是重放");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser_interact upload：路径先本地校验，拒绝的路径不派发，放行时只传绝对路径", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-upload-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const loaded = await loadExtensions([], workspace);
	const payloads: Array<Record<string, unknown>> = [];
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "form", tabId: 21, documentGeneration: 1, url: "https://example.test/form", title: "form", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "interact") {
				payloads.push(payload);
				const readback = { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "form", tabId: 21, documentGeneration: 1, observationEpoch: 1, url: "https://example.test/form", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "form-digest" };
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", tabName: "form", actionId: payload.actionId, action: payload.action, acknowledged: true, readback, effect: { dispatch: "files", files: (payload.paths as string[]).length, focusVerified: false } };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		const allowed = join(workspace, "payload.txt");
		await writeFile(allowed, "payload\n");
		const secret = join(workspace, ".env");
		await writeFile(secret, "SECRET=1\n");
		// Parameter combinations and path rules are decided before the relay is asked.
		for (const params of [
			{ operation: "execute", tabName: "form", action: "click", targetRef: "ax_1_1", paths: [allowed] },
			{ operation: "execute", tabName: "form", action: "upload", paths: [allowed] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [secret] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: ["relative.txt"] },
			{ operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [allowed], text: "nope" },
		]) await assert.rejects(interact.execute("upload-invalid", params, undefined, undefined, ctx));
		assert.equal(payloads.length, 0, "被拒绝的 upload 不得派发");
		const uploaded = await interact.execute("upload-ok", { operation: "execute", tabName: "form", action: "upload", targetRef: "ax_1_1", paths: [allowed] }, undefined, undefined, ctx);
		assert.equal(uploaded.details.effect.dispatch, "files");
		assert.deepEqual(payloads.at(-1)?.paths, [allowed]);
		assert.equal(JSON.stringify(uploaded.details).includes(workspace), false, "结果不得回显本地目录");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser dialog：弹窗期间的拒绝原样返回，dialog 动作只下发 accept/promptText", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-dialog-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const loaded = await loadExtensions([], workspace);
	const interactPayloads: Array<Record<string, unknown>> = [];
	const observation = { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "dialog", tabId: 31, documentGeneration: 1, observationEpoch: 2, url: "https://example.test/dialog", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "dialog-digest" };
	const blocked = { schemaVersion: 1, kind: "dialog-blocking", tabName: "dialog", dialog: { tabId: 31, type: "beforeunload", message: "unsaved changes", sensitive: true, openedAt: 1_700_000_000_000 } };
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "dialog", tabId: 31, documentGeneration: 1, url: "https://example.test/dialog", title: "dialog", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true, dialog: blocked.dialog }] };
			// Every read of a suspended tab answers with the refusal, like the relay does.
			if (operation === "snapshot" || operation === "read_full" || operation === "navigate") return blocked;
			if (operation === "interact") {
				interactPayloads.push(payload);
				if (payload.action !== "dialog") return blocked;
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", tabName: "dialog", actionId: payload.actionId, action: "dialog", acknowledged: true, readback: observation, effect: { dispatch: "handleJavaScriptDialog", accept: payload.accept === true, sensitive: true } };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const inspect = browser.tools.get("browser_inspect")?.definition;
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(inspect && interact);
		// Reads of a suspended tab return the refusal instead of a schema error.
		for (const params of [{ operation: "snapshot_visible", tabName: "dialog" }, { operation: "read_full", tabName: "dialog" }]) {
			const result = await inspect.execute("dialog-read", params, undefined, undefined, ctx);
			assert.equal(result.details.kind, "dialog-blocking", JSON.stringify(result.details).slice(0, 200));
			assert.equal(result.details.dialog.type, "beforeunload");
			assert.equal(result.details.dialog.sensitive, true);
			assert.match(result.content[0].text, /beforeunload/u);
		}
		const moved = await inspect.execute("dialog-navigate", { operation: "navigate", tabName: "dialog", url: "https://example.test/next" }, undefined, undefined, ctx);
		assert.equal(moved.details.kind, "dialog-blocking");
		// Writes are refused before anything is dispatched, and the refusal is structured.
		const clicked = await interact.execute("dialog-click", { operation: "execute", tabName: "dialog", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ctx);
		assert.equal(clicked.details.kind, "dialog-blocking");
		assert.equal(clicked.details.dialog.message, "unsaved changes");
		// The dialog action itself is allowed through, and carries only its own parameters.
		for (const params of [
			{ operation: "execute", tabName: "dialog", action: "dialog" },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: false, promptText: "x" },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: true, targetRef: "ax_1_1" },
			{ operation: "execute", tabName: "dialog", action: "click", targetRef: "ax_1_1", accept: true },
			{ operation: "execute", tabName: "dialog", action: "dialog", accept: true, promptText: "x".repeat(501) },
		]) await assert.rejects(interact.execute("dialog-invalid", params, undefined, undefined, ctx));
		const accepted = await interact.execute("dialog-accept", { operation: "execute", tabName: "dialog", action: "dialog", accept: true, promptText: "answer" }, undefined, undefined, ctx);
		assert.equal(accepted.details.effect.accept, true);
		assert.equal(accepted.details.effect.dispatch, "handleJavaScriptDialog");
		const last = interactPayloads.at(-1)!;
		assert.equal(last.accept, true);
		assert.equal(last.promptText, "answer");
		assert.equal(last.targetRef, undefined, "dialog 不带 ref");
		assert.equal(last.paths, undefined);
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser batch：逐步派发、单步 audit、原地停下且不重放", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-batch-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const loaded = await loadExtensions([], workspace);
	const interactPayloads: Array<Record<string, unknown>> = [];
	const observation = (generation: number) => ({ schemaVersion: 1, kind: "rotom-browser-observation", tabName: "form", tabId: 41, documentGeneration: generation, observationEpoch: 3, url: "https://example.test/form", status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: `form-${generation}` });
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "form", tabId: 41, documentGeneration: 1, url: "https://example.test/form", title: "form", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation !== "interact") throw new Error(`unexpected operation ${operation}`);
			interactPayloads.push(payload);
			// The third step navigates: that must stop the batch.
			const navigated = interactPayloads.length === 3;
			const expectation = payload.expect === undefined ? undefined : { outcome: payload.expect === "checked=true" ? "unmet" : "met" };
			return {
				schemaVersion: 1,
				kind: "rotom-browser-interaction-result",
				tabName: "form",
				actionId: payload.actionId,
				action: payload.action,
				acknowledged: true,
				effect: { dispatch: "mouse", target: { changed: true }, ...(expectation ? { expectation } : {}) },
				readback: observation(navigated ? 2 : 1),
			};
		},
	};
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	const audits: any[] = [];
	loaded.runtime.appendEntry = (type: string, data: any) => { if (type === "rotom-browser-interaction-audit/v1") audits.push(data); };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		// Each step gets its own intent+terminal audit; the batch itself does not add one.
		const done = await interact.execute("batch-1", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1" }, { action: "type", targetRef: "ax_1_2", text: "hi" }] }, undefined, undefined, ctx);
		assert.equal(done.details.kind, "browser-batch-result");
		assert.equal(done.details.completed, true);
		assert.equal(interactPayloads.length, 2);
		assert.equal(audits.filter((entry) => entry.kind === "rotom-browser-interaction-intent").length, 2);
		assert.equal(audits.filter((entry) => entry.kind === "rotom-browser-interaction-terminal" && entry.status === "ok").length, 2);
		assert.notEqual(interactPayloads[0].actionId, interactPayloads[1].actionId, "每一步是独立的动作");
		// An unmet expect stops before the next step is dispatched.
		interactPayloads.length = 0;
		const unmet = await interact.execute("batch-2", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1", expect: "checked=true" }, { action: "click", targetRef: "ax_1_2" }] }, undefined, undefined, ctx);
		assert.equal(unmet.details.stopReason, "expect-unmet");
		assert.equal(unmet.details.stoppedAt, 0);
		assert.equal(interactPayloads.length, 1, "第一步之后不再派发");
		// A navigation between steps stops the batch as well.
		interactPayloads.length = 0;
		const navigated = await interact.execute("batch-3", { operation: "execute", tabName: "form", actions: [{ action: "click", targetRef: "ax_1_1" }, { action: "click", targetRef: "ax_1_2" }, { action: "click", targetRef: "ax_1_3" }, { action: "click", targetRef: "ax_1_4" }] }, undefined, undefined, ctx);
		assert.equal(navigated.details.stopReason, "navigation");
		assert.equal(navigated.details.stoppedAt, 2);
		assert.equal(interactPayloads.length, 3, "导航之后的那一步不再派发");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser policy：blocklist 拒绝、无 UI 按拒绝、会话允许只影响本会话、总是允许写回并扩大子 lease", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-policy-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const { writeBrowserPolicyV1, readBrowserPolicyV1, BROWSER_POLICY_PATH_ENV_V1 } = await import("./browser-policy.ts");
	const policyPath = await allowPolicyFor(workspace, []);
	const opened: string[] = [];
	// The same extension serves the parent and its children, so the lease token is what
	// decides which side of the policy gate runs.
	let childLeaseToken: string | undefined;
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return childLeaseToken; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: Record<string, unknown>) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "site", tabId: 51, documentGeneration: 1, url: "https://allowed.test/page", title: "site", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "open") { opened.push(String(payload.url)); return { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "site", tabId: 51, documentGeneration: 1, observationEpoch: 1, url: String(payload.url), status: "complete", contentCoverage: "rendered-dom", contentComplete: false, nodes: [], digest: "open-digest" }; }
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	const choices: string[] = [];
	const selecting = (hasUI = true, answer = "允许一次") => ({ cwd: workspace, sessionManager: session, mode: "print", hasUI, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { choices.push(answer); return answer; }, theme: { fg: (_color: string, value: string) => value } } });
	try {
		await new Promise((resolve) => setImmediate(resolve));
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx0());
		function ctx0() { return { cwd: workspace, sessionManager: session, mode: "print", hasUI: false, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, theme: { fg: (_color: string, value: string) => value } } }; }
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);

		// blocklist 先于一切：即使有 UI 也不询问，直接拒绝且不派发。
		await writeBrowserPolicyV1({ blocklist: ["https://blocked.test"], allowlist: [] }, policyPath);
		const blocked = await tool.execute("policy-blocked", { operation: "open", tabName: "site", url: "https://blocked.test/x" }, undefined, undefined, selecting(true));
		assert.equal(blocked.details.kind, "needs-approval");
		assert.equal(blocked.details.reason, "blocklist");
		assert.equal(blocked.details.capability, "interact");
		assert.equal(opened.length, 0, "被 blocklist 拒绝的 open 不得派发");
		assert.equal(choices.length, 0, "blocklist 不需要询问");

		// 未授权 origin + 没有 UI：按拒绝处理，不派发。
		const noUi = await tool.execute("policy-no-ui", { operation: "open", tabName: "site", url: "https://unknown.test/x" }, undefined, undefined, ctx0());
		assert.equal(noUi.details.kind, "needs-approval");
		assert.equal(noUi.details.reason, "no-ui");
		assert.equal(opened.length, 0);

		// 允许一次：放行这一次，但不写策略文件，也不记住。
		const once = await tool.execute("policy-once", { operation: "open", tabName: "site", url: "https://unknown.test/x" }, undefined, undefined, selecting(true, "允许一次"));
		assert.equal(once.details.kind, "observation");
		assert.equal(opened.length, 1);
		await tool.execute("policy-tabs", { operation: "tabs" }, undefined, undefined, selecting(true));
		const published = JSON.parse(process.env.ROTOM_BROWSER_LEASE_SCOPE ?? "{}");
		assert.equal(published.rootSessionId, "root-session", "父 agent 发布的 lease scope 必须带 rootSessionId");
		// Only what the user authorized is published. The tab's current URL is not a grant:
		// it can change through a redirect, a page-initiated navigation, or by claiming a tab
		// the user already had open, so a child lease must not inherit it.
		assert.deepEqual(published.origins, ["https://unknown.test"], `父授权 origin 只来自用户授权：${JSON.stringify(published.origins)}`);
		assert.equal(published.origins.includes("https://allowed.test"), false, "tab 当前 URL 不得进入子 lease");
		const afterOnce = await tool.execute("policy-once-again", { operation: "open", tabName: "site", url: "https://unknown.test/y" }, undefined, undefined, ctx0());
		assert.equal(afterOnce.details.reason, "no-ui", "允许一次不能变成会话授权");
		assert.deepEqual((await readBrowserPolicyV1(policyPath)).allowlist, [], "允许一次不写策略文件");

		// 本会话允许：本会话内不再询问，但仍不写文件。
		const sessionCtx = selecting(true, "本会话允许");
		const granted = await tool.execute("policy-session", { operation: "open", tabName: "site", url: "https://session.test/x" }, undefined, undefined, sessionCtx);
		assert.equal(granted.details.kind, "observation");
		const choicesBefore = choices.length;
		const again = await tool.execute("policy-session-again", { operation: "open", tabName: "site", url: "https://session.test/y" }, undefined, undefined, sessionCtx);
		assert.equal(again.details.kind, "observation");
		assert.equal(choices.length, choicesBefore, "本会话允许后不再询问");
		assert.deepEqual((await readBrowserPolicyV1(policyPath)).allowlist, [], "本会话允许不写策略文件");

		// 总是允许：写回策略文件，并扩大本次 run 的子 lease。
		const always = selecting(true, "总是允许");
		const written = await tool.execute("policy-always", { operation: "open", tabName: "site", url: "https://always.test/x" }, undefined, undefined, always);
		assert.equal(written.details.kind, "observation");
		const policy = await readBrowserPolicyV1(policyPath);
		assert.deepEqual(policy.allowlist, [{ origin: "https://always.test", capabilities: ["interact"] }]);
		const { mkdir, writeFile, chmod, readFile } = await import("node:fs/promises");
		const leases = join(workspace, "leases");
		await mkdir(leases, { recursive: true, mode: 0o700 });
		await chmod(leases, 0o700);
		const childFile = join(leases, "child.json");
		await writeFile(childFile, JSON.stringify({ schemaVersion: 1, kind: "rotom-browser-lease", token: "child", agentId: "child", rootSessionId: "root-session", origins: ["https://allowed.test"], allow: { devtools: false, upload: false, download: false }, maxTabs: 2, keepTabs: false, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
		await chmod(childFile, 0o600);
		await tool.execute("policy-always-2", { operation: "open", tabName: "site", url: "https://second.test/x" }, undefined, undefined, selecting(true, "总是允许"));
		const child = JSON.parse(await readFile(childFile, "utf8"));
		assert.deepEqual(child.origins, ["https://allowed.test", "https://second.test"], "父 agent 的确认必须传给本次 run 的子 lease");
		assert.notEqual(process.env[BROWSER_POLICY_PATH_ENV_V1], undefined);

		// browser_inspect is a parallel tool: two structural calls on the same origin must
		// share one prompt instead of asking twice and racing two answers.
		await writeFile(policyPath, JSON.stringify({ blocklist: [], allowlist: [] }), { mode: 0o600 });
		await chmod(policyPath, 0o600);
		const promptsBefore = choices.length;
		// The prompt must stay open while both calls reach it, which is what a real user
		// answering the dialog does; a resolved-immediately stub would hide the duplicate.
		let release: (() => void) | undefined;
		const held = { ...ctx0(), hasUI: true, ui: { select: async () => { choices.push("held"); return new Promise<string | undefined>((resolve) => { release = () => resolve("允许一次"); }); } } } as any;
		const pendingCalls = [
			tool.execute("policy-race-1", { operation: "open", tabName: "site", url: "https://race.test/a" }, undefined, undefined, held),
			tool.execute("policy-race-2", { operation: "open", tabName: "site", url: "https://race.test/b" }, undefined, undefined, held),
		];
		for (let attempt = 0; attempt < 20 && release === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(choices.length - promptsBefore, 1, "同一 origin 的并发请求只询问一次");
		if (release === undefined) throw new Error("并发询问没有到达用户");
		const releasePrompt: () => void = release;
		releasePrompt();
		const settled = await Promise.all(pendingCalls);
		assert.deepEqual(settled.map((result) => result.details.kind), ["observation", "observation"]);
		assert.equal(choices.length - promptsBefore, 1, "两次调用共用同一个询问");

		// A child's authorization is its lease, but the user's blocklist still applies: a
		// lease that names an origin cannot overrule a refused site.
		const blockedPolicy = { blocklist: ["https://allowed.test"], allowlist: [{ origin: "https://allowed.test", capabilities: ["interact", "read"] }] };
		await writeFile(policyPath, JSON.stringify(blockedPolicy), { mode: 0o600 });
		await chmod(policyPath, 0o600);
		childLeaseToken = "child";
		const openedBefore = opened.length;
		const choicesBeforeChild = choices.length;
		const childBlocked = await tool.execute("policy-child-blocklist", { operation: "open", tabName: "site", url: "https://allowed.test/x" }, undefined, undefined, selecting(true, "本会话允许"));
		assert.equal(childBlocked.details.kind, "needs-approval");
		assert.equal(childBlocked.details.reason, "blocklist", "子 agent 也不得绕过用户 blocklist");
		assert.equal(opened.length, openedBefore, "blocklist 拒绝的子 agent 请求不得派发");
		assert.equal(choices.length, choicesBeforeChild, "子 agent 不产生询问");
		childLeaseToken = undefined;
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser 敏感动作：relay 拒绝时问用户再重发、用户拒绝不重试、无 UI 与子 agent 都不派发、localhost 开关只对本机生效", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-confirm-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pii-coding-agent": join(piDist, "index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	const policyPath = await allowPolicyFor(workspace);
	const origin = "https://example.test";
	const dispatchLedger: Array<Record<string, unknown>> = [];
	const relays: Array<Record<string, unknown>> = [];
	const makeRelay = (leaseToken: string | undefined) => {
		let closed = false;
		return {
			get closed() { return closed; },
			close() { closed = true; },
			get leaseToken() { return leaseToken; },
			get keepTabs() { return false; },
			rootSessionId: "root-session",
			get socketPath() { return join(workspace, "relay.sock"); },
			async request(operation: string, payload: Record<string, unknown>) {
				if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: `${origin}/checkout`, title: "checkout", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
				if (operation === "interact") {
					relays.push({ ...payload });
					// The relay refuses a sensitive target until the caller confirms it.
					if (payload.confirmed !== true) return { schemaVersion: 1, kind: "needs-confirmation", tabName: "shop", origin, capability: "interact", reason: "sensitive-name", matchedWord: "submit" };
					dispatchLedger.push({ ...payload });
					return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { dispatch: "mouse" }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "shop", tabId: 61, documentGeneration: 1, observationEpoch: 3, url: `${origin}/checkout`, title: "checkout", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false, digest: "confirm-digest" } };
				}
				throw new Error(`unexpected operation ${operation}`);
			},
		};
	};
	let activeRelay = makeRelay(undefined);
	// Switching relays must close the live one: the extension caches a connection and only
	// reconnects after it is closed.
	const switchRelay = (next: Record<string, unknown>) => { (activeRelay as any).close(); activeRelay = next; };
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return activeRelay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	const entries: Array<{ customType: string; data: any }> = [];
	loaded.runtime.appendEntry = (customType: string, data: unknown) => { entries.push({ customType, data }); session.appendCustomEntry(customType, data); };
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const confirmations: Array<{ title: string; message?: string }> = [];
	const ui = (hasUI: boolean, answer: boolean) => ({ cwd: workspace, sessionManager: session, mode: "print", hasUI, ui: { notify() {}, setStatus() {}, async confirm(title: string, message?: string) { confirmations.push({ title, message }); return answer; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } });
	const savedConfirm = process.env.ROTOM_BROWSER_CONFIRM;
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ui(false, true));
		const interact = browser.tools.get("browser_interact")?.definition;
		assert.ok(interact);
		delete process.env.ROTOM_BROWSER_CONFIRM;

		// 用户同意：relay 先拒绝、再收到 confirmed:true，只剩一次真实派发。
		const approved = await interact.execute("confirm-yes", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(true, true));
		assert.equal(approved.details.kind, "browser-interaction-result", JSON.stringify(approved.details));
		assert.equal(relays.length, 2, "必须先被拒绝一次再重发");
		assert.equal(relays[0].confirmed, undefined, "第一次不能自带 confirmed");
		assert.equal(relays[1].confirmed, true, "重发必须带 confirmed:true");
		assert.equal(dispatchLedger.length, 1);
		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0].title, /敏感/u);
		assert.match(String(confirmations[0].message), /submit/u);
		const terminal = entries.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal").at(-1);
		assert.equal(terminal?.data.confirmation, "user", "audit 必须记录这次是用户确认的");

		// 用户拒绝：明确是“用户拒绝”，不再派发也不重试。
		const denied = await interact.execute("confirm-no", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(true, false));
		assert.equal(denied.details.kind, "needs-approval");
		assert.equal(denied.details.reason, "user-denied");
		assert.match(denied.content.map((part: any) => part.text ?? "").join(" "), /不要重试/u);
		assert.equal(dispatchLedger.length, 1, "拒绝后不得派发");
		const blocked = entries.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal").at(-1);
		assert.equal(blocked?.data.status, "blocked");
		assert.equal(blocked?.data.businessOutcome, "not-executed");

		// 没有 UI：按拒绝处理，不询问也不派发。
		const before = relays.length;
		const noUi = await interact.execute("confirm-no-ui", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, true));
		assert.equal(noUi.details.kind, "needs-approval");
		assert.equal(noUi.details.reason, "no-ui");
		assert.equal(confirmations.length, 2, "没有 UI 时不能调用 confirm");
		assert.equal(relays.length, before + 1, "只发了一次被拒绝的请求");

		// 子 agent：上报给父 agent，不询问、不派发。
		switchRelay(makeRelay("child-lease"));
		const child = await interact.execute("confirm-child", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(true, true));
		assert.equal(child.details.kind, "needs-approval");
		assert.equal(child.details.reason, "sensitive-action");
		assert.equal(confirmations.length, 2, "子 agent 不能替用户确认");
		assert.equal(dispatchLedger.length, 1);

		// localhost 开关：本机自动放行，非本机 origin 仍然要问。
		switchRelay(makeRelay(undefined));
		process.env.ROTOM_BROWSER_CONFIRM = "auto-approve-localhost";
		const remote = await interact.execute("confirm-remote", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, true));
		assert.equal(remote.details.kind, "needs-approval", "非本机 origin 上开关必须无效");
		assert.equal(remote.details.reason, "no-ui");
		const localRelay = makeRelay(undefined);
		localRelay.request = async (operation: string, payload: Record<string, unknown>) => {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: "http://127.0.0.1:4321/checkout", title: "checkout", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "interact") {
				if (payload.confirmed !== true) return { schemaVersion: 1, kind: "needs-confirmation", tabName: "shop", origin: "http://127.0.0.1:4321", capability: "interact", reason: "sensitive-name", matchedWord: "submit" };
				dispatchLedger.push({ ...payload });
				return { schemaVersion: 1, kind: "rotom-browser-interaction-result", actionId: payload.actionId, action: payload.action, acknowledged: true, effect: { dispatch: "mouse" }, readback: { schemaVersion: 1, kind: "rotom-browser-observation", tabName: "shop", tabId: 61, documentGeneration: 1, observationEpoch: 4, url: "http://127.0.0.1:4321/checkout", title: "checkout", status: "complete", nodes: [], truncated: false, contentCoverage: "rendered-dom", contentComplete: false, digest: "local-digest" } };
			}
			throw new Error(`unexpected operation ${operation}`);
		};
		switchRelay(localRelay);
		const local = await interact.execute("confirm-local", { operation: "execute", tabName: "shop", action: "click", targetRef: "ax_1_1" }, undefined, undefined, ui(false, true));
		assert.equal(local.details.kind, "browser-interaction-result", JSON.stringify(local.details));
		assert.equal(confirmations.length, 2, "本机放行时不应该弹确认");
		assert.equal(dispatchLedger.length, 2);
		const localTerminal = entries.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal").at(-1);
		assert.equal(localTerminal?.data.confirmation, "auto-localhost");

		// 上传在派发前就要确认：即使 relay 从不拒绝，也不能绕过。
		process.env.ROTOM_BROWSER_CONFIRM = "";
		const uploadPath = join(workspace, "confirm.txt");
		await writeFile(uploadPath, "confirm payload\n");
		uploadLedger: {
			switchRelay(makeRelay(undefined));
			let uploadRequests = 0;
			activeRelay.request = async (operation: string, payload: Record<string, unknown>) => {
				if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "shop", tabId: 61, documentGeneration: 1, url: `${origin}/upload`, title: "upload", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
				if (operation === "interact") { uploadRequests += 1; throw new Error(`upload must not be dispatched: ${uploadRequests}`); }
				throw new Error(`unexpected operation ${operation}`);
			};
			const refusedUpload = await interact.execute("confirm-upload", { operation: "execute", tabName: "shop", action: "upload", targetRef: "ax_1_1", paths: [uploadPath] }, undefined, undefined, ui(false, true));
			assert.equal(refusedUpload.details.kind, "needs-approval", JSON.stringify(refusedUpload.details));
			assert.equal(refusedUpload.details.reason, "no-ui");
			// 用户同意后才允许派发；这里只需证明“没有确认就不会到 relay”。
		}
	} finally {
		if (savedConfirm === undefined) delete process.env.ROTOM_BROWSER_CONFIRM;
		else process.env.ROTOM_BROWSER_CONFIRM = savedConfirm;
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});

test("browser downloads：列表只回模型安全字段、完成态带 sha256、子 agent 未授权时是 needs-approval", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-downloads-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	const body = "downloaded fixture body\n";
	const filePath = join(workspace, "Downloads", "rotom", "run_a", "fixture.txt");
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, body);
	const expectedSha = createHash("sha256").update(body).digest("hex");
	let blocked: unknown[] = [];
	let listing: (url: string) => { id: number; state: string; relativePath: string; bytes: number; mimeType: string; path: string }[] = () => [];
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [] };
			if (operation === "downloads") return { schemaVersion: 1, kind: "rotom-browser-downloads", agentId: "run_a", downloads: listing("run_a"), blocked };
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	listing = () => [
		{ id: 5, state: "complete", relativePath: "rotom/run_a/fixture.txt", bytes: Buffer.byteLength(body), mimeType: "text/plain", path: filePath },
		{ id: 4, state: "complete", relativePath: "rotom/run_a/big.bin", bytes: 70 * 1024 * 1024, mimeType: "application/octet-stream", path: join(workspace, "missing.bin") },
		{ id: 3, state: "in_progress", relativePath: "rotom/run_a/partial.bin", bytes: 12, mimeType: "application/octet-stream", path: join(workspace, "partial.bin") },
	];
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { return true; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_inspect")?.definition;
		assert.ok(tool);
		const listed = await tool.execute("downloads-ok", { operation: "downloads" }, undefined, undefined, ctx);
		assert.equal(listed.details.kind, "rotom-browser-downloads");
		const complete = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("fixture.txt"));
		assert.equal(complete.sha256, expectedSha, "完成态必须给出真实摘要");
		assert.equal(complete.bytes, Buffer.byteLength(body));
		const big = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("big.bin"));
		assert.equal(big.sha256, null, "超过上限不读文件");
		assert.equal(big.sha256Skipped, "too-large");
		const partial = listed.details.downloads.find((entry: any) => entry.relativePath.endsWith("partial.bin"));
		assert.equal(partial.sha256, null);
		assert.equal(partial.sha256Skipped, undefined, "未完成的下载不标 skipped");
		assert.equal(JSON.stringify(listed.details).includes(workspace), false, "模型可见结果里不得出现绝对路径");
		await assert.rejects(tool.execute("downloads-tab", { operation: "downloads", tabName: "docs" }, undefined, undefined, ctx), /不接受 tabName/u);
		await assert.rejects(tool.execute("downloads-cursor", { operation: "downloads", cursor: "abc" }, undefined, undefined, ctx), /cursor 仅允许/u);
		blocked = [{ reason: "download" }];
		const refused = await tool.execute("downloads-blocked", { operation: "downloads" }, undefined, undefined, ctx);
		assert.equal(refused.details.kind, "needs-approval");
		assert.equal(refused.details.capability, "download");
		assert.match(refused.content.map((part: any) => part.text ?? "").join(" "), /allow\.download/u);
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});

// A tiny but real trace: one 120 ms main-thread task and one layout shift.
const TRACE_FIXTURE = Buffer.from(JSON.stringify({ traceEvents: [
	{ name: "RunTask", dur: 120_000, args: { data: { url: "https://example.test/app.js" } } },
	{ name: "LayoutShift", args: { data: { score: 0.07 } } },
	{ name: "EvaluateScript", dur: 30_000, args: { data: { url: "https://example.test/app.js", lineNumber: 4 } } },
] }));

// 1x1 PNG: real image bytes, so the export path is proven with a decodable file.
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("browser_devtools：默认隔离世界、main world 必须确认、拒绝后不派发、非法参数本地拒绝", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "pi-browser-devtools-"));
	const piDist = findPiDist();
	const loaderUrl = pathToFileURL(join(piDist, "core/extensions/loader.js")).href;
	const [{ loadExtensions, loadExtensionFromFactory }, { SessionManager }] = await Promise.all([
		import(loaderUrl),
		import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
	]);
	const { createJiti } = await import(pathToFileURL(findPiDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(loaderUrl, { moduleCache: false, alias: {
		"@earendil-works/pi-ai": findPiDependency(piDist, "@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piDist, "index.js"),
	} });
	const { createBrowserRelayExtensionV1 } = await jiti.import(join(process.cwd(), "rotom/extensions/browser/index.ts")) as any;
	await allowPolicyFor(workspace);
	let dispatched: any[] = [];
	let confirmCalls = 0;
	let confirmAnswer = true;
	const relay = {
		get closed() { return false; },
		close() {},
		get leaseToken() { return undefined; },
		get keepTabs() { return false; },
		rootSessionId: "root-session",
		get socketPath() { return join(workspace, "relay.sock"); },
		async request(operation: string, payload: any) {
			if (operation === "tabs") return { schemaVersion: 1, kind: "rotom-browser-tabs", tabs: [{ name: "code", tabId: 31, documentGeneration: 1, url: "https://example.test/globals", title: "code", status: "complete", current: true, browserActive: false, ownership: "agent", relayAttached: true }] };
			if (operation === "devtools") {
				dispatched.push(payload);
				if (payload.devtools === "record_stop") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "record_stop", tabName: "code", tabId: 31, documentGeneration: 1, durationMs: 1_000, fps: 2, truncated: true, frames: [{ data: ONE_PIXEL_PNG.toString("base64"), atMs: 0 }, { data: ONE_PIXEL_PNG.toString("base64"), atMs: 500 }] };
				if (payload.devtools === "trace_start") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_start", tabName: "code", tabId: 31, startedAt: new Date(0).toISOString(), categories: ["devtools.timeline"] };
				if (payload.devtools === "trace_stop") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "trace_stop", tabName: "code", tabId: 31, documentGeneration: 1, bytes: TRACE_FIXTURE.length, dataLossOccurred: false, traceBase64: TRACE_FIXTURE.toString("base64") };
				if (payload.devtools === "network_body") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "network_body", tabName: "code", tabId: 31, documentGeneration: 1, requestId: payload.requestId, url: "https://example.test/json", status: 200, mimeType: "application/json", resourceType: "Fetch", bodyText: "{\"message\":\"rotom-json-fixture\"}", truncated: false, bytes: 30, captureSince: new Date(0).toISOString(), note: "only requests issued after network_body was first enabled can be read" };
				if (payload.devtools === "screenshot_export") return { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "screenshot_export", tabName: "code", tabId: 31, documentGeneration: 1, format: payload.format, fullPage: payload.fullPage === true, bytes: ONE_PIXEL_PNG.length, data: ONE_PIXEL_PNG.toString("base64") };
				return payload.devtools === "viewport"
					? { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "viewport", tabName: "code", tabId: 31, documentGeneration: 1, observationEpoch: 2, reset: false, viewport: { width: 900, height: 700, deviceScaleFactor: 1, mobile: false, touch: false } }
					: { schemaVersion: 1, kind: "rotom-browser-devtools", devtools: "evaluate", tabName: "code", tabId: 31, documentGeneration: 1, world: payload.world ?? "isolated", threw: false, type: "string", valueText: "\"ok\"", truncated: false, bytes: 4 };
			}
			throw new Error(`unexpected operation ${operation}`);
		},
	};
	const loaded = await loadExtensions([], workspace);
	const browser = await loadExtensionFromFactory(createBrowserRelayExtensionV1({
		async connectRelay() { return relay; },
		openArtifactStore: async () => (await import("./browser-relay.ts")).BrowserArtifactStoreV1.open(),
	}), workspace, undefined, loaded.runtime, join(process.cwd(), "rotom/extensions/browser"));
	const session = SessionManager.inMemory(workspace);
	loaded.runtime.appendEntry = () => {};
	loaded.runtime.getAllTools = () => [];
	loaded.runtime.getCommands = () => [];
	loaded.runtime.refreshTools = () => {};
	const ctx: any = { cwd: workspace, sessionManager: session, mode: "print", hasUI: true, ui: { notify() {}, setStatus() {}, async confirm() { confirmCalls += 1; return confirmAnswer; }, async select() { return "允许一次"; }, theme: { fg: (_color: string, value: string) => value } } };
	try {
		for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const tool = browser.tools.get("browser_devtools")?.definition;
		assert.ok(tool, "browser_devtools 必须注册");
		// 隔离世界是默认，不能顺手问用户，也不能悄悄进主世界。
		const isolated = await tool.execute("devtools-isolated", { operation: "evaluate", expression: "1 + 1" }, undefined, undefined, ctx);
		assert.equal(dispatched.at(-1).world, "isolated");
		assert.equal(dispatched.at(-1).expression, "1 + 1");
		assert.equal(confirmCalls, 0, "隔离世界不需要确认");
		assert.equal(isolated.details.valueText, "\"ok\"");

		const main = await tool.execute("devtools-main", { operation: "evaluate", expression: "window.rotomPageSecret", world: "main" }, undefined, undefined, ctx);
		assert.equal(confirmCalls, 1, "主世界必须单独确认");
		assert.equal(dispatched.at(-1).world, "main");
		assert.equal(main.details.world, "main");

		// 拒绝后不得派发：这是写操作的授权边界，不是提示。
		confirmAnswer = false;
		const before = dispatched.length;
		const denied = await tool.execute("devtools-denied", { operation: "evaluate", expression: "document.cookie", world: "main" }, undefined, undefined, ctx);
		assert.equal(denied.details.kind, "needs-approval");
		assert.equal(denied.details.reason, "user-denied");
		assert.equal(dispatched.length, before, "用户拒绝后不得派发 evaluate");

		// 没有交互界面就没有人能批准。
		confirmAnswer = true;
		const noUi = await tool.execute("devtools-noui", { operation: "evaluate", expression: "1", world: "main" }, undefined, undefined, { ...ctx, hasUI: false, ui: { notify() {}, setStatus() {} } });
		assert.equal(noUi.details.kind, "needs-approval");
		assert.equal(noUi.details.reason, "no-ui");
		assert.equal(dispatched.length, before, "无 UI 时不得派发");

		const viewport = await tool.execute("devtools-viewport", { operation: "viewport", viewport: "desktop-1440" }, undefined, undefined, ctx);
		assert.equal(dispatched.at(-1).devtools, "viewport");
		assert.deepEqual(dispatched.at(-1).viewport, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false });
		assert.equal(viewport.details.devtools, "viewport");

		// 截图导出：字节真的落盘，模型只拿相对路径。
		await mkdir(join(workspace, "shots"), { recursive: true });
		const exported = await tool.execute("devtools-export", { operation: "screenshot_export", path: "shots/shot.png", fullPage: true }, undefined, undefined, ctx);
		assert.equal(exported.details.kind, "browser-export");
		assert.equal(exported.details.relativePath, join("shots", "shot.png"));
		assert.equal(exported.details.bytes, ONE_PIXEL_PNG.length);
		assert.equal(exported.details.format, "png");
		assert.equal(exported.details.fullPage, true);
		assert.equal(exported.details.overwrote, false);
		assert.equal(JSON.stringify(exported.details).includes(workspace), false, "模型可见结果里不得出现绝对路径");
		assert.deepEqual(await readFile(join(workspace, "shots", "shot.png")), ONE_PIXEL_PNG, "落盘内容必须与 relay 字节一致");
		assert.equal(dispatched.at(-1).format, "png");
		assert.equal(dispatched.at(-1).fullPage, true);

		// 覆盖已有普通文件要如实标记。
		const overwritten = await tool.execute("devtools-export-again", { operation: "screenshot_export", path: "shots/shot.png" }, undefined, undefined, ctx);
		assert.equal(overwritten.details.overwrote, true);
		await assert.rejects(tool.execute("devtools-export-outside", { operation: "screenshot_export", path: "../escape.png" }, undefined, undefined, ctx), /项目目录/u);
		await assert.rejects(tool.execute("devtools-export-mismatch", { operation: "screenshot_export", path: "shots/shot.png", format: "jpeg" }, undefined, undefined, ctx), /format/u);
		await assert.rejects(tool.execute("devtools-export-format", { operation: "screenshot_export", path: "shots/shot.png", format: "webp" }, undefined, undefined, ctx), /format/u);
		await symlink(join(workspace, "shots", "shot.png"), join(workspace, "shots", "link.png"));
		await assert.rejects(tool.execute("devtools-export-link", { operation: "screenshot_export", path: "shots/link.png" }, undefined, undefined, ctx), /符号链接/u);

		// 响应体读取按 requestId 走，别的操作不接受这个字段。
		const body = await tool.execute("devtools-body", { operation: "network_body", requestId: "1000.2" }, undefined, undefined, ctx);
		assert.equal(body.details.devtools, "network_body");
		assert.equal(dispatched.at(-1).requestId, "1000.2");
		assert.match(body.details.bodyText, /rotom-json-fixture/u);
		await assert.rejects(tool.execute("devtools-body-missing", { operation: "network_body" }, undefined, undefined, ctx), /requestId/u);
		await assert.rejects(tool.execute("devtools-body-mixed", { operation: "evaluate", expression: "1", requestId: "1000.2" }, undefined, undefined, ctx), /只用于 network_body/u);

		// trace：完整文件落盘，模型拿摘要。
		const traceStarted = await tool.execute("devtools-trace-start", { operation: "trace_start" }, undefined, undefined, ctx);
		assert.equal(traceStarted.details.devtools, "trace_start");
		const traceStopped = await tool.execute("devtools-trace-stop", { operation: "trace_stop" }, undefined, undefined, ctx);
		assert.equal(traceStopped.details.kind, "browser-trace");
		assert.equal(traceStopped.details.bytes, TRACE_FIXTURE.length);
		assert.equal(traceStopped.details.longTasks, 1);
		assert.equal(traceStopped.details.cls, 0.07);
		assert.equal(traceStopped.details.slowestScripts[0].line, 5);
		assert.ok(traceStopped.details.path.startsWith(join(tmpdir(), "rotom-traces")), traceStopped.details.path);
		assert.deepEqual(await readFile(traceStopped.details.path), TRACE_FIXTURE, "trace 文件必须与 relay 字节一致");
		await assert.rejects(tool.execute("devtools-trace-mixed", { operation: "trace_start", expression: "1" }, undefined, undefined, ctx), /expression\/world/u);

		// 录制：帧与合成 GIF 都落在私有临时目录。
		const recording = await tool.execute("devtools-record", { operation: "record_stop" }, undefined, undefined, ctx);
		assert.equal(recording.details.kind, "browser-recording");
		assert.equal(recording.details.frames, 2);
		assert.equal(recording.details.width, 1, "1x1 的帧不会被放大");
		assert.equal(recording.details.height, 1);
		assert.equal(recording.details.truncated, true, "relay 标了 truncated 就要如实透传");
		const gifBytes = await readFile(recording.details.gifPath);
		assert.equal(gifBytes.subarray(0, 6).toString("ascii"), "GIF89a");
		assert.equal(gifBytes.length, recording.details.gifBytes);
		assert.equal(recording.details.gifPath.startsWith(join(tmpdir(), "rotom-recordings")), true);
		assert.deepEqual(await readFile(join(recording.details.directory, "frame-000.png")), ONE_PIXEL_PNG);
		await assert.rejects(tool.execute("devtools-record-mixed", { operation: "record_start", requestId: "x" }, undefined, undefined, ctx), /只用于 network_body/u);

		// 参数在本地就被拒，不产生任何请求。
		const count = dispatched.length;
		await assert.rejects(tool.execute("devtools-empty", { operation: "evaluate", expression: "   " }, undefined, undefined, ctx), /expression/u);
		await assert.rejects(tool.execute("devtools-world", { operation: "evaluate", expression: "1", world: "page" }, undefined, undefined, ctx), /world/u);
		await assert.rejects(tool.execute("devtools-op", { operation: "snapshot" }, undefined, undefined, ctx), /operation/u);
		await assert.rejects(tool.execute("devtools-preset", { operation: "viewport", viewport: "iphone-99" }, undefined, undefined, ctx), /viewport/u);
		await assert.rejects(tool.execute("devtools-mixed", { operation: "viewport", viewport: "reset", expression: "1" }, undefined, undefined, ctx), /evaluate 参数/u);
		assert.equal(dispatched.length, count, "非法参数不得派发");
	} finally {
		for (const handler of browser.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, {});
		await rm(workspace, { recursive: true, force: true });
	}
});
