// The replay panel flow of the browser smoke, kept in its own file so neither
// script grows past what a reviewer can read in one pass. Synthetic data only:
// a fake runner stands in for the product, so no model is called.
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function replaySmoke(page, { evalDirectory, screenshot }) {
	// Pin a point on a failed step, list it, run it, cancel it, delete it. Only a
	// reviewed failure offers a replay point, so mark this one 不满意 first.
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
	// Two synthetic run rows on disk, so the list can show both arms and the judge
	// input version that scored them; v1 records keep their own number.
	const casesDir = join(evalDirectory, "replay", "cases");
	const [caseName] = (await readdir(casesDir)).filter((name) => name.endsWith(".json"));
	// The stored case has no `key` field; the file name is the key.
	const key = caseName.replace(/\.json$/u, "");
	const runDir = join(evalDirectory, "replay", "runs", "2026-01-01");
	await mkdir(runDir, { recursive: true, mode: 0o700 });
	for (const [arm, verdict, version] of [["original", "fail", null], ["candidate", "pass", "rotom-replay-judge/v2"]]) {
		const row = { schema: "rotom-replay-run/v1", key, arm, repetition: 1, verdict, reason: "synthetic", checkMode: "rule", judgePromptVersion: version, sameProduct: null, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", usage: null };
		await writeFile(join(runDir, `${key}-${arm}-1.json`), JSON.stringify(row) + "\n", { mode: 0o600 });
	}
	// Reload so the list is rebuilt from disk with both arms.
	await page.reload();
	await page.getByRole("button", { name: "评测", exact: true }).click();
	await page.locator("#eval-filter").selectOption("all");
	await page.locator('[data-session-id="synthetic-a-review"]').click();
	await page.getByText(/判定输入 v2/u).first().waitFor();
	assert.equal(await page.locator("#eval-replay article").first().innerText().then((text) => text.includes("caught") || text.includes("原回复：失败")), true);
	await screenshot("eval-replay-list.png");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("模型") + "]").fill("faux/faux-1");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("每个回放点重复次数") + "]").fill("1");
	// No ROTOM_EVAL_REPLAY_BASELINE here: the comparison arm must not be offered.
	assert.equal(await page.locator("#eval-replay-baseline").isVisible(), false);
	await page.getByText("未配置对照臂（ROTOM_EVAL_REPLAY_BASELINE），只能回放当前产品。", { exact: true }).waitFor();
	await page.getByRole("button", { name: "运行回放", exact: true }).click();
	// The dialog states the measured size before anything runs.
	await page.getByText("共 2 次回放（1 个回放点 × 1 次 × 1 个产品，另加 1 次原回复对照）", { exact: true }).waitFor();
	await page.locator('dialog[aria-label="确认运行回放"]').getByText(/^截断前内容：1 个回放点合计 [\d,]+ 字符（单个最大 [\d,]+），按上述次数总计 [\d,]+ 字符。$/u).waitFor();
	await screenshot("eval-replay-confirm.png");
	await page.getByRole("button", { name: "确认运行", exact: true }).click();
	await page.getByText("回放结束 · 已运行 2 / 2", { exact: true }).waitFor();
	// Totals count only reported usage; the conclusion names what the control proved.
	await page.getByText("总用量：输入 160 · 输出 35 · 合计 195 tokens（未报告的记为未知，不含费用）", { exact: true }).waitFor();
	await page.getByText(/结论 caught：原回复失败、当前产品通过，判定抓得住/u).first().waitFor();
	// A verdict carries the judge input version it was scored by.
	await page.getByText(/判定输入 v2/u).first().waitFor();
	// A slow runner proves progress is visible and cancel stops the run. The panel
	// rebuilds its controls after each run, so the fields are filled again.
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("模型") + "]").fill("faux/faux-1");
	await page.locator("#eval-replay input[aria-label=" + JSON.stringify("每个回放点重复次数") + "]").fill("3");
	await page.getByRole("button", { name: "运行回放", exact: true }).click();
	await page.getByRole("button", { name: "确认运行", exact: true }).click();
	await page.getByText("已运行 1 / 4", { exact: true }).waitFor();
	await screenshot("eval-replay-progress.png");
	await page.getByRole("button", { name: "取消回放", exact: true }).click();
	await page.getByText(/回放已停止|回放结束/u).waitFor();
	await page.getByRole("button", { name: "删除回放点", exact: true }).click();
	await page.getByText("还没有回放点。在失败会话的消息上点「设为回放点」。", { exact: true }).waitFor();
}
