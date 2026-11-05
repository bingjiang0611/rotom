import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TRACE_EVENTS_V1, TRACE_LONG_TASK_MS_V1, summarizeTraceV1 } from "./trace-summary.ts";

const trace = (events) => JSON.stringify({ traceEvents: events });

test("long task 按 50 ms 门槛统计并只留最慢 10 个", () => {
	const events = [{ name: "RunTask", dur: 40_000, args: { data: { url: "https://example.test/fast.js" } } }];
	for (let index = 0; index < 12; index += 1) events.push({ name: "RunTask", dur: (index + 6) * 10_000, args: { data: { url: `https://example.test/${index}.js` } } });
	const summary = summarizeTraceV1(trace(events));
	assert.equal(TRACE_LONG_TASK_MS_V1, 50);
	assert.equal(summary.longTasks, 12, "40 ms 的任务不算 long task");
	assert.equal(summary.slowestLongTasks.length, 10);
	assert.equal(summary.slowestLongTasks[0].durationMs, 170, "最慢的 170 ms 必须排第一");
	assert.equal(summary.slowestLongTasks[0].url, "https://example.test/11.js");
	assert.equal(summary.events, 13);
});

test("CLS 只累加非用户输入引起的位移", () => {
	const summary = summarizeTraceV1(trace([
		{ name: "LayoutShift", args: { data: { score: 0.12 } } },
		{ name: "LayoutShift", args: { data: { score: 0.05, hadRecentInput: true } } },
		{ name: "LayoutShift", args: { data: { score: 0.0312 } } },
	]));
	assert.equal(summary.cls, 0.1512);
	assert.equal(summary.longTasks, 0);
});

test("最慢脚本带 url 与从 1 开始的行号", () => {
	const summary = summarizeTraceV1(trace([
		{ name: "EvaluateScript", dur: 12_000, args: { data: { url: "https://example.test/a.js", lineNumber: 41 } } },
		{ name: "FunctionCall", dur: 30_000, args: { data: { url: "https://example.test/b.js", lineNumber: 0 } } },
	]));
	assert.equal(summary.slowestScripts.length, 2);
	assert.equal(summary.slowestScripts[0].durationMs, 30);
	assert.equal(summary.slowestScripts[0].url, "https://example.test/b.js");
	assert.equal(summary.slowestScripts[0].line, 1, "trace 的行号是 0 基，回报时 +1");
	assert.equal(summary.slowestScripts[1].line, 42);
});

test("扫描上限与坏输入", () => {
	const events = Array.from({ length: 10 }, () => ({ name: "RunTask", dur: 60_000 }));
	const summary = summarizeTraceV1(trace(events), { maxEvents: 4 });
	assert.equal(summary.truncated, true);
	assert.equal(summary.longTasks, 4);
	assert.equal(MAX_TRACE_EVENTS_V1, 500_000);
	const full = summarizeTraceV1(trace(events));
	assert.equal(full.truncated, false);
	assert.equal(full.longTasks, 10);

	assert.throws(() => summarizeTraceV1("not json"), /trace 文件不是有效 JSON/u);
	assert.throws(() => summarizeTraceV1(JSON.stringify({ other: [] })), /traceEvents/u);
	assert.equal(summarizeTraceV1(trace([])).cls, 0);
});
