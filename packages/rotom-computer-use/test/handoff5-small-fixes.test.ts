import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MacosHelperClient } from "../src/platform/macos/helper.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ensureDaemon preserves the original launchDaemon error rather than hiding it", async () => {
	const client = new MacosHelperClient();
	const original = new Error("launch failed for a concrete reason");
	let launches = 0;
	client.daemonCommand = async () => { throw new Error("no listener"); };
	client.launchDaemon = async () => { launches++; throw original; };
	await assert.rejects(client.ensureDaemon(), (error) => error === original);
	assert.equal(launches, 1);
});

test("external socket failure explains serve --socket and never launches a helper", () => {
	const module = new URL("../src/platform/macos/helper.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		const {MacosHelperClient} = await import(${JSON.stringify(module)});
		const client = new MacosHelperClient();
		client.daemonCommand = async () => { throw new Error('no listener'); };
		await assert.rejects(client.ensureDaemon(), /No helper is listening on the external socket.*serve --socket \\/tmp\\/cu-h5-no-helper.sock/);
	`], { env: { ...process.env, PI_CU_SOCKET_PATH: "/tmp/cu-h5-no-helper.sock" }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
});

test("H2 branches on the real TIS source; plain layouts and pinned transports retain keys", () => {
	const source = read("../native/macos/input_source.swift");
	const bridge = read("../native/macos/bridge.swift");
	assert.match(source, /TISCopyCurrentKeyboardInputSource/);
	assert.match(source, /kTISPropertyInputSourceType/);
	assert.match(source, /kTISTypeKeyboardInputMode/);
	assert.match(bridge, /if InputSourcePolicy\.currentPrefersAX\(requireTransport: requireTransport\), let element, !text\.isEmpty, insertTextAtCaret/);
	assert.match(bridge, /try postUnicodeText\(text, pid: pid, delivery: delivery\)/);
});

test("K1 reads TIS only on main and exercises the worker-to-main hop", () => {
	const source = read("../native/macos/input_source.swift");
	assert.match(source, /if Thread\.isMainThread/);
	assert.match(source, /DispatchQueue\.main\.sync \{ currentInputSourceType\(\) \}/);
	assert.match(source, /private static func currentInputSourceType\(\)[\s\S]*?precondition\(Thread\.isMainThread\)[\s\S]*?TISCopyCurrentKeyboardInputSource/);
	assert.match(source, /precondition\(!Thread\.isMainThread\)/);
	assert.match(source, /DispatchQueue\.global\(qos: \.userInitiated\)\.async\(execute: background\)/);
	assert.match(source, /RunLoop\.current\.run/);
});

test("native pause gates cover post boundaries, focus and AX writes; resume uses target identity", () => {
	const source = read("../native/macos/bridge.swift");
	const state = read("../native/macos/takeover_state.swift");
	assert.match(source, /takeoverState\.admitWrite\(expected: requestTakeoverId\) \} catch \{ return \.cannotComplete \}\s*return ApplicationServices\.AXUIElementSetAttributeValue/);
	assert.match(source, /takeoverState\.admitWrite\(expected: requestTakeoverId\) \} catch \{ return \.cannotComplete \}\s*return ApplicationServices\.AXUIElementPerformAction/);
	assert.match(source, /guardedActivate/);
	assert.match(source, /app\.launchDate == state\.launchDate/);
	assert.match(source, /pidForWindowId\(state\.windowId\) == state\.pid/);
	assert.match(state, /quietSeconds: TimeInterval = 30/);
	assert.match(state, /pauseTimeout: TimeInterval = 120/);
	assert.match(state, /maxResumes = 3/);
	assert.match(state, /maxDuration: TimeInterval = 600/);
});

test("the fake script never consults the operator input source", () => {
	const source = read("../scripts/cu-v2-l2-check.mjs");
	assert.match(source, /const inputSource = fake \? fake\.inputSource : inputSourceInfo\(\)/);
});

test("protocol documentation says 9 and retains the cooperative arbitration boundary", () => {
	const doc = read("../../../CLAUDE.md");
	assert.match(doc, /helper 协议已升到 9/);
	assert.match(doc, /协作式/);
	assert.doesNotMatch(doc, /helper 协议已升到 8/);
});
