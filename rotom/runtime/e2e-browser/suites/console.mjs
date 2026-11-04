// console (T13): read what the page logged, without reading the page itself.
//
// The fixture logs an error, throws an exception with a real stack, and can flood the
// buffer so the bounded ring drops the oldest entries and says how many.

import assert from "node:assert/strict";
import { relayRequestFor } from "../harness.mjs";

/** Chrome starts on this page so a real user tab exists to claim. */
export const startUrlPage = "/user";

export const description = "console：异常堆栈可读、pattern 过滤、缓冲满后 dropped 大于 0";

export async function run({ harness, fixtures, recorder }) {
	const client = await harness.connect("console-main");
	const request = relayRequestFor(client, "console");
	const readConsole = async (payload = {}) => request("console", { tabName: "log", ...payload }, 10_000);

	await recorder.check("open 后 console 已捕获错误与未捕获异常", async () => {
		await request("close", { all: true }, 5_000);
		await request("open", { tabName: "log", url: fixtures.url("/console") }, 10_000);
		await request("wait", { tabName: "log", status: "complete", timeoutMs: 10_000 }, 11_000);
		// The fixture throws the uncaught exception 120 ms after load.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const page = await readConsole({ limit: 50 });
		assert.equal(page.kind, "rotom-browser-console");
		assert.ok(Date.parse(page.captureSince) > 0, "captureSince 必须是真实时间");
		assert.ok(page.entries.length >= 2, `至少两条：${JSON.stringify(page.entries)}`);
		const error = page.entries.find((entry) => entry.level === "error" && entry.text.includes("cannot read properties"));
		assert.ok(error, "console.error 必须被捕获");
		const uncaught = page.entries.find((entry) => entry.text.includes("fixture uncaught exception"));
		assert.ok(uncaught, "未捕获异常必须被捕获");
		assert.equal(uncaught.level, "error");
		assert.ok(Array.isArray(uncaught.stack) && uncaught.stack.length > 0, `未捕获异常要带堆栈：${JSON.stringify(uncaught)}`);
		assert.ok(uncaught.stack.length <= 10, "堆栈最多 10 帧");
		assert.match(uncaught.stack.join("\n"), /fixture uncaught exception|anonymous|at /u);
		assert.equal(uncaught.url.includes("?"), false, "来源 URL 必须脱敏");
	});

	await recorder.check("level 与 pattern 过滤（大小写不敏感的子串）", async () => {
		const errors = await readConsole({ level: "error", limit: 50 });
		assert.ok(errors.entries.length >= 1);
		assert.equal(errors.entries.every((entry) => entry.level === "error"), true);
		const matched = await readConsole({ pattern: "FIXTURE BOOM", limit: 50 });
		assert.equal(matched.entries.every((entry) => entry.text.toLowerCase().includes("fixture boom")), true);
		const none = await readConsole({ pattern: "no-such-log-line", limit: 50 });
		assert.deepEqual(none.entries, []);
		// A pattern is a substring; `.*` must not behave like a regular expression.
		assert.deepEqual((await readConsole({ pattern: ".*", limit: 50 })).entries, []);
	});

	await recorder.check("非法过滤参数被拒绝", async () => {
		await assert.rejects(readConsole({ level: "debug" }), /level/u);
		await assert.rejects(readConsole({ limit: 201 }), /limit/u);
		await assert.rejects(readConsole({ sinceCursor: "42" }), /sinceCursor/u);
	});

	await recorder.check("缓冲满后 dropped 大于 0，cursor 从最旧的保留项继续", async () => {
		const before = await readConsole({ limit: 200 });
		const staleCursor = before.entries.at(-1)?.seq === undefined ? undefined : `c${before.entries.at(-1).seq - 1}`;
		// Flood more entries than the 500-entry ring can hold.
		await request("interact", { actionId: `console-flood-${Date.now()}`, tabName: "log", action: "click", targetRef: (await request("snapshot", { tabName: "log" }, 10_000)).nodes.find((node) => node.role === "button" && node.name.includes("Flood")).ref }, 15_000);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const after = await readConsole({ limit: 200 });
		assert.ok(after.dropped > 0, `dropped 必须大于 0：${after.dropped}`);
		assert.equal(after.entries.length, 200);
		assert.ok(after.nextCursor, "还有剩余条目时必须给 nextCursor");
		const next = await readConsole({ sinceCursor: after.nextCursor, limit: 200 });
		assert.ok(next.entries.length > 0);
		assert.ok(next.entries[0].seq > after.entries.at(-1).seq, "cursor 之后继续，不重放");
		if (staleCursor !== undefined) {
			// An already-dropped cursor still continues from the oldest retained entry.
			const fromOld = await readConsole({ sinceCursor: staleCursor, limit: 5 });
			assert.equal(fromOld.entries.length, 5);
		}
	});

	await recorder.check("claimed 的用户 tab 只在第一次 console 调用时开始捕获", async () => {
		await request("discover", {}, 5_000);
		const userTab = (await request("discover", {}, 5_000)).tabs.find((tab) => new URL(tab.url).pathname === "/user");
		assert.ok(userTab, "用户 tab 应当可发现");
		const claimed = await request("claim", { tabName: "user-console", tabId: userTab.tabId }, 10_000);
		assert.equal(claimed.tabName, "user-console");
		const first = await request("console", { tabName: "user-console", limit: 10 }, 10_000);
		assert.equal(first.kind, "rotom-browser-console");
		assert.ok(Date.parse(first.captureSince) > 0, "第一次调用就给出真实的 captureSince");
		await request("close", { all: true }, 5_000);
	});
}
