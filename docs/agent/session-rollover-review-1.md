# 同会话轮转 · 第 1 轮核验意见与返工清单

核验对象：`claude/kind-bardeen-roufe9` 上 `f266b30..98c16d2`（W1–W6）。执行方式沿用 [执行清单](session-rollover-worklist.md) 第 0、1、4、5、6 节：连续完成下列返工项，不中途提问；授权范围不变；完成后更新回报并推送到同一分支。

## 已核验通过

评审方在 Linux / Node 22 上复跑（与执行方的 macOS / Node 24 不同环境）：

| 检查 | 结果 |
| --- | --- |
| `rotom/extensions/session-rollover/*.test.ts` | 19/19 |
| `rotom/extensions/context-layers/*.test.ts` | 10/10 |
| Pi fork：`session-rollover-seam`、`agent-session-compaction`、`agent-session-auto-compaction-queue`、`extensions-runner`、`trigger-compact-extension`（vitest） | 71 passed / 5 skipped |
| `node rotom/scripts/build-pi-fork.mjs --check` | exit 0，提交的归档与源码一致 |

代码审读确认：重置接缝只在 `input` 处理器内且空闲时可用、不调用 `abort()`；重置后 `agent.state.messages` 已刷新，随后 `_prepareRun` 找不到旧助手消息，不会再触发压缩；`rollover` 原因下替代压缩被忽略；Offload 只处理 `threshold`，observability 对 `preparation` 使用可选链，缺 `preparation` 不报错；`session-rollover` 在 `third-party` 之前加载。`--no-verify` 提交上游大文件、报告与设计拆分、footprint 只调整本次差值，这些决定接受。

## 返工项

### R1（必须修）：手动 `/compact` 后的下一次输入会立即轮转，清掉刚生成的摘要

- **原因**：`getContextThresholdEstimate()` 在压缩后、新回复之前返回 `stale: true`，此时 `tokens` 是“压缩前的旧 usage + 其后消息估算”，数值仍然很大。`_checkCompaction` 遇到 `stale` 直接不压缩，但轮转扩展的 `RolloverEstimate` 没有读取 `stale`，按 `tokens` 判定越过水位。
- **复现**（评审方已跑，断言失败，实际得到 `["native", "rotom-rollover"]`）：

```ts
test("no rollover right after a manual compaction", withDir(async (dir) => {
	const h = await createHarness({ dir, rollover: "1", recall: true, historyTokens: WATERMARK + 500 });
	try {
		h.faux.setResponses([fauxAssistantMessage("manual summary of earlier work")]);
		await h.session.compact();
		assert.equal(h.session.getContextThresholdEstimate().stale, true);
		h.faux.setResponses([assistantWithUsage("reply", 10)]);
		await h.session.prompt("next request");
		assert.deepEqual(compactionEntries(h.session).map((e: any) => e.details?.kind ?? "native"), ["native"]);
	} finally {
		h.dispose();
	}
}));
```

- **修复要求**：估算 `stale` 时不轮转，也不在轮末取消压缩（新增阻止原因，例如 `stale-estimate`，与 `_checkCompaction` 的口径一致）。把上面的用例加进 `index.test.ts`，并在 `eligibility.test.ts` 补单条用例；负向对照：去掉 `stale` 判断时用例必须失败。
- 同时检查其他产生 `stale` 的路径（会话恢复时最后一条是压缩条目、`/tree` 回到压缩后的位置），至少补一个恢复场景的用例。

### R2（必须修，影响合入判断）：阶段 0 把“轮中越线后被压缩”的情况计为轮末

- **原因**：`analyzeSession` 以压缩条目分段，并且只在段内判断越线请求是否是所在轮的最后一个请求。真实会话里轮中越线后，Pi 在同一轮的下一次请求前压缩，于是越线请求恰好是段内最后一个请求，被计为轮末。
- **复现**（评审方已跑）：分支为“用户 → 5 万 → 9 万（窗口 10 万、reserve 1.6 万）→ 压缩 → 同一轮继续 3 万、4 万 → 下一条用户消息”，脚本输出 `midTurn: 0, turnEnd: 1`，正确应为 `midTurn: 1`。
- **影响**：回报中“轮中 13 / 轮末 314”不可信，很可能大部分其实是轮中越线。接管比例的计算不依赖这个分类，但见 R3。
- **修复要求**：判断“越线请求之后、下一条用户消息之前，是否还有本轮的请求”时要跨过压缩条目看整条分支。把上面的分支写成单测；负向对照：退回段内判断时用例失败。

### R3（必须修，影响合入判断）：门槛的分母与设计不一致

- 设计 9.1 的门槛是“原本发生过原生阈值压缩的会话中，至少一半**在第一次原生压缩之前**就能被轮转接管”。现在的会话占比统计的是“任意一个越线段可被接管”的会话，会高估。
- **修复要求**：会话级占比只看每个会话的第一个越线段；段级占比照旧输出。补单测：一个会话第一段不可接管、第二段可接管，会话级计为不可接管。
- R2、R3 修完后在维护者本机重跑一次，更新 `session-rollover-report-stats.md` 与门槛结论。**若 2× 不再达标**：按设计不合入 `main`，在回报中写明；不为达标改门槛，也不改选 3×/4×（那是设计变更，需要用户决定）。

### R4（必须修）：CLAUDE.md 与文档中的不准确表述

- CLAUDE.md 第 3 节说 `context_recall` 的“检索结果不进入下一轮请求”。这不成立：工具结果是普通工具结果，会留在后续请求的上下文中。删去这句，或改为如实描述。
- 同段“只把被压缩或轮转清出的原始文本/图片临时展开”也不准确：搜索覆盖当前分支全部消息。改为如实描述。
- CLAUDE.md 第 72 行仍写“Context Layers 三工具”，改为一个工具。
- 全仓检索其他残留的三工具表述（历史记录与验证 JSON 除外）。

### R5（建议修）：以 `/` 开头的输入一律不轮转

- `/skill:name …`、`/template …` 会展开成真实模型请求，但被当作本地命令跳过。结果是安全的（退回原生压缩），只是少接管。
- 建议：只在文本匹配已注册的 Skill 或模板之外的 `/` 命令时跳过；判断不了就保持现状并在回报说明。

## 交给用户决定的事项（执行方不处理）

- context footprint 基线漂移 +1,986 schema 字节（与本任务无关）。
- R2、R3 重跑后是否把 B 合入 `main`；真实模型续做实测（设计 9.3）的授权与预算。
- `rotom/extensions/third-party/index.test.ts` 不退出导致 `check-personal` 挂起的既有缺陷是否另开任务修。

## 完成标准

- R1–R4 全部完成并各有测试与负向对照；R5 完成或写明不做的理由。
- 回报新增“第 1 轮返工”一节：每项的提交、测试数、负向对照结果，以及阶段 0 重跑结果。
- 受影响测试、`check:pi`（若改了 Pi）、`git diff --check`、`audit-public.py --root .` 通过。
