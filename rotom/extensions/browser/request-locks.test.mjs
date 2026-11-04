import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import { createSessionLockV1, createTabLocksV1, isSessionScopedOperationV1, SESSION_SCOPED_OPERATIONS_V1, tabLockKeyV1 } from "./chrome-extension/request-locks.js";

const worker = await readFile(resolve("rotom/extensions/browser/chrome-extension/service-worker.js"), "utf8");
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

test("session 锁让不同 tab 的只读操作重叠，结构性操作独占", async () => {
	const lock = createSessionLockV1();
	const order = [];
	const slowRead = (name, ms) => lock.read(async () => {
		order.push(`start:${name}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
		order.push(`end:${name}`);
	});
	await Promise.all([slowRead("tab-a", 30), slowRead("tab-b", 30)]);
	assert.deepEqual(order.slice(0, 2), ["start:tab-a", "start:tab-b"], "两个 tab 的读操作必须重叠执行");
	assert.equal(lock.counts().readers, 0);

	order.length = 0;
	const reads = Promise.all([slowRead("tab-a", 20), slowRead("tab-b", 20)]);
	const write = lock.write(async () => { order.push("write"); });
	await Promise.all([reads, write]);
	assert.equal(order.at(-1), "write", "结构性操作必须等所有读操作结束");
	assert.equal(lock.counts().writing, false);
});

test("排队的写操作会挡住后来的读操作，避免读不排队饿死写", async () => {
	const lock = createSessionLockV1();
	const order = [];
	const first = lock.read(async () => {
		order.push("read:1");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	});
	await tick();
	const write = lock.write(async () => { order.push("write"); });
	const second = lock.read(async () => { order.push("read:2"); });
	await Promise.all([first, write, second]);
	assert.deepEqual(order, ["read:1", "write", "read:2"], "FIFO：写锁拿到之后后来的读才被放行");
});

test("tab 锁只串行同名 tab，不同 tab 并发", async () => {
	const tabs = createTabLocksV1();
	const order = [];
	const run = (key, label, ms) => tabs.run(key, async () => {
		order.push(`start:${label}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
		order.push(`end:${label}`);
	});
	await Promise.all([run("docs", "docs-1", 10), run("docs", "docs-2", 10), run("other", "other-1", 10)]);
	assert.equal(order.indexOf("end:docs-1") < order.indexOf("start:docs-2"), true, "同一个 tab 的两个请求必须串行");
	assert.equal(order.indexOf("start:other-1") < order.indexOf("end:docs-1"), true, "不同 tab 必须并发");
	await tick();
	assert.equal(tabs.size(), 0, "空闲后不保留锁条目");
});

test("tab 锁在失败后仍放行后续请求", async () => {
	const tabs = createTabLocksV1();
	const failed = tabs.run("docs", async () => { throw new Error("boom"); });
	await assert.rejects(failed, /boom/u);
	await tabs.run("docs", async () => undefined);
	await tick();
	assert.equal(tabs.size(), 0);
});

test("结构性操作清单与 tasks.md 一致，其余操作按 tab 加锁", () => {
	assert.deepEqual([...SESSION_SCOPED_OPERATIONS_V1], ["hello", "open", "claim", "close", "tabs", "switch", "transfer", "handoff", "recover"]);
	for (const operation of ["snapshot", "snapshot_visible", "read_full", "screenshot", "wait", "interact"]) assert.equal(isSessionScopedOperationV1(operation), false, `${operation} 必须按 tab 加锁`);
	assert.equal(tabLockKeyV1({ tabName: "docs" }, "other"), "docs");
	assert.equal(tabLockKeyV1({}, "current"), "current", "未指定 tabName 时跟随 currentTabName");
	assert.equal(tabLockKeyV1({}, undefined), "");
	assert.equal(tabLockKeyV1({ tabName: 7 }, "current"), "current", "非字符串 tabName 不能当锁键");

	const requestBlock = worker.match(/function runRelayRequest\(state, message\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
	assert.match(requestBlock, /isSessionScopedOperationV1\(message\.operation\)/u);
	assert.match(requestBlock, /state\.lock\.write\(\(\) => handleRequest\(message, state, "session"\)\)/u, "结构性操作在 session 写锁里运行");
	assert.match(requestBlock, /state\.lock\.read\(\(\) => \{[\s\S]*?state\.tabLocks\.run\(scopeKey/u, "只读操作在 session 读锁里取 tab 锁");
	assert.doesNotMatch(worker, /operationChain/u, "旧的单链必须被两层锁取代");
	// A tab operation keeps its session read lock for the whole operation, so the
	// tab cannot be closed underneath it; `recover`/`interact` stay single-tab.
	assert.match(worker, /async function resetAfterOperationTimeout\(state, operation, targetItem\)[\s\S]*?await detachItemsPreservingState\(\[targetItem\]\)[\s\S]*?return;[\s\S]*?await detachAllOwnedPreservingState\(state\)/u, "超时重置只影响对应 tab");
});
