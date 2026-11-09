import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrokerCore } from "../src/broker/core.ts";
import { BROKER_PROTOCOL_VERSION, type BrokerEvent } from "../src/broker/protocol.ts";
import { TraceRecorder } from "../src/trace/recorder.ts";

const native = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
const state = readFileSync(new URL("../native/macos/takeover_state.swift", import.meta.url), "utf8");

test("only helper may report release metadata; extra content never reaches the agent", async () => {
	const core = new BrokerCore();
	const events: BrokerEvent[] = [];
	core.attachTransport({ send: (_agent, event) => { events.push(event); return true; }, connectedAgents: () => 2 });
	try {
		for (const [agentId, role] of [["a", "agent"], ["h", "helper"]] as const) await core.handle(undefined, { id: agentId, type: "hello", protocolVersion: BROKER_PROTOCOL_VERSION, agent: { agentId, role, pid: 1, pidChain: [], hasUI: false } });
		const request = { id: "release", type: "release_on_yield", targetAgentId: "a", releases: [{ kind: "modifier", code: 55, posted: true, text: "not trace content", x: 15 }] } as const;
		assert.equal((await core.handle("a", request as never)).ok, false);
		assert.equal(events.length, 0);
		assert.equal((await core.handle("h", request as never)).ok, true);
		assert.deepEqual(events, [{ event: "release_on_yield", agentId: "a", releases: [{ kind: "modifier", code: 55, posted: true }] }]);
		assert.equal((await core.handle("h", { ...request, releases: [{ kind: "mouseMove", code: 0, posted: true }] } as never)).ok, false);
		assert.equal((await core.handle("h", { ...request, releases: [{ kind: "button", code: -1, posted: true }] } as never)).ok, false);
		assert.equal(events.length, 1);
	} finally { core.close(); }
});

test("release trace stores only the code/category, alongside pause and resume", () => {
	const root = mkdtempSync(path.join(tmpdir(), "cu-yield-trace-"));
	try {
		const recorder = TraceRecorder.create({ sessionId: "offline", agentId: "a", root, enabled: true })!;
		recorder.record({ tool: "cu_session", status: "ok", evidence: "release_on_yield", releaseOnYield: { kind: "key", code: 0 } });
		recorder.record({ tool: "cu_session", status: "paused", evidence: "user_input_pause" });
		recorder.record({ tool: "cu_session", status: "resumed", evidence: "auto_resume" });
		const entries = readFileSync(recorder.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(entries.length, 3);
		assert.deepEqual(entries[0].releaseOnYield, { kind: "key", code: 0 });
		assert.doesNotMatch(JSON.stringify(entries), /"text"|"x"|"y"|"coordinates"|"unicode"/);
		recorder.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("native surrender tracks only the verified agent and never copies old event payloads", () => {
	const start = native.indexOf("\tprivate func trackHeldInput(");
	const end = native.indexOf("\tprivate func postTargetedEvent(", start);
	const tracking = native.slice(start, end);
	assert.match(tracking, /requestAgentId == state\.agentId/);
	assert.match(tracking, /TakeoverState\.transition/);
	assert.match(tracking, /takeoverState\.trackUp\(input\)/);
	assert.match(tracking, /CGEvent\(source: nil\)\?\.location/);
	assert.match(tracking, /eventSourceUserData, value: agentEventMarker/);
	assert.equal(tracking.match(/recordAgentHidEvent\(\)/g)?.length, 3, "each supported release transport is counted");
	assert.doesNotMatch(tracking, /event\.copy\(|release\.location\s*=|guardedActivate|focusTarget|CGWarpMouseCursorPosition/);
	assert.match(state, /mouseType: type, mouseCursorPosition: position/);
	assert.match(state, /virtualKey: code, keyDown: false/);
	assert.doesNotMatch(state.slice(state.indexOf("static func releaseEvent(")), /keyDown: true|\.mouseMoved|\.mouseDragged/);
});

test("successful L2 posting records held input, matching its surrender release branch", () => {
	const start = native.indexOf("\tprivate func postTargetedEvent(");
	const end = native.indexOf("\tprivate static let skyLightPostToPidSymbol", start);
	const targeted = native.slice(start, end);
	assert.match(targeted, /guard let post = skyLightPostToPid else \{ return false \}/);
	assert.match(targeted, /post\(pid, event\)\s*trackHeldInput\(event, pid: pid, delivery: "l2"\)\s*return true/);
});

test("interrupted native actions are unknown, stop the batch and cannot resume old text", () => {
	assert.match(native, /TakeoverState\.isInterruption\(failure\.code\) \? "unknown" : "didnt"/);
	assert.match(native, /takeoverState\.interrupted\(expected: requestTakeoverId\)/);
	assert.match(native, /enriched\["outcome"\] = "unknown"/);
	assert.match(state, /value\.sequence \+= 1/);
	assert.match(state, /yielding = true\s*let released = drainReleases\(\)\s*value\.pausedAt = now/);
	assert.match(state, /releases\.removeAll\(\)/);
	assert.match(state, /unresolved\.append\(contentsOf: results\.filter \{ !\$0\.posted \}/);
	assert.match(native, /if !takeoverState\.unresolvedInputs\.isEmpty \{ endTakeover\(reason: "release_failed"\)/);
});
