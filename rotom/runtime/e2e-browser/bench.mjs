#!/usr/bin/env node
// Browser relay performance baseline.
//
// This measures cost per call on an isolated harness and local fixtures; it changes no
// real profile or data. It is a benchmark, not a correctness test: the suites already
// assert behaviour, so nothing here repeats an assertion.
//
// Reported: relay round trips (open/connect), page observation (rendered snapshot and
// full read), one write plus its readback, a screenshot, concurrency scaling, and the
// screencast + GIF path. Chrome startup is reported separately from steady state.
//
//   node --experimental-strip-types rotom/runtime/e2e-browser/bench.mjs
//   ROTOM_BENCH_ROUNDS=40 ROTOM_BENCH_JSON=/tmp/bench.json node ... bench.mjs

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { composeGifV1 } from "../../extensions/browser/gif-encoder.ts";
import { summarizeTraceV1 } from "../../extensions/browser/trace-summary.ts";
import { createFixtureServer } from "./fixtures/server.mjs";
import { launchHarness } from "./harness.mjs";

const ROUNDS = Number(process.env.ROTOM_BENCH_ROUNDS ?? 20);
const WARMUP = Number(process.env.ROTOM_BENCH_WARMUP ?? 3);
const CONCURRENCY_ROUNDS = Number(process.env.ROTOM_BENCH_CONCURRENCY_ROUNDS ?? 8);
const JSON_OUT = process.env.ROTOM_BENCH_JSON;
const SKIP_RECORD = process.env.ROTOM_BENCH_SKIP_RECORD === "1";

/** Percentile on the sorted sample set; small n means nearest-rank, stated as such. */
function percentile(sorted, fraction) {
	if (sorted.length === 0) return undefined;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index];
}

function summarize(label, samples, note) {
	const sorted = [...samples].sort((left, right) => left - right);
	const total = samples.reduce((sum, value) => sum + value, 0);
	return {
		label,
		n: samples.length,
		note,
		p50Ms: round(percentile(sorted, 0.5)),
		p95Ms: round(percentile(sorted, 0.95)),
		minMs: round(sorted[0]),
		maxMs: round(sorted[sorted.length - 1]),
		meanMs: round(total / samples.length),
		opsPerSecond: round(1000 / (total / samples.length)),
	};
}

function round(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

async function measure(label, run, { rounds = ROUNDS, warmup = WARMUP, note } = {}) {
	for (let index = 0; index < warmup; index += 1) await run(index);
	const samples = [];
	for (let index = 0; index < rounds; index += 1) {
		const startedAt = process.hrtime.bigint();
		await run(index);
		samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
	}
	return summarize(label, samples, note);
}

/** Chrome's own RSS, so a leak in the browser is visible next to the client numbers. */
function chromeRssMb(pid) {
	const listed = spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
	const value = Number(String(listed.stdout ?? "").trim());
	return Number.isFinite(value) ? Math.round(value / 1024) : undefined;
}

async function waitForRelay(harness) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { return await harness.connect("bench-main"); }
		catch { await new Promise((done) => setTimeout(done, 100)); }
	}
	throw new Error("relay 在 10 秒内没有就绪");
}

const fixtures = await createFixtureServer();
const results = { environment: {}, scenarios: [], notes: [] };
let harness;
try {
	const bootStartedAt = process.hrtime.bigint();
	harness = await launchHarness({ startUrl: fixtures.url("/baseline") });
	const client = await waitForRelay(harness);
	const bootMs = Number(process.hrtime.bigint() - bootStartedAt) / 1e6;
	const request = (operation, payload, timeoutMs = 60_000) => client.request(operation, payload, { timeoutMs });

	results.environment = {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		cpu: spawnSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout?.trim() || undefined,
		cores: spawnSync("/usr/sbin/sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).stdout?.trim() || undefined,
		headless: harness.headless,
		chromeStartAndConnectMs: round(bootMs),
	};
	results.scenarios.push({ label: "chrome 启动 + relay 握手", n: 1, valueMs: round(bootMs) });

	// Connection cost is its own number: every new agent pays it once.
	results.scenarios.push(await measure("client 连接（握手 + 会话注册）", async (index) => {
		const extra = await harness.connect(`bench-connect-${index}`);
		extra.close();
	}, { rounds: 10, warmup: 2 }));

	// Steady state on one tab: open once, then measure the read paths.
	await request("close", { all: true });
	const openStartedAt = process.hrtime.bigint();
	await request("open", { tabName: "bench", url: fixtures.url("/baseline") });
	await request("wait", { tabName: "bench", status: "complete", timeoutMs: 30_000 });
	const firstOpenMs = Number(process.hrtime.bigint() - openStartedAt) / 1e6;

	results.scenarios.push(await measure("snapshot_visible（渲染 DOM 观察）", () => request("snapshot", { tabName: "bench", limit: 200 })));
	results.scenarios.push(await measure("tabs（归属与状态查询）", () => request("tabs", {})));

	await request("open", { tabName: "large", url: fixtures.url("/large") });
	await request("wait", { tabName: "large", status: "complete", timeoutMs: 30_000 });
	results.scenarios.push(await measure("read_full（整页文本，/large）", () => request("read_full", { tabName: "large" }), { rounds: 10, warmup: 2 }));

	results.scenarios.push(await measure("screenshot（JPEG，视口）", () => request("screenshot", { tabName: "bench" })));

	await request("open", { tabName: "form", url: fixtures.url("/form") });
	await request("wait", { tabName: "form", status: "complete", timeoutMs: 30_000 });
	const form = await request("snapshot", { tabName: "form", limit: 400 });
	const formRef = form.nodes.find((node) => /textbox|input/iu.test(String(node.role ?? "")))?.ref;
	if (formRef === undefined) {
		results.notes.push("form 页没有找到文本输入，写入路径未测量");
	} else {
		// Text length changes each round because the target-state probe reports
		// `valueLength`, never the value: an equal-length replacement is genuinely
		// unobservable, so it would measure the settle deadline rather than the action.
		results.scenarios.push(await measure("interact type + 读回（写路径）", (index) => request("interact", {
			actionId: `bench-type-${Math.random().toString(16).slice(2)}`,
			tabName: "form",
			action: "type",
			targetRef: formRef,
			text: "b".padEnd(index + 2, "e"),
			replace: true,
		}), { note: "每轮文本长度不同；等长替换观察不到变化，会走满 settle 上限" }));
	}

	// Concurrency: 1, 2 and 4 tabs in flight at once, same operation on each.
	for (const width of [1, 2, 4]) {
		const names = [];
		for (let index = 0; index < width; index += 1) {
			const name = `conc-${width}-${index}`;
			await request("open", { tabName: name, url: fixtures.url("/baseline") });
			await request("wait", { tabName: name, status: "complete", timeoutMs: 30_000 });
			names.push(name);
		}
		const samples = [];
		for (let roundIndex = 0; roundIndex < CONCURRENCY_ROUNDS; roundIndex += 1) {
			const startedAt = process.hrtime.bigint();
			await Promise.all(names.map((name) => request("snapshot", { tabName: name, limit: 200 })));
			samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
		}
		const perTab = samples.map((value) => value / width);
		const summary = summarize(`并发 snapshot ×${width}（每次总耗时）`, samples);
		results.scenarios.push({ ...summary, perTabMs: round(summarize("per-tab", perTab).meanMs) });
	}

	// Full-page export: the most expensive screenshot shape, so it is measured apart from
	// the viewport capture above. Runs on the long page.
	try {
		results.scenarios.push(await measure("devtools screenshot_export（整页 PNG，/baseline）", () => request("devtools", {
			tabName: "bench", devtools: "screenshot_export", format: "png", fullPage: true,
		}), { rounds: 5, warmup: 1, note: "返回 base64，本地不写盘" }));
	} catch (error) {
		results.notes.push(`整页 PNG 导出未测量：${error instanceof Error ? error.message : String(error)}`);
	}
	// The long page is the interesting case for the size ceiling: record what happens
	// instead of assuming the export always fits.
	await request("open", { tabName: "export", url: fixtures.url("/large") });
	await request("wait", { tabName: "export", status: "complete", timeoutMs: 30_000 });
	try {
		results.scenarios.push(await measure("devtools screenshot_export（整页 JPEG q50，/large）", () => request("devtools", {
			tabName: "export", devtools: "screenshot_export", format: "jpeg", fullPage: true, quality: 50,
		}), { rounds: 3, warmup: 1 }));
	} catch (error) {
		results.notes.push(`/large 整页导出被拒（这正是上限在工作）：${error instanceof Error ? error.message : String(error)}`);
	}
	// Scroll is the one interaction that only reads, and the only one that measured a
	// fixed settle window of its own.
	results.scenarios.push(await measure("interact scroll（只读交互）", (index) => request("interact", {
		actionId: `bench-scroll-${Math.random().toString(16).slice(2)}`,
		tabName: "export",
		action: "scroll",
		direction: index % 2 === 0 ? "down" : "up",
		amount: 400,
	}), { rounds: 20, note: "方向交替，保证每轮 scrollTop 真的移动" }));

	// network_body: the relay first re-enables Network with small buffers, so a request has
	// to be issued after that; the preparation is outside the timed window.
	await request("open", { tabName: "body", url: fixtures.url("/network") });
	await request("wait", { tabName: "body", status: "complete", timeoutMs: 30_000 });
	await request("devtools", { tabName: "body", devtools: "network_body", requestId: "bootstrap" }).catch(() => undefined);
	const nextJsonRequestId = async () => {
		await request("devtools", { tabName: "body", devtools: "evaluate", expression: "fetch('/status-500').then((reply) => reply.text())", awaitPromise: true });
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const listed = await request("network", { tabName: "body", limit: 200 });
			const entry = [...(listed.entries ?? [])].reverse().find((candidate) => String(candidate.mimeType ?? "").includes("json"));
			if (entry?.requestId !== undefined) return entry.requestId;
			await new Promise((done) => setTimeout(done, 100));
		}
		throw new Error("没有可读的 JSON 请求");
	};
	if ((await nextJsonRequestId().catch(() => undefined)) === undefined) {
		results.notes.push("network_body 未测量：fixture 没有产生可读的 JSON 请求");
	} else {
		results.scenarios.push(await measure("devtools network_body（取响应体）", async () => {
			const requestId = await nextJsonRequestId();
			return request("devtools", { tabName: "body", devtools: "network_body", requestId });
		}, { rounds: 5, warmup: 1, note: "含每轮准备一次请求" }));
	}

	// Trace: relay采集 + base64 传输 + Pi 侧解析，三段分开计时才有意义.
	await request("open", { tabName: "trace", url: fixtures.url("/large") });
	await request("wait", { tabName: "trace", status: "complete", timeoutMs: 30_000 });
	try {
		const traceSamples = [];
		for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
			await request("devtools", { tabName: "trace", devtools: "trace_start" });
			await request("interact", { actionId: `bench-trace-${roundIndex}-${Math.random().toString(16).slice(2)}`, tabName: "trace", action: "scroll", direction: "down", amount: 600 });
			await new Promise((done) => setTimeout(done, 500));
			const startedAt = process.hrtime.bigint();
			const stopped = await request("devtools", { tabName: "trace", devtools: "trace_stop" });
			const relayMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
			const decodeStartedAt = process.hrtime.bigint();
			const traceText = Buffer.from(String(stopped.traceBase64 ?? ""), "base64").toString("utf8");
			const decodeMs = Number(process.hrtime.bigint() - decodeStartedAt) / 1e6;
			const summaryStartedAt = process.hrtime.bigint();
			const summary = summarizeTraceV1(traceText);
			const summarizeMs = Number(process.hrtime.bigint() - summaryStartedAt) / 1e6;
			traceSamples.push({ relayMs, decodeMs, summarizeMs, bytes: stopped.bytes ?? 0, longTasks: summary.longTasks?.count ?? 0 });
		}
		const mean = (key) => round(traceSamples.reduce((sum, sample) => sum + sample[key], 0) / traceSamples.length);
		results.scenarios.push({
			label: "devtools trace_start/stop + 本地解析（0.5s 采集）",
			n: traceSamples.length,
			p50Ms: mean("relayMs"),
			note: `relay ${mean("relayMs")} ms + base64 解码 ${mean("decodeMs")} ms + 摘要 ${mean("summarizeMs")} ms；事件流均值 ${Math.round(mean("bytes"))} 字节、long task 均值 ${Math.round(mean("longTasks"))} 条`,
		});
	} catch (error) {
		results.notes.push(`trace 未测量：${error instanceof Error ? error.message : String(error)}`);
	}

	// Screencast + GIF: the only heavy local CPU path in the product.
	if (SKIP_RECORD) {
		results.notes.push("record 路径按环境变量跳过");
	} else {
		try {
			const record = await measure("record_start/stop（3 秒 @2fps）+ GIF 合成", async () => {
				await request("devtools", { tabName: "bench", devtools: "record_start" });
				// Scrolling inside the recording window is the only way to make the page repaint.
				await request("interact", { actionId: `bench-record-${Math.random().toString(16).slice(2)}`, tabName: "bench", action: "scroll", direction: "down", amount: 400 });
				await new Promise((done) => setTimeout(done, 3_000));
				const captured = await request("devtools", { tabName: "bench", devtools: "record_stop" });
				const frames = (captured.frames ?? []).map((frame) => Buffer.from(String(frame.data), "base64"));
				const startedAt = process.hrtime.bigint();
				const composed = composeGifV1(frames, { delayMs: 500, maxWidth: 480 });
				const composeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
				return { composeMs, frames: frames.length, gifBytes: composed.gif.length };
			}, { rounds: 2, warmup: 1, note: "包含固定 3 秒录制等待，比较时应减去 3000ms" });
			results.scenarios.push(record);
		} catch (error) {
			results.notes.push(`record 路径未测量：${error instanceof Error ? error.message : String(error)}（headless 无重绘时 Chrome 不发帧）`);
		}
	}

	// GIF composition cost on its own, using the frames from a synthetic render.
	results.notes.push(`client RSS ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB，chrome RSS ${chromeRssMb(harness.chrome.pid) ?? "?"} MB`);
	results.notes.push("P95 用 nearest-rank，样本量小（n≤20）时只是量级参考");
	results.notes.push(`首次 open 均值 ${round(firstOpenMs)} ms`);

	const table = results.scenarios.map((scenario) => [
		scenario.label,
		scenario.n ?? "",
		scenario.valueMs ?? scenario.p50Ms ?? "",
		scenario.p95Ms ?? "",
		scenario.maxMs ?? "",
		scenario.opsPerSecond ?? "",
	]);
	const header = ["场景", "n", "P50/单次(ms)", "P95(ms)", "max(ms)", "ops/s"];
	const widths = header.map((cell, index) => Math.max(cell.length, ...table.map((row) => String(row[index] ?? "").length)));
	const line = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
	process.stdout.write(`${line(header)}\n${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
	for (const row of table) process.stdout.write(`${line(row)}\n`);
	process.stdout.write(`\n环境：${JSON.stringify(results.environment)}\n`);
	for (const note of results.notes) process.stdout.write(`- ${note}\n`);
	if (JSON_OUT !== undefined) await writeFile(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
} finally {
	await harness?.close().catch(() => undefined);
	await fixtures.close().catch(() => undefined);
}
