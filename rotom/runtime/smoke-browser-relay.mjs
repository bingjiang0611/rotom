#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { BrowserRelayClientV1 } from "../extensions/browser/browser-relay.ts";

const extensionDir = resolve("rotom/extensions/browser/chrome-extension");
const chromeExecutable = process.env.ROTOM_CHROME_EXECUTABLE;
const profileDir = chromeExecutable ? await mkdtemp(resolve(tmpdir(), "rotom-browser-profile-")) : undefined;
const frameServer = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end("<!doctype html><title>M7 frame</title><h2>Cross-origin frame ready</h2><div role='region' aria-label='Frame records' style='height:100px;overflow-y:auto'><div style='height:700px'>Frame rows 1-15</div></div><div role='status' id='frame-status'>Frame top</div><script>document.querySelector('[role=region]').addEventListener('scroll',()=>{document.querySelector('#frame-status').textContent='Frame rows 16-30 loaded'})</script>");
});
await new Promise((resolveReady, reject) => { frameServer.once("error", reject); frameServer.listen(0, "::", resolveReady); });
const frameAddress = frameServer.address();
if (!frameAddress || typeof frameAddress === "string") throw new Error("fixture frame address 无效");
const frameUrl = `http://localhost:${frameAddress.port}/frame`;
const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(`<!doctype html><title>M7 relay smoke</title><main><h1>Background relay ready</h1><iframe title="Cross-origin fixture" src="${frameUrl}"></iframe><label>Draft <input aria-label='Draft title'></label><label>Password <input type='password' autocomplete='current-password' aria-label='Account password'></label><a href='/download' download='fixture.txt'>Download fixture</a><a href='/popup' target='_blank'>Open another context</a><button id='popup'>Script popup</button><label style='display:block;margin-top:120px'>Mode <select aria-label='Mode'><option>Draft</option><option>Published</option></select></label><div role='status' id='mode'>Mode: Draft</div><button id='save' style='display:block;margin-top:120px;padding:0'><span style='display:block;padding:8px 12px'>Save draft</span></button><div role='status' id='status'>Not saved</div><div id='virtual-records' role='region' aria-label='Virtual records' style='height:100px;overflow-y:auto'><div style='height:700px'>Virtualized table viewport</div></div><div role='status' id='virtual-status'>Virtual rows 1-15</div><div style='position:relative;width:max-content;margin-top:120px'><button id='covered'>Covered action</button><div aria-hidden='true' style='position:absolute;inset:0'></div></div><div style='height:1800px'></div><button id='offscreen'>Offscreen action</button><div role='status' id='offscreen-status'>Offscreen pending</div><div role='status' id='scroll-status'>Top</div><script>document.querySelector('select').addEventListener('change',(event)=>{document.querySelector('#mode').textContent='Mode: '+event.target.value});document.querySelector('#save').addEventListener('click',()=>{document.querySelector('#status').textContent='Saved: '+document.querySelector('input[aria-label="Draft title"]' ).value});document.querySelector('#offscreen').addEventListener('click',()=>{document.querySelector('#offscreen-status').textContent='Offscreen clicked'});document.querySelector('#virtual-records').addEventListener('scroll',()=>{document.querySelector('#virtual-status').textContent='Virtual rows 16-30 loaded'});document.querySelector('#popup').addEventListener('click',()=>window.open('/popup'));addEventListener('scroll',()=>{document.querySelector('#scroll-status').textContent='Scrolled'})</script></main>`);
});
await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveReady); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture HTTP address 无效");
const url = `http://127.0.0.1:${address.port}/smoke?secret=must-not-log#fragment`;
const chrome = chromeExecutable ? spawn(chromeExecutable, [
	`--user-data-dir=${profileDir}`,
	`--disable-extensions-except=${extensionDir}`,
	`--load-extension=${extensionDir}`,
	"--no-first-run", "--no-default-browser-check", "--disable-component-update", "--new-window", "about:blank",
], { detached: true, stdio: "ignore" }) : undefined;

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
let client;
let peer;
try {
	let lastError;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try { client = await BrowserRelayClientV1.connect({ sessionId: "m7-browser-relay-smoke", timeoutMs: 1_000 }); break; }
		catch (error) { lastError = error; await pause(250); }
	}
	if (!client) throw new Error("Chrome extension 未在 20 秒内建立 Native Messaging relay", { cause: lastError });
	peer = await BrowserRelayClientV1.connect({ sessionId: "m7-browser-relay-smoke-peer", timeoutMs: 5_000 });
	const relayRequest = async (relay, label, operation, payload, timeoutMs) => {
		try { return await relay.request(operation, payload, { timeoutMs }); }
		catch (error) { throw new Error(`Chrome relay L2 ${label}/${operation} 阶段失败`, { cause: error }); }
	};
	const request = (operation, payload, timeoutMs) => relayRequest(client, "primary", operation, payload, timeoutMs);
	const peerRequest = (operation, payload, timeoutMs) => relayRequest(peer, "peer", operation, payload, timeoutMs);
	await Promise.all([request("close", { all: true }, 5_000), peerRequest("close", { all: true }, 5_000)]);
	const [opened, peerOpened] = await Promise.all([
		request("open", { tabName: "smoke", url }, 10_000),
		peerRequest("open", { tabName: "peer-smoke", url }, 10_000),
	]);
	assert.equal(opened.kind, "rotom-browser-observation");
	assert.equal(opened.tabName, "smoke");
	assert.equal(peerOpened.tabName, "peer-smoke");
	const [waited, peerWaited] = await Promise.all([
		request("wait", { tabName: "smoke", status: "complete", timeoutMs: 10_000 }, 11_000),
		peerRequest("wait", { tabName: "peer-smoke", status: "complete", timeoutMs: 10_000 }, 11_000),
	]);
	assert.equal(waited.status, "complete"); assert.equal(peerWaited.status, "complete");
	const [primaryTabs, peerTabs] = await Promise.all([request("tabs", {}, 5_000), peerRequest("tabs", {}, 5_000)]);
	assert.deepEqual(primaryTabs.tabs.map((tab) => tab.name), ["smoke"]);
	assert.deepEqual(peerTabs.tabs.map((tab) => tab.name), ["peer-smoke"]);
	const [snapshot, peerSnapshot] = await Promise.all([request("snapshot", { tabName: "smoke" }, 10_000), peerRequest("snapshot", { tabName: "peer-smoke" }, 10_000)]);
	assert.equal(peerSnapshot.nodes.some((node) => node.name.includes("Background relay ready")), true);
	assert.equal(snapshot.nodes.some((node) => node.role === "heading" && node.name === "Background relay ready"), true, JSON.stringify(snapshot.nodes));
	assert.equal(snapshot.nodes.some((node) => node.role === "document-text" && node.name.includes("Background relay ready")), true, "snapshot 必须包含固定 rendered-text 正文节点");
	const textbox = snapshot.nodes.find((node) => node.role === "textbox" && node.name === "Draft title");
	const button = snapshot.nodes.find((node) => node.role === "button" && node.name === "Save draft");
	assert.ok(textbox); assert.ok(button);
	const password = snapshot.nodes.find((node) => node.name === "Account password");
	const download = snapshot.nodes.find((node) => node.role === "link" && node.name === "Download fixture");
	const anotherContext = snapshot.nodes.find((node) => node.role === "link" && node.name === "Open another context");
	const popup = snapshot.nodes.find((node) => node.role === "button" && node.name === "Script popup");
	const covered = snapshot.nodes.find((node) => node.role === "button" && node.name === "Covered action");
	const offscreen = snapshot.nodes.find((node) => node.role === "button" && node.name === "Offscreen action");
	const virtualRecords = snapshot.nodes.find((node) => node.role === "region" && node.name === "Virtual records");
	const frameRecords = snapshot.nodes.find((node) => node.role === "region" && node.name === "Frame records");
	assert.equal(snapshot.nodes.some((node) => node.name === "Cross-origin frame ready"), true, JSON.stringify(snapshot.nodes));
	assert.ok(password); assert.ok(download); assert.ok(anotherContext); assert.ok(popup); assert.ok(covered); assert.ok(offscreen); assert.ok(virtualRecords); assert.ok(frameRecords);
	const offscreenClick = await request("interact", { actionId: "smoke-offscreen", tabName: "smoke", action: "click", targetRef: offscreen.ref }, 10_000);
	assert.equal(offscreenClick.readback.nodes.some((node) => node.role === "document-text" && node.name.includes("Offscreen clicked")), true, `视口外目标必须由后台 CDP 自动滚入视口后点击：${JSON.stringify(offscreenClick)}`);
	await request("interact", { actionId: "smoke-password", tabName: "smoke", action: "type", targetRef: password.ref, text: "trusted-local-secret", replace: true }, 10_000);
	const coveredClick = await request("interact", { actionId: "smoke-covered", tabName: "smoke", action: "click", targetRef: covered.ref }, 10_000);
	assert.equal(coveredClick.acknowledged, true, "遮挡层按真实鼠标命中处理，不再由 relay 拒绝");
	await request("interact", { actionId: "smoke-type", tabName: "smoke", action: "type", targetRef: textbox.ref, text: "M7 direct", replace: true }, 10_000);
	const afterType = await request("snapshot", { tabName: "smoke" }, 5_000);
	const select = afterType.nodes.find((node) => node.role === "combobox" && node.name === "Mode");
	assert.ok(select);
	await request("interact", { actionId: "smoke-select", tabName: "smoke", action: "select", targetRef: select.ref, option: "Published" }, 10_000);
	const afterSelect = await request("snapshot", { tabName: "smoke" }, 5_000);
	assert.equal(afterSelect.nodes.some((node) => node.name === "Mode: Published"), true, JSON.stringify(afterSelect.nodes));
	const currentButton = afterSelect.nodes.find((node) => node.role === "button" && node.name === "Save draft");
	assert.ok(currentButton);
	await request("interact", { actionId: "smoke-click", tabName: "smoke", action: "click", targetRef: currentButton.ref }, 10_000);
	const afterClick = await request("snapshot", { tabName: "smoke" }, 5_000);
	assert.equal(afterClick.nodes.some((node) => node.name === "Saved: M7 direct"), true, JSON.stringify(afterClick.nodes));
	let spawnedTabsStayedInactive = false;
	if (chrome) {
		const popupClick = await request("interact", { actionId: "smoke-popup", tabName: "smoke", action: "click", targetRef: popup.ref }, 10_000);
		const linkClick = await request("interact", { actionId: "smoke-new-context", tabName: "smoke", action: "click", targetRef: anotherContext.ref }, 10_000);
		assert.equal(popupClick.effect.backgroundPreserved, true, JSON.stringify(popupClick.effect));
		assert.equal(linkClick.effect.backgroundPreserved, true, JSON.stringify(linkClick.effect));
		assert.ok(popupClick.effect.spawnedTabs >= 1); assert.ok(linkClick.effect.spawnedTabs >= 1);
		const discovered = await request("discover", {}, 5_000);
		const spawned = discovered.tabs.filter((tab) => new URL(tab.url).pathname === "/popup");
		assert.ok(spawned.length >= 2, JSON.stringify(discovered.tabs));
		assert.equal(spawned.every((tab) => tab.browserActive === false), true, "popup/target=_blank 新标签必须保持后台");
		spawnedTabsStayedInactive = true;
	}
	const nestedScrolled = await request("interact", { actionId: "smoke-nested-scroll", tabName: "smoke", action: "scroll", targetRef: virtualRecords.ref, direction: "down", amount: 300 }, 10_000);
	assert.equal(nestedScrolled.effect.scrollAfter > nestedScrolled.effect.scrollBefore, true, JSON.stringify(nestedScrolled.effect));
	assert.equal(nestedScrolled.effect.scrollScope, "nearest");
	assert.equal(nestedScrolled.readback.nodes.some((node) => node.role === "document-text" && node.name.includes("Virtual rows 16-30 loaded")), true, JSON.stringify(nestedScrolled.readback.nodes));
	const frameScrolled = await request("interact", { actionId: "smoke-frame-scroll", tabName: "smoke", action: "scroll", targetRef: frameRecords.ref, direction: "down", amount: 300 }, 10_000);
	assert.equal(frameScrolled.effect.scrollAfter > frameScrolled.effect.scrollBefore, true, JSON.stringify(frameScrolled.effect));
	assert.equal(frameScrolled.readback.nodes.some((node) => node.role === "document-text" && node.name.includes("Frame rows 16-30 loaded")), true, JSON.stringify(frameScrolled.readback.nodes));
	const scrolled = await request("interact", { actionId: "smoke-scroll", tabName: "smoke", action: "scroll", direction: "down", amount: 700 }, 10_000);
	assert.equal(scrolled.effect.scrollAfter > scrolled.effect.scrollBefore, true, JSON.stringify(scrolled.effect));
	const tabs = await request("tabs", {}, 5_000);
	const smokeTab = tabs.tabs.find((tab) => tab.name === "smoke");
	assert.ok(smokeTab);
	assert.equal(smokeTab.browserActive, false, "extension 创建的标签不得成为 Chrome active tab");
	const screenshot = await request("screenshot", { tabName: "smoke" }, 10_000);
	const image = Buffer.from(screenshot.data, "base64");
	assert.equal(screenshot.mimeType, "image/jpeg");
	assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8);
	const [closed, peerClosed] = await Promise.all([request("close", { all: true }, 5_000), peerRequest("close", { all: true }, 5_000)]);
	assert.equal(closed.closed, 1); assert.equal(peerClosed.closed, 1);
	process.stdout.write(`${JSON.stringify({ schemaVersion: 1, chromeMode: chrome ? "isolated-executable" : "existing-user-chrome", extensionLoaded: true, nativeMessaging: true, trustedLocalUnrestricted: true, renderedDocumentText: true, nonDestructiveTimeout: true, directInteraction: true, cdpMouse: true, oopifAccessibility: true, backgroundTabStayedInactive: true, spawnedTabsStayedInactive, snapshotNodes: snapshot.nodes.length, interaction: { type: true, click: true, coveredClickDispatched: true, select: true, scroll: true, targetedScroll: true, frameScroll: true, virtualRowsLoaded: true, lightweightReadback: true, passwordInputAllowed: true, downloadGateRemoved: true, newContextGateRemoved: true, popupGateRemoved: true }, screenshotBytes: image.length, closeConfirmed: true })}\n`);
} finally {
	client?.close();
	peer?.close();
	const serverClosed = new Promise((resolveClosed) => server.close(resolveClosed));
	server.closeAllConnections();
	await serverClosed;
	const frameServerClosed = new Promise((resolveClosed) => frameServer.close(resolveClosed));
	frameServer.closeAllConnections();
	await frameServerClosed;
	if (Number.isInteger(chrome?.pid)) {
		try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* already exited */ }
		await pause(1_000);
		try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already exited */ }
	}
	if (profileDir) await rm(profileDir, { recursive: true, force: true });
}
