import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import { createMergedSessionWriter, isSessionStateKeyV3, LEGACY_SESSION_STATE_KEY_V1, LEGACY_SESSION_STATE_KEY_V2, legacyV1Sessions, legacyV2Sessions, serializeSessionStateV3, SESSION_STATE_KEY_PREFIX_V3, sessionStateKeyV3 } from "./chrome-extension/session-persistence.js";

const worker = await readFile(resolve("rotom/extensions/browser/chrome-extension/service-worker.js"), "utf8");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const sessionState = (sessionId, tabs = {}) => ({
	sessionId,
	agentId: "main",
	rootSessionId: sessionId,
	leaseToken: undefined,
	generation: "generation-1",
	currentTabName: Object.keys(tabs)[0],
	tabsByName: new Map(Object.entries(tabs).map(([name, item]) => [name, { documentGeneration: 1, url: "https://example.test/", status: "complete", ownership: "agent", ...item }])),
});

test("每个 session 一个 key，序列化带 principal 与 transfer 来源", () => {
	assert.equal(sessionStateKeyV3("session-1"), `${SESSION_STATE_KEY_PREFIX_V3}session-1`);
	assert.equal(isSessionStateKeyV3(sessionStateKeyV3("x")), true);
	assert.equal(isSessionStateKeyV3(LEGACY_SESSION_STATE_KEY_V2), false);
	assert.equal(isSessionStateKeyV3(`${SESSION_STATE_KEY_PREFIX_V3}`), false, "空前缀不算 V3 key");
	const serialized = serializeSessionStateV3(sessionState("session-1", { docs: { tabId: 7, targetId: "target-1", transferredFrom: "run_a" } }));
	assert.deepEqual(serialized, {
		schemaVersion: 3,
		sessionId: "session-1",
		agentId: "main",
		rootSessionId: "session-1",
		generation: "generation-1",
		keepTabs: false,
		currentTabName: "docs",
		tabs: [{ name: "docs", tabId: 7, targetId: "target-1", documentGeneration: 1, url: "https://example.test/", status: "complete", ownership: "agent", transferredFrom: "run_a" }],
	});
	const withLease = serializeSessionStateV3({ ...sessionState("s2"), leaseToken: "lease-token" });
	assert.equal(withLease.leaseToken, "lease-token");
});

test("序列化覆盖 SW restore 读取的每个字段，重命名不会静默丢所有权", async () => {
	// restoreState reads exactly these fields back; if the shape drifts, a service
	// worker restart would silently forget tabs instead of failing loudly.
	const stored = serializeSessionStateV3(sessionState("session-9", { docs: { tabId: 11, targetId: "target-9", documentGeneration: 4, url: "https://example.test/x", status: "loading", ownership: "claimed" } }));
	const restored = legacyV2Sessions({ schemaVersion: 2, sessions: [stored] })[0];
	assert.equal(restored.keepTabs, false, "keepTabs 必须随 session 记录持久化");
	assert.equal(restored.sessionId, "session-9");
	assert.equal(restored.agentId, "main");
	assert.equal(restored.rootSessionId, "session-9");
	assert.equal(restored.generation, "generation-1");
	assert.deepEqual(restored.tabs, [{
		name: "docs", tabId: 11, targetId: "target-9", documentGeneration: 4,
		url: "https://example.test/x", status: "loading", ownership: "claimed",
	}]);
	const worker = await readFile(resolve("rotom/extensions/browser/chrome-extension/service-worker.js"), "utf8");
	for (const field of ["stored.sessionId", "stored.currentTabName", "stored.tabs", "candidate.name", "candidate.tabId", "candidate.targetId", "candidate.documentGeneration", "candidate.url", "candidate.status", "candidate.ownership"]) {
		assert.equal(worker.includes(field), true, `restore 读取的 ${field} 必须在序列化里存在`);
	}
});

test("V2 与 V1 旧文档都能读出来，坏形状返回空", () => {
	const v2 = { schemaVersion: 2, sessions: [{ sessionId: "a", tabs: [] }, { nope: true }, null] };
	assert.deepEqual(legacyV2Sessions(v2).map((entry) => entry.sessionId ?? null), ["a", null]);
	assert.deepEqual(legacyV2Sessions({ schemaVersion: 1, sessions: [] }), []);
	assert.deepEqual(legacyV2Sessions(undefined), []);

	const v1 = { schemaVersion: 1, activeSession: { sessionId: "legacy" }, currentTabName: "docs", tabs: [{ name: "docs" }] };
	assert.deepEqual(legacyV1Sessions(v1), [{ sessionId: "legacy", currentTabName: "docs", tabs: [{ name: "docs" }] }]);
	assert.deepEqual(legacyV1Sessions({ schemaVersion: 1, tabs: [] }), [], "缺 activeSession 时不迁移");
});

test("合并写：一个窗口只写一次，且只写有变化的 session", async () => {
	const written = [];
	let version = 0;
	const writer = createMergedSessionWriter({
		entries: () => new Map([
			[sessionStateKeyV3("a"), { schemaVersion: 3, sessionId: "a", version }],
			[sessionStateKeyV3("b"), { schemaVersion: 3, sessionId: "b", version: 0 }],
		]),
		write: async (payload) => { written.push(payload); },
		remove: async () => undefined,
		mergeWindowMs: 10,
	});
	const first = writer.schedule();
	version = 1;
	const second = writer.schedule();
	await Promise.all([first, second]);
	assert.equal(written.length, 1, "同一窗口的多次 persist 合并成一次写入");
	assert.deepEqual(Object.keys(written[0]).sort(), [sessionStateKeyV3("a"), sessionStateKeyV3("b")]);

	version = 2;
	await writer.schedule();
	assert.equal(written.length, 2);
	assert.deepEqual(Object.keys(written[1]), [sessionStateKeyV3("a")], "未变化的 session 不重写");

	await pause(20);
	await writer.flushNow();
	assert.equal(written.length, 2, "没有变化时 flush 不产生写入");
});

test("写失败时脏标记保留，下一次 flush 重试且调用方看到错误", async () => {
	const attempts = [];
	let fail = true;
	const writer = createMergedSessionWriter({
		entries: () => new Map([[sessionStateKeyV3("a"), { schemaVersion: 3, sessionId: "a" }]]),
		write: async (payload) => { attempts.push(Object.keys(payload)); if (fail) throw new Error("storage unavailable"); },
		remove: async () => undefined,
		mergeWindowMs: 5,
	});
	await assert.rejects(writer.schedule(), /storage unavailable/u);
	fail = false;
	await writer.schedule();
	assert.deepEqual(attempts, [[sessionStateKeyV3("a")], [sessionStateKeyV3("a")]], "失败的 key 必须重试");
});

test("消失的 session 会被删除", async () => {
	const removed = [];
	let present = true;
	const writer = createMergedSessionWriter({
		entries: () => new Map(present ? [[sessionStateKeyV3("gone"), { schemaVersion: 3, sessionId: "gone" }]] : []),
		write: async () => undefined,
		remove: async (keys) => { removed.push(...keys); },
		mergeWindowMs: 5,
	});
	await writer.schedule();
	present = false;
	await writer.flushNow();
	assert.deepEqual(removed, [sessionStateKeyV3("gone")]);
});

test("service worker 侧接线：V3 单文件持久化 + V2/V1 迁移后删除", () => {
	assert.match(worker, /const sessionWriter = createMergedSessionWriter\(\{[\s\S]*?sessionStateKeyV3\(state\.sessionId\)[\s\S]*?serializeSessionStateV3\(state\)/u);
	assert.doesNotMatch(worker, /persistChain/u, "单一 persist 链必须被合并写取代");
	assert.doesNotMatch(worker, /browserRelayStateV2: \{/u, "不得再把所有 session 塞进一个 V2 文档");
	const restoreBlock = worker.match(/async function restoreState\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(restoreBlock, /isSessionStateKeyV3\(key\)/u, "启动时读取所有 V3 key");
	assert.match(restoreBlock, /legacyV2Sessions\(storedValues\[LEGACY_SESSION_STATE_KEY_V2\]\)/u);
	assert.match(restoreBlock, /legacyV1Sessions\(storedValues\[LEGACY_SESSION_STATE_KEY_V1\]\)/u);
	assert.match(restoreBlock, /filter\(\(stored\) => !knownSessionIds\.has\(stored\.sessionId\)\)/u, "已经存在的 V3 session 不能被旧文档覆盖");
	assert.match(restoreBlock, /await sessionWriter\.flushNow\(\)/u, "迁移必须立刻落盘，不能等合并窗口");
	assert.match(restoreBlock, /chrome\.storage\.session\.remove\(\[LEGACY_SESSION_STATE_KEY_V2, LEGACY_SESSION_STATE_KEY_V1\]\)/u, "迁移完成后删除旧 key");
});

test("没有变化时 schedule 立即 resolve，不空等合并窗口", async () => {
	const writes = [];
	const states = new Map([["session-1", sessionState("session-1", { docs: { tabId: 7, targetId: "target-1" } })]]);
	const writer = createMergedSessionWriter({
		entries: () => new Map([...states].map(([sessionId, state]) => [sessionStateKeyV3(sessionId), serializeSessionStateV3(state)])),
		write: async (payload) => { writes.push(payload); },
		remove: async () => undefined,
	});
	await writer.schedule();
	assert.equal(writes.length, 1, "第一次调度要真的写盘");
	const startedAt = Date.now();
	// A read-only operation ends with a persist that has nothing new to store: it must
	// not pay the 100 ms merge window it never uses.
	await writer.schedule();
	await writer.schedule();
	const elapsed = Date.now() - startedAt;
	assert.equal(writes.length, 1, "没有变化就不再写盘");
	assert.ok(elapsed < 20, `两次空调度应远快于合并窗口，实际 ${elapsed} ms`);
});

test("有变化时仍走合并窗口并写入一次", async () => {
	const writes = [];
	const states = new Map([["session-1", sessionState("session-1", { docs: { tabId: 7, targetId: "target-1" } })]]);
	const writer = createMergedSessionWriter({
		entries: () => new Map([...states].map(([sessionId, state]) => [sessionStateKeyV3(sessionId), serializeSessionStateV3(state)])),
		write: async (payload) => { writes.push(payload); },
		remove: async () => undefined,
		mergeWindowMs: 30,
	});
	await writer.schedule();
	states.get("session-1").tabsByName.get("docs").documentGeneration = 2;
	await writer.schedule();
	assert.equal(writes.length, 2, "内容变了要再写一次");
	assert.equal(writes[1][sessionStateKeyV3("session-1")].tabs[0].documentGeneration, 2);
});
