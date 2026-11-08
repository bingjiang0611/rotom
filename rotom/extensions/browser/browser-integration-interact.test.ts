import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserIntegrationFixture } from "./browser-test-helpers.ts";

test("browser relay：交互、重试边界与坐标动作保持 observation-bound", async (t) => {
	const fixture = await createBrowserIntegrationFixture();
	const { session, ctx, tool, interact, calls, tabs } = fixture;
	try {
		await tool.execute("fixture-docs", { operation: "open", tabName: "docs", url: "https://example.test/path?token=secret#fragment", limit: 10 }, undefined, undefined, ctx);
		const typed = await interact.execute("browser-interact-type", { operation: "execute", tabName: "docs", action: "type", targetRef: "ax_1_1", text: "Authorization: Bearer secret-token-123456789", replace: true }, undefined, undefined, ctx);
		assert.equal(typed.details.acknowledged, true);
		assert.equal(typed.details.businessOutcome, "unverified");
		assert.equal(fixture.confirms, 0, "本机直连不调用确认 UI");
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
		fixture.state.body = "Changed body";
		assert.equal((await readback()).nodes.filter((node: any) => node.role === "document-text").length, 12);
		fixture.state.body = fixture.originalBody;
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
		fixture.state.textChunks = 180;
		const large = await interact.execute("delta-paginated", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2" }, undefined, undefined, ctx);
		assert.ok(large.details.readback.nextCursor);
		assert.equal((await readback()).omittedUnchangedTextNodes, undefined, "never seed a baseline from partially delivered text");
		fixture.state.textChunks = 12;
		await assert.rejects(() => interact.execute("browser-interact-expect-scroll", { operation: "execute", tabName: "docs", action: "scroll", direction: "down", expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
		await assert.rejects(() => interact.execute("browser-interact-expect-syntax", { operation: "execute", tabName: "docs", action: "click", targetRef: "ax_1_2", expect: "document.title" }, undefined, undefined, ctx), /interaction expect must be/u, "非法判据必须在本地拒绝，不发到 relay");
		await assert.rejects(() => interact.execute("browser-interact-expect-coordinate", { operation: "execute", tabName: "docs", action: "click", x: 10, y: 10, observationEpoch: 7, expect: "checked=true" }, undefined, undefined, ctx), /expect 仅允许带 targetRef/u);
		fixture.state.interactFailure = "browser relay interact timeout";
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
		fixture.state.interactFailure = "browser relay interact timeout";
		await assert.rejects(() => interact.execute("browser-key-timeout", { operation: "execute", tabName: "docs", action: "keypress", targetRef: "ax_1_1", key: "Enter" }, undefined, undefined, ctx), /unknown.*只读核对.*禁止重发/su);
		assert.equal(calls.filter((call) => call.operation === "interact").length, beforeInvalid + 1, "未知按键只派发一次");
		fixture.state.interactFailure = "browser relay interact timeout";
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
		const confirmationsBeforeScroll = fixture.confirms;
		const scrolled = await interact.execute("browser-interact-scroll", { operation: "execute", tabName: "docs", action: "scroll", targetRef: "ax_1_2", direction: "down", amount: 40_000 }, undefined, undefined, ctx);
		assert.equal(scrolled.details.effect.scrollScope, "nearest");
		assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.targetRef, "ax_1_2");
		assert.equal(calls.filter((call) => call.operation === "interact").at(-1)?.payload.amount, 40_000);
		assert.equal(fixture.confirms, confirmationsBeforeScroll, "scroll 也不调用确认 UI");
		await assert.rejects(() => tool.execute("browser-file", { operation: "open", tabName: "bad", url: "file:///etc/passwd" }, undefined, undefined, ctx), /http|https|URL/u);
		assert.equal(calls.some((call) => call.payload.tabName === "bad"), false);

	} finally {
		await fixture.cleanup();
	}
});
