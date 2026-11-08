import test from "node:test";
import assert from "node:assert/strict";
import { relayOperationDeadlineMs, relayClientTimeoutMs, RELAY_SETTLE_MS, runWithRelayDeadline, valueWithinRelayDeadline } from "./chrome-extension/relay-deadline.js";
import { readFile } from "node:fs/promises";
import { createOperationGuard } from "./chrome-extension/operation-guard.js";
import { resolve } from "node:path";
test("扩展 operation deadline 先于客户端超时并覆盖长 wait", () => {
	assert.equal(relayOperationDeadlineMs("hello", {}), 2000);
	assert.equal(relayOperationDeadlineMs("tabs", {}), 4000);
	assert.equal(relayOperationDeadlineMs("snapshot", {}), 20000);
	assert.equal(relayOperationDeadlineMs("interact", {}), 6000);
	assert.equal(relayOperationDeadlineMs("recover", {}), 8000);
	assert.equal(relayOperationDeadlineMs("read_full", {}), 25000);
	assert.equal(relayOperationDeadlineMs("wait", { timeoutMs: 12000 }), 12500);
	// navigate waits for `complete`, so it carries the same bound as wait.
	assert.equal(relayOperationDeadlineMs("navigate", { timeoutMs: 12000 }), 12500);
	assert.equal(relayOperationDeadlineMs("navigate", {}), 30500);
});
test("客户端超时晚于扩展 deadline 加超时清理，扩展的有界错误先到达", async () => {
	// Before: tabs waited 5 s on the client while the extension could take 4 s + 2 s cleanup,
	// so the client dropped the connection instead of receiving "tabs operation timeout".
	for (const [operation, payload] of [["tabs", {}], ["recover", {}], ["interact", {}], ["read_full", {}], ["snapshot", {}], ["navigate", { timeoutMs: 12000 }], ["wait", { timeoutMs: 12000 }], ["wait", { timeoutMs: 300000 }]]) {
		assert.ok(relayClientTimeoutMs(operation, payload) > relayOperationDeadlineMs(operation, payload) + 2 * RELAY_SETTLE_MS, operation);
	}
	// Requests that pass no timeout use the client default of 30 s.
	assert.ok(relayClientTimeoutMs("snapshot", {}) <= 30000);
	const source = (await Promise.all(["browser-runtime.ts", "inspect-execute.ts", "interact-execute.ts"].map(path => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
	for (const operation of ["tabs", "recover", "wait", "read_full", "interact"]) {
		assert.match(source, new RegExp(`request\\("${operation}", [^\\n]*timeoutMs: relayClientTimeoutMs\\("${operation}"`), operation);
	}
});
test("扩展 operation deadline 会等待清理完成后释放串行队列", async () => {
	let cleanupFinished = false;
	const never = new Promise(() => undefined);
	await assert.rejects(runWithRelayDeadline("snapshot", never, async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		cleanupFinished = true;
	}, 10), /browser relay snapshot operation timeout/u);
	assert.equal(cleanupFinished, true);
});
test("operation guard 在 timeout 后阻止迟到操作，且按锁作用域隔离", () => {
	const state = { operationRevisions: new Map([["session", 4]]), epoch: 2, generation: "generation" };
	const guard = createOperationGuard(state, 2);
	guard.assert();
	guard.invalidate();
	assert.equal(state.operationRevisions.get("session"), 5);
	assert.throws(() => guard.assert(), /operation invalidated/u);
	guard.invalidate();
	assert.equal(state.operationRevisions.get("session"), 5, "重复 invalidation 不能误伤下一 operation");
	// Two tabs may run concurrently: finishing one must not retire the other.
	const tabA = createOperationGuard(state, 2, "tab:a");
	const tabB = createOperationGuard(state, 2, "tab:b");
	tabA.invalidate();
	assert.throws(() => tabA.assert(), /operation invalidated/u);
	assert.doesNotThrow(() => tabB.assert(), "另一个 tab 的操作必须仍然有效");
	assert.equal(state.operationRevisions.get("session"), 5, "tab 作用域不污染 session 作用域");
	// Session-wide invalidation (hello/close) still retires every scope.
	const guardAfterClose = createOperationGuard(state, 3, "tab:b");
	assert.throws(() => guardAfterClose.assert(), /operation invalidated/u, "epoch 变化仍然终止所有在飞操作");
});
test("child CDP pending 被短路且不会阻塞根页面结果", async () => {
	const never = new Promise(() => undefined);
	assert.deepEqual(await valueWithinRelayDeadline(Promise.resolve("root"), 10), { ok: true, value: "root" });
	assert.deepEqual(await valueWithinRelayDeadline(Promise.reject(new Error("detached")), 10), { ok: false });
	assert.deepEqual(await valueWithinRelayDeadline(never, 10), { ok: false });
});
