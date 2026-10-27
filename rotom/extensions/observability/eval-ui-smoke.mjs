// Explicit synthetic Playwright workflow. Never attach the user's browser profile.
// PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node .../eval-ui-smoke.mjs
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { startTraceDashboard } from "./dashboard.mjs";
import { fixtureSession, ATTACK } from "./eval-fixtures.mjs";
import { spawn } from "node:child_process";
import { fakeJudgeLauncher } from "./judge-fixtures.mjs";
import { COPY } from "./eval/copy.mjs";
if (!isAbsolute(process.env.PLAYWRIGHT_MODULE ?? "")) throw new Error("Set PLAYWRIGHT_MODULE to the installed Playwright entry");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const directory = await realpath(await mkdtemp(join(tmpdir(), "rotom-eval-ui-")));
const root = join(directory, "sessions"), evalDirectory = join(directory, "private");
await fixtureSession(root, "synthetic-idle", { large: true });
const activePath = await fixtureSession(root, "synthetic-active", { active: true, large: true });
for (let index = 0; index < 12; index++) await fixtureSession(root, "synthetic-page-" + index);
await fixtureSession(root, "synthetic-a-review", { active: true });
await mkdir(evalDirectory, { mode: 0o700 });
await writeFile(join(evalDirectory, "labels.jsonl"), JSON.stringify({ sessionId: "synthetic-a-review", verdict: "pass", note: "合成终端标注" }) + "\n", { mode: 0o600 });
const fake = await fakeJudgeLauncher(directory);
// Fake replay runner: no product runtime, no model. The first invocation reports
// progress slowly so the panel can be cancelled, the second finishes at once.
const replayRunner = join(directory, "fake-replay-runner.mjs");
const replayMarker = join(directory, "fake-replay-calls.jsonl");
await writeFile(replayRunner, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(replayMarker)}, JSON.stringify({ args: process.argv.slice(2) }) + "\\n");
const slow = process.argv.some((item) => item === "--repeats=3");
process.stdout.write(JSON.stringify({ progress: { done: 1, total: 3 } }) + "\\n");
if (slow) { setTimeout(() => process.exit(0), 60000); } else { process.stdout.write(JSON.stringify({ runs: [] }) + "\\n"); }
`, { mode: 0o700 });
const dashboard = await startTraceDashboard({ root, evalDirectory, judge: { launcher: fake.launcher }, replay: { spawnProcess: (node, args) => spawn(node, [replayRunner, ...args]) } });
let browser, page;
const errors = [], external = [], screenshots = [];
const screenshot = async (name) => { const path = join(directory, name); await page.screenshot({ path, fullPage: false }); screenshots.push(path); };
const stored = async () => JSON.parse(await readFile(join(evalDirectory, "annotations/synthetic-active.json"), "utf8"));
const launcherCalls = async () => (await readFile(fake.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const inferenceCount = async () => (await launcherCalls()).filter((row) => !row.args.includes("--list-models")).length;
await writeFile(fake.control, JSON.stringify({ modelsStderr: true }));
try {
	browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
	page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => { if (!request.url().startsWith(dashboard.baseUrl)) external.push(request.url()); });
	await page.goto(dashboard.url);
	assert.equal(await page.locator("#eval-workspace").isVisible(), false);
	await page.getByRole("button", { name: "会话统计", exact: true }).waitFor();
	await page.getByRole("button", { name: "执行链路", exact: true }).waitFor();
	assert.ok(!/SESSION STATS|EXECUTION TRACE|LOCAL ONLINE|SCAN LIMITED/.test(await page.locator("body").innerText()));
	const scriptCount = await page.locator("script").count();
	await page.getByRole("button", { name: "评测", exact: true }).click();
	await page.getByText("已标注 1 / 15", { exact: true }).waitFor();
	assert.equal(await page.locator("#eval-filter").inputValue(), "unlabeled");
	assert.equal(await page.locator('#eval-filter option[value="unlabeled"]').textContent(), "未标注（14）");
	await page.locator("#eval-filter").selectOption("all");
	await page.locator('[data-session-id="synthetic-a-review"]').click();
	await page.getByText("当前：满意（来自终端 review）", { exact: true }).waitFor();
	assert.equal(await page.locator("#eval-pass").getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator("#eval-pass").isDisabled(), false);
	await page.getByRole("button", { name: "重试读取模型", exact: true }).waitFor();
	assert.equal((await launcherCalls()).length, 1); assert.equal(await inferenceCount(), 0);
	assert.equal(await page.locator("#eval-analyze").isDisabled(), true);
	await page.getByText(COPY.errors.models_stdout_empty, { exact: true }).waitFor();
	assert.equal(await page.locator(".eval-model-diagnostic pre").textContent(), COPY.modelCheckCommand);
	assert.ok(!(await page.locator("body").innerText()).includes('"models":['));
	await screenshot("eval-model-stdout-diagnostic.png");
	await page.getByRole("button", { name: "重试读取模型", exact: true }).click();
	await page.getByRole("button", { name: "重试读取模型", exact: true }).waitFor();
	assert.equal((await launcherCalls()).length, 2); assert.equal(await inferenceCount(), 0);
	await writeFile(fake.control, JSON.stringify({ mode: "ok" }));
	await page.getByRole("button", { name: "重试读取模型", exact: true }).click();
	await page.waitForFunction(() => !document.getElementById('eval-analyze').disabled);
	assert.equal((await launcherCalls()).length, 3); assert.equal(await inferenceCount(), 0);
	// The current labeled detail must not be pinned into an unmatched filter,
	// including the interval while the next list response is still pending.
	let filterRoute, signalFilter;
	const filterHeld = new Promise((resolve) => { signalFilter = resolve; });
	const filterUrl = "**/api/eval/sessions?filter=unlabeled";
	await page.route(filterUrl, (route) => { filterRoute = route; signalFilter(); });
	await page.locator("#eval-filter").selectOption("unlabeled"); await filterHeld;
	assert.equal(await page.locator('.eval-session').count(), 0);
	await filterRoute.continue(); await page.unroute(filterUrl);
	await page.waitForFunction(() => {
		const rows = [...document.querySelectorAll('.eval-session')];
		return rows.length > 0 && rows.every((row) => row.dataset.label === 'unlabeled');
	});
	assert.equal(await page.locator('[data-session-id="synthetic-a-review"]').count(), 0);
	await screenshot("eval-default-progress.png");
	// A late failed detail request cannot replace a newer selection.
	let pendingRoute, signalHeld;
	const held = new Promise((resolve) => { signalHeld = resolve; });
	const idleRoute = "**/api/eval/session?id=synthetic-idle";
	await page.route(idleRoute, (route) => { pendingRoute = route; signalHeld(); });
	await page.locator('[data-session-id="synthetic-idle"]').click(); await held;
	await page.locator('[data-session-id="synthetic-active"]').click();
	await page.getByText("会话仍在进行，这次标注针对目前的进度", { exact: true }).waitFor();
	const oldResponse = page.waitForResponse((response) => response.url().endsWith("id=synthetic-idle"));
	await pendingRoute.fulfill({ status: 500, contentType: "application/json", body: '{"error":"synthetic_late_failure"}' });
	await (await oldResponse).finished(); await page.unroute(idleRoute);
	assert.equal(await page.locator("#eval-pass").isDisabled(), false);
	assert.ok((await page.locator("#eval-workspace").textContent()).includes(ATTACK.slice(0, 45)));
	assert.equal(await page.locator("script").count(), scriptCount); assert.equal(await page.locator("img").count(), 0);
	assert.equal(await page.evaluate(() => globalThis.evalInjected), undefined);
	assert.equal(await page.locator("details[open]").count(), 0);
	await page.getByText("工具参数", { exact: true }).click();
	assert.ok((await page.locator("details[open]").textContent()).includes("已截断"));
	await page.getByText("工具结果", { exact: true }).click();
	await page.getByText("第一次出错", { exact: true }).waitFor();
	await page.locator("#eval-pass").click(); await page.locator("#eval-save").click();
	await page.getByText("标注已保存", { exact: true }).waitFor();
	assert.equal((await stored()).atEntryId, "entry-53"); assert.equal((await stored()).atEntryCount, 54);
	await page.getByText("当前：满意（来自后台）", { exact: true }).waitFor();
	await page.locator('[data-session-id="synthetic-active"]').waitFor({ state: 'detached' });
	assert.equal(await page.locator('.eval-session:not([data-label="unlabeled"])').count(), 0);
	// Appending invalidates only this timeline, not the list snapshot.
	await appendFile(activePath, JSON.stringify({ type: "message", id: "new-progress", parentId: "entry-53", message: { role: "user", content: "合成追加进度" } }) + "\n");
	await page.getByRole("button", { name: "更多会话", exact: true }).click();
	await page.locator('[data-session-id="synthetic-page-9"]').waitFor();
	await page.getByRole("button", { name: "下一页事件", exact: true }).click();
	await page.getByText("会话有更新，已重新加载", { exact: true }).waitFor();
	await page.getByText("标注后有新进展", { exact: true }).first().waitFor();
	assert.ok(!/HTTP 409/.test(await page.locator("#eval-workspace").innerText()));
	await page.locator("#eval-analyze").waitFor();
	await page.waitForFunction(() => !document.getElementById('eval-analyze').disabled);
	assert.equal(await inferenceCount(), 0);
	await page.locator("#eval-analyze").click();
	await page.getByRole("dialog", { name: "确认发送会话内容" }).waitFor();
	assert.ok((await page.getByRole("dialog").innerText()).includes("发送字符数"));
	await screenshot("eval-judge-confirm.png"); assert.equal(await inferenceCount(), 0);
	await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
	assert.equal(await inferenceCount(), 0);
	await page.locator("#eval-analyze").click();
	await page.getByRole("dialog").getByRole("button", { name: "确认并分析", exact: true }).click();
	await page.locator("#eval-adopt").waitFor();
	assert.equal(await inferenceCount(), 1); assert.equal((await stored()).verdict, "pass", "judge must not annotate");
	assert.equal((await launcherCalls()).filter((row) => row.args.includes('--list-models')).length, 3, "successful discovery stays cached across detail changes");
	await screenshot("eval-judge-result.png");
	await page.locator("#eval-adopt").click();
	assert.equal(await page.locator("#eval-fail").getAttribute("aria-pressed"), "true");
	assert.equal(await page.locator("#eval-note").inputValue(), "合成工具结果不符合要求");
	assert.equal((await stored()).verdict, "pass", "adoption only prefills");
	await page.locator("#eval-failset").check(); await page.locator("#eval-save").click();
	await page.getByText("标注已保存", { exact: true }).waitFor();
	assert.equal((await stored()).verdict, "fail"); assert.equal((await stored()).atEntryId, "new-progress");
	await page.reload(); await page.getByRole("button", { name: "评测", exact: true }).click();
	await page.locator("#eval-filter").selectOption("failSet");
	await page.locator('[data-session-id="synthetic-active"]').click();
	await page.locator("#eval-first-problem").waitFor();
	assert.equal(await page.locator("#eval-note").inputValue(), "合成工具结果不符合要求");
	assert.equal(await page.locator("#eval-failset").isChecked(), true);
	await page.locator("#eval-first-problem").click();
	await page.locator('.eval-event.focused[data-event-index="2"]').waitFor();
	await screenshot("eval-judge-evidence.png");
	// Visible UI copy scan. Session content and technical identifiers are data,
	// not translatable labels; keep this allowlist explicit and small.
	const english = await page.evaluate(() => {
		const words = new Set(), walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const node = walker.currentNode, parent = node.parentElement;
			if (!parent?.checkVisibility() || parent.closest('script,style,pre,.eval-text,.eval-session strong,#root-path')) continue;
			for (const word of (node.textContent || '').match(/\b[A-Za-z][A-Za-z_.-]*\b/g) || []) words.add(word);
		}
		return [...words].sort();
	});
	const allowed = new Set(["ROTOM", "Rotom", "R", "fake", "model", "bash", "tool_error", "repeat-after-error", "ended-after-tool-error", "ended-on-provider-error", "schema-errors", "oversized-tool-result", "harness-fault", "unknown", "ROTOM_EVAL_REPLAY_BASELINE"]);
	assert.deepEqual(english.filter((word) => !allowed.has(word)), [], "untranslated visible UI copy");
	// Replay panel: pin a point on a failed step, list it, run it, cancel it, delete it.
	// Only a reviewed failure offers a replay point, so mark this one 不满意 first.
	await page.locator("#eval-filter").selectOption("all");
	await page.locator('[data-session-id="synthetic-a-review"]').click();
	await page.locator("#eval-fail").click();
	await page.locator("#eval-save").click();
	await page.getByRole("button", { name: "设为回放点", exact: true }).first().waitFor();
	await page.getByRole("button", { name: "设为回放点", exact: true }).first().click();
	await page.locator('dialog[aria-label="设为回放点"] textarea').fill("应该先查状态再回答");
	await page.locator('dialog[aria-label="设为回放点"] select').first().selectOption("rule");
	await page.getByRole("button", { name: "保存回放点", exact: true }).click();
	await page.locator("#eval-replay article").first().waitFor();
	assert.equal(await page.locator("#eval-replay article").first().innerText().then((text) => text.includes("应该先查状态再回答")), true);
	await screenshot("eval-replay-list.png");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("模型") + "]").fill("faux/faux-1");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("每个回放点重复次数") + "]").fill("1");
	// No ROTOM_EVAL_REPLAY_BASELINE here: the comparison arm must not be offered.
	assert.equal(await page.locator("#eval-replay-baseline").isVisible(), false);
	await page.getByText("未配置对照臂（ROTOM_EVAL_REPLAY_BASELINE），只能回放当前产品。", { exact: true }).waitFor();
	await page.getByRole("button", { name: "运行回放", exact: true }).click();
	// The dialog states the measured size before anything runs.
	await page.getByText(/^共 1 次回放（1 个回放点 × 1 次 × 1 个产品）$/u).waitFor();
	await page.locator('dialog[aria-label="确认运行回放"]').getByText(/^截断前内容：1 个回放点合计 [\d,]+ 字符（单个最大 [\d,]+），按上述次数总计 [\d,]+ 字符。$/u).waitFor();
	await screenshot("eval-replay-confirm.png");
	await page.getByRole("button", { name: "确认运行", exact: true }).click();
	await page.getByText("回放结束 · 已运行 1 / 1", { exact: true }).waitFor();
	// A slow runner proves progress is visible and cancel stops the run. The panel
	// rebuilds its controls after each run, so the fields are filled again.
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("模型") + "]").fill("faux/faux-1");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("每个回放点重复次数") + "]").fill("3");
	await page.getByRole("button", { name: "运行回放", exact: true }).click();
	await page.getByRole("button", { name: "确认运行", exact: true }).click();
	await page.getByText("已运行 1 / 3", { exact: true }).waitFor();
	await screenshot("eval-replay-progress.png");
	await page.getByRole("button", { name: "取消回放", exact: true }).click();
	await page.getByText(/回放已停止|回放结束/u).waitFor();
	await page.getByRole("button", { name: "删除回放点", exact: true }).click();
	await page.getByText("还没有回放点。在失败会话的消息上点「设为回放点」。", { exact: true }).waitFor();
	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.evaluate(async () => { window.scrollTo({ top: 0, behavior: 'instant' }); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
	assert.equal(await page.evaluate(() => window.scrollY === 0 && document.querySelector('.topbar').getBoundingClientRect().bottom < 160 && !document.elementFromPoint(20, innerHeight - 20)?.closest('.topbar')), true);
	await screenshot("eval-active-mobile.png");
	await page.getByRole("button", { name: "执行链路", exact: true }).click();
	assert.equal(await page.locator("#eval-workspace").isVisible(), false);
	await page.route("**/api/traces", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
	await page.getByRole("button", { name: "刷新数据", exact: true }).click();
	await page.getByText("连接错误 · 访问 token 无效，请重新打开 rotom --trace 打印的链接", { exact: true }).waitFor();
	assert.deepEqual(errors, []); assert.deepEqual(external, []);
	console.log(JSON.stringify({ status: "PASS", screenshots, pageErrors: errors.length, externalRequests: external.length, fakeInferences: await inferenceCount(), englishTechnicalAllowlist: english }));
} catch (error) {
	if (page) { await screenshot("failure.png"); console.error("Synthetic screenshot: " + screenshots.at(-1)); }
	throw error;
} finally {
	await browser?.close(); await dashboard.close();
	for (const path of [root, evalDirectory, fake.launcher, fake.control, fake.calls, replayRunner, replayMarker]) await rm(path, { recursive: true, force: true });
}
