#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RESOURCE_DESCRIPTORS_V1 } from "./product-config.mjs";
import { verifyPiRuntime } from "./verify-pi-runtime.mjs";

const [piExecutable, agentDirInput] = process.argv.slice(2);
if (!piExecutable || !agentDirInput) throw new Error("用法：smoke-browser-interaction.mjs <pi-executable> <agent-dir>");
const agentDir = resolve(agentDirInput);
const resourceDeclarations = RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
const verified = await verifyPiRuntime({ executable: piExecutable, agentDir, resourceDeclarations });
const piDist = dirname(verified.publicEntry);
const [{ loadExtensions }, { SessionManager }] = await Promise.all([
	import(pathToFileURL(join(piDist, "core/extensions/loader.js")).href),
	import(pathToFileURL(join(piDist, "core/session-manager.js")).href),
]);
const workspace = await mkdtemp(join(tmpdir(), "rotom-browser-interaction-"));
const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end("<!doctype html><title>M7-B interaction smoke</title><label>Draft <input aria-label='Draft title'></label><label>Required <input aria-label='Required note' required></label><label>Redirect (Callback) URLs <input id='callback' aria-label='Redirect (Callback) URLs'></label><div role='status' id='callback-tags'>No callbacks</div><button id='save' style='display:block;margin-top:240px'>Save draft</button><div role='status' id='status'>Not saved</div><canvas id='canvas' width='120' height='80' style='position:fixed;left:40px;top:40px;width:120px;height:80px;background:#3a7;z-index:10'></canvas><div role='status' id='canvas-status'>Canvas idle</div><script>document.querySelector('#callback').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();document.querySelector('#callback-tags').textContent='Callback added: '+event.target.value;event.target.value=''}});document.querySelector('#save').addEventListener('click',()=>{document.querySelector('#status').textContent='Saved: '+document.querySelector('input').value});document.querySelector('#canvas').addEventListener('click',()=>{document.querySelector('#canvas-status').textContent='Canvas clicked'})</script>");
});
await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(0, "::1", resolveReady); });
const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address 无效");
const targetUrl = `http://m7b.localhost:${address.port}/m7b`;
let loaded; let context;
try {
	loaded = await loadExtensions([resolve(agentDir, "extensions/browser/index.ts")], workspace);
	assert.deepEqual(loaded.errors, []);
	const session = SessionManager.inMemory(workspace);
	session.appendMessage({ role: "user", content: [{ type: "text", text: "在本地页面验证 M7-B direct-action-readback" }], timestamp: Date.now() });
	loaded.runtime.appendEntry = (customType, data) => session.appendCustomEntry(customType, data);
	let activeTools = ["browser_inspect", "browser_interact"];
	loaded.runtime.getActiveTools = () => [...activeTools]; loaded.runtime.setActiveTools = (tools) => { activeTools = [...tools]; };
	loaded.runtime.getAllTools = () => []; loaded.runtime.getCommands = () => []; loaded.runtime.refreshTools = () => {};
	context = { cwd: workspace, sessionManager: session, mode: "print", hasUI: false, isProjectTrusted: () => false, ui: { notify() {}, setStatus() {}, theme: { fg: (_color, value) => value } } };
	const browser = loaded.extensions.find((extension) => extension.path === resolve(agentDir, "extensions/browser/index.ts"));
	assert.ok(browser);
	for (const handler of browser.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, context);
	const inspect = browser.tools.get("browser_inspect").definition;
	const interact = browser.tools.get("browser_interact").definition;
	const opened = await inspect.execute("m7b-open", { operation: "open", tabName: "m7b", url: targetUrl, limit: 100 }, undefined, undefined, context);
	let nodes = opened.details.observation.nodes;
	if (!nodes.some((node) => node.role === "textbox")) {
		const waited = await inspect.execute("m7b-wait", { operation: "wait", tabName: "m7b", status: "complete", timeoutMs: 10_000, limit: 100 }, undefined, undefined, context);
		nodes = waited.details.observation.nodes;
	}
	const textbox = nodes.find((node) => node.role === "textbox" && node.name === "Draft title"); assert.ok(textbox, JSON.stringify(nodes));
	const typed = await interact.execute("m7b-type", { operation: "execute", tabName: "m7b", action: "type", targetRef: textbox.ref, text: "M7-B direct", replace: true, expect: "value=nonempty" }, undefined, undefined, context);
	assert.equal(typed.details.acknowledged, true); assert.equal(typed.details.businessOutcome, "unverified");
	assert.deepEqual(typed.details.effect.expectation, { requested: "value=nonempty", outcome: "met" }, JSON.stringify(typed.details.effect));
	assert.equal(typed.details.effect.target.changed, true, JSON.stringify(typed.details.effect));
	// 未填的 required 字段的原生校验文案不在 accessibility tree 里，只能从 page-alert 节点看到；
	// 文案本身随 Chrome 语言变化，所以只断言它存在且只读。
	const alertNode = typed.details.readback.observation.nodes.find((node) => node.role === "page-alert");
	assert.ok(alertNode?.name?.length > 0 && alertNode.states.includes("read-only=true"), JSON.stringify(typed.details.readback.observation.nodes));
	const snapshot = await inspect.execute("m7b-snapshot-visible", { operation: "snapshot_visible", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	const button = snapshot.details.observation.nodes.find((node) => node.role === "button" && node.name === "Save draft"); assert.ok(button);
	const clicked = await interact.execute("m7b-click", { operation: "execute", tabName: "m7b", action: "click", targetRef: button.ref }, undefined, undefined, context);
	assert.equal(clicked.details.acknowledged, true);
	const callbackSnapshot = await inspect.execute("m7b-callback-snapshot", { operation: "snapshot_visible", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	const callback = callbackSnapshot.details.observation.nodes.find((node) => node.role === "textbox" && node.name === "Redirect (Callback) URLs"); assert.ok(callback);
	await interact.execute("m7b-callback-type", { operation: "execute", tabName: "m7b", action: "type", targetRef: callback.ref, text: "http://127.0.0.1:17472/oauth/callback", replace: true }, undefined, undefined, context);
	const beforeEnter = await inspect.execute("m7b-before-enter", { operation: "snapshot_visible", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	assert.equal(beforeEnter.details.observation.nodes.some((node) => node.role === "document-text" && node.name.includes("Callback added:")), false, "type alone must not commit tags");
	const callbackRef = beforeEnter.details.observation.nodes.find((node) => node.role === "textbox" && node.name === "Redirect (Callback) URLs")?.ref; assert.ok(callbackRef);
	const committed = await interact.execute("m7b-enter", { operation: "execute", tabName: "m7b", action: "keypress", targetRef: callbackRef, key: "Enter", expect: "value=empty" }, undefined, undefined, context);
	assert.equal(committed.details.effect.focusVerified, true);
	assert.deepEqual(committed.details.effect.expectation, { requested: "value=empty", outcome: "met" });
	assert.equal(committed.details.businessOutcome, "unverified");
	const afterEnter = await inspect.execute("m7b-after-enter", { operation: "snapshot_visible", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	assert.equal(afterEnter.details.observation.nodes.some((node) => node.role === "document-text" && node.name.includes("Callback added: http://127.0.0.1:17472/oauth/callback")), true, JSON.stringify(afterEnter.details));
	const staleScreenshot = await inspect.execute("m7b-coordinate-screenshot-stale", { operation: "screenshot", tabName: "m7b" }, undefined, undefined, context);
	assert.equal(staleScreenshot.content.some((part) => part.type === "image"), true);
	await inspect.execute("m7b-coordinate-invalidate", { operation: "snapshot_visible", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	await assert.rejects(() => interact.execute("m7b-coordinate-stale", { operation: "execute", tabName: "m7b", action: "click", x: 100, y: 80, observationEpoch: staleScreenshot.details.observationEpoch }, undefined, undefined, context), /screenshot|epoch|stale/u);
	const screenshot = await inspect.execute("m7b-coordinate-screenshot", { operation: "screenshot", tabName: "m7b" }, undefined, undefined, context);
	const coordinateClicked = await interact.execute("m7b-coordinate-click", { operation: "execute", tabName: "m7b", action: "click", x: 100, y: 80, observationEpoch: screenshot.details.observationEpoch }, undefined, undefined, context);
	assert.equal(coordinateClicked.details.effect.coordinate, true);
	assert.equal(coordinateClicked.details.effect.hitTested, true);
	assert.equal(coordinateClicked.details.effect.hitNodeName, "canvas");
	const readback = await inspect.execute("m7b-readback", { operation: "snapshot", tabName: "m7b", limit: 100 }, undefined, undefined, context);
	assert.equal(readback.details.observation.nodes.some((node) => node.role === "document-text" && node.name.includes("Saved: M7-B direct") && node.name.includes("Canvas clicked")), true, JSON.stringify(readback.details));
	assert.equal(readback.details.observation.contentCoverage, "scroll-end");
	assert.equal(readback.details.observation.contentComplete, true);
	const audits = session.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "rotom-browser-interaction-audit/v1");
	assert.equal(audits.filter((entry) => entry.data?.kind === "rotom-browser-interaction-intent").length, 6);
	assert.equal(audits.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal" && entry.data?.status === "ok").length, 5);
	assert.equal(audits.some((entry) => entry.data?.expectationOutcome === "met" && entry.data?.targetChanged === true), true, "audit 必须保留期望结果 metadata");
	assert.equal(audits.filter((entry) => entry.data?.kind === "rotom-browser-interaction-terminal" && entry.data?.status === "unknown").length, 1);
	assert.equal(JSON.stringify(audits).includes("M7-B direct"), false);
	const tabs = await inspect.execute("m7b-tabs", { operation: "tabs" }, undefined, undefined, context);
	assert.equal(tabs.details.tabs.find((tab) => tab.name === "m7b")?.current, true);
	await inspect.execute("m7b-close", { operation: "close", tabName: "m7b" }, undefined, undefined, context);
	process.stdout.write(`${JSON.stringify({ schemaVersion: 1, chrome: "existing-user-chrome", directActionReadback: true, actions: ["type", "keypress", "ref-click", "coordinate-click"], callbackTagCommitted: true, staleCoordinateRejected: true, coordinateHitTested: true, targetStateObserved: true, expectationOutcome: "met", pageAlertReadback: true, confirmations: 0, auditIntentTerminalPairs: 6, inputRedactedFromAudit: true, businessOutcomeInference: "unverified", closed: true })}\n`);
} finally {
	if (loaded && context) for (const extension of [...loaded.extensions].reverse()) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, context);
	server.closeAllConnections();
	await new Promise((resolveClosed) => server.close(resolveClosed));
	await rm(workspace, { recursive: true, force: true });
}
