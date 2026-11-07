import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { raceDispatchAgainstDialog } from "./chrome-extension/dispatch-race.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("dispatch race: 没有弹窗时必须等派发自己结束，不能提前报 settled", async () => {
	let finished = false;
	let resolved = false;
	const race = (async () => {
		const result = await raceDispatchAgainstDialog({
			pollMs: 5,
			deadlineMs: 5_000,
			dialog: () => undefined,
			dispatch: async () => { await sleep(400); finished = true; },
		});
		resolved = true;
		return result;
	})();
	// The removed code answered "settled" after 120 × 25 ms whatever the dispatch was doing.
	await sleep(300);
	assert.equal(finished, false, "派发还在跑");
	assert.equal(resolved, false, "派发没结束就不能返回");
	assert.deepEqual(await race, { settled: true });
	assert.equal(finished, true, "返回时派发必须真的结束");
});

test("dispatch race: 弹窗打开时立刻返回 dialog，派发继续跑也不产生未处理的 rejection", async () => {
	let dialogOpened = false;
	let dispatchRejected = false;
	const result = await raceDispatchAgainstDialog({
		pollMs: 5,
		deadlineMs: 5_000,
		dialog: () => (dialogOpened ? { type: "confirm", message: "继续？" } : undefined),
		dispatch: async () => {
			await sleep(20);
			dialogOpened = true;
			await sleep(60);
			// The operation returned and retired its guard while the page stayed suspended.
			dispatchRejected = true;
			throw new Error("operation retired");
		},
	});
	assert.deepEqual(result, { dialog: { type: "confirm", message: "继续？" } });
	await sleep(150);
	assert.equal(dispatchRejected, true, "派发确实还在后台跑完");
	// An unhandled rejection would fail this test process; the race must have swallowed it.
});

test("dispatch race: 派发超过 deadline 报 timedOut 并停止轮询，调用方按 unknown 处理", async () => {
	let polls = 0;
	let dispatchRejected = false;
	const result = await raceDispatchAgainstDialog({
		pollMs: 5,
		deadlineMs: 60,
		dialog: () => { polls += 1; return undefined; },
		dispatch: async () => {
			await sleep(200);
			dispatchRejected = true;
			throw new Error("operation retired");
		},
	});
	assert.deepEqual(result, { timedOut: true });
	const pollsAtReturn = polls;
	await sleep(250);
	assert.equal(polls, pollsAtReturn, "返回后不再继续轮询");
	assert.equal(dispatchRejected, true, "后台派发结束，rejection 已被吞掉");
});

test("dispatch race: 派发失败时把原始错误抛给调用方", async () => {
	await assert.rejects(
		raceDispatchAgainstDialog({ pollMs: 5, deadlineMs: 5_000, dialog: () => undefined, dispatch: async () => { await sleep(10); throw new Error("debugger is not attached"); } }),
		/debugger is not attached/u,
	);
});

test("service worker 用 dispatch-race，旧的自带超时轮询不再存在", async () => {
	const worker = await readFile(join(import.meta.dirname, "chrome-extension/service-worker.js"), "utf8");
	assert.match(worker, /raceDispatchAgainstDialog\(\{/u);
	assert.match(worker, /if \(raced\.timedOut !== undefined\) throw new Error\("browser interaction dispatch timeout/u);
	// The removed code returned `{ settled: true }` after 120 × 25 ms without waiting.
	assert.doesNotMatch(worker, /attempt < 120/u);
	assert.doesNotMatch(worker, /return \{ settled: true \};\s*\n\s*\}\)\(\)/u);
});
