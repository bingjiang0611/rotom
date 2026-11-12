import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.resolve(import.meta.dirname, "..", "native", "macos", "bridge.swift"), "utf8");
const start = source.indexOf("\tprivate func postEvent(");
const end = source.indexOf("\n\t/// Private SkyLight entry point", start);
const postEvent = source.slice(start, end);

test("background delivery never warps the session cursor", () => {
	assert.doesNotMatch(source, /CGWarpMouseCursorPosition|CGAssociateMouseAndMouseCursorPosition/);
	assert.ok(start >= 0 && end > start, "postEvent source is present");
	assert.ok(postEvent.indexOf('if delivery == "l2"') < postEvent.indexOf('event.post(tap: .cghidEventTap)'));
	assert.ok(postEvent.indexOf('if delivery == "pid"') < postEvent.indexOf('event.post(tap: .cghidEventTap)'));
	assert.match(postEvent, /if delivery == "l2"[\s\S]*?return[\s\S]*?if delivery == "pid"[\s\S]*?return[\s\S]*?recordAgentHidEvent\(\)[\s\S]*?event\.post\(tap: \.cghidEventTap\)/);
});

test("helper exposes the checked background-delivery invariant and HID-post counter", () => {
	assert.match(source, /background-delivery-no-cursor-warp/);
	assert.match(source, /private var agentHidEventCount = 0/);
	assert.match(source, /"agentHidEventCount": agentHidEvents/);
	assert.match(source, /report\("HID counter explicit"/);
});

test("helper reports how long its tap has continuously observed user input", () => {
	assert.match(source, /private var listeningSinceAt: TimeInterval = 0/);
	assert.match(source, /"listeningSeconds": listeningSince == 0 \? 0 : max/);
});
