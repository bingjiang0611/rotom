# 任务 02 · 回答满意度、提供失败原因（bob 本人）

阶段：Phase 1。执行人：**bob**，不交给 agent。可以分几次做；分类由规划者根据失败原因归纳，不要求 bob 起类别名。

## 为什么必须人来做

后面的规则检查和 LLM judge 都要拿这份标注当标准答案。如果标注也让模型来打，就等于让模型给自己判卷，judge 准不准就没法验证了。

## 步骤

1. 生成卡片（输出在仓库外，不会进 Git）：

   ```sh
   node rotom/evals/scripts/session-cards.mjs build --limit 100
   ```

   卡片在 `~/.rotom/evals/cards/`。Pi 不认的非会话文件会被跳过，实际生成数量以命令统计为准。

2. 在交互终端逐条回答，不必读完整长卡片：

   ```sh
   node rotom/evals/scripts/session-cards.mjs review --limit 50
   ```

   - 只问 verdict 为空的卡片，按 started 从新到旧。判断标准只有一条：**如果这是你交给同事的活，你会不会满意**。
   - `y` 满意，写 pass；`n` 不满意，写 fail，再用一句话写第一个出错的地方，原因可回车留空。
   - 不确定或摘要不足以判断时，`o` 查看完整卡片路径，或 `s` 跳过。命令不会自动打开编辑器。
   - `q` 退出，也可以 Ctrl+C；每张答完立即保存，下次不会再问已标注的卡片。尚未完成的当前卡片不算已保存。
   - categories 保持为空；不要为了凑数量替不确定的会话下结论。损坏标注块会单独计数，不覆盖。

3. 回答 30 到 50 张后汇总：

   ```sh
   node rotom/evals/scripts/session-cards.mjs labels
   ```

   生成 `~/.rotom/evals/labels.jsonl`，打印 pass/fail 数和已有类别数量；此时 categories 为空是预期行为。

4. 向规划者提供**经人工脱敏的一句话失败原因及计数**，不要直接发送卡片、原始 labels 文件或会话内容。原因若包含凭据、个人信息或私有路径，先删去这些内容。规划者据此归纳 5 到 10 类并给出 slug、定义和计数，再安排类别回填；review 不自动分类、不代填判断。

## 备选：手工编辑标注块

不使用 review 时，可在每张卡片末尾填写，完成后仍执行 `labels`：

```
<!-- label:begin -->
verdict: fail
categories:
note: 声称测试通过，但过程里没有跑测试
<!-- label:end -->
```

verdict 只填 pass 或 fail，note 写第一个出错的地方，categories 暂留空。不要修改标记和字段名；格式损坏会被拒绝或跳过。

## 定向补标（完成任务 08 之后）

首轮 27 张只有 2 张 fail，样本不足以做失败分类，也验证不了 judge。任务 08 的 `stats` 不需要标注，
可以按周看过程有多折腾；补标则只挑可疑会话，避免把 30 到 50 张的配额再花一遍在明显正常的会话上。

1. 生成可疑会话的卡片（`--limit` 是要生成多少张卡片，不是扫描多少会话）：

   ```sh
   node rotom/evals/scripts/session-cards.mjs build --focus --limit 40
   ```

   候选条件：工具出错数 ≥ 5 且出错率 ≥ 10%、任一规则命中、最终回复没有文本、或因 provider 错误结束。
   已填 verdict 的卡片会保留原有标注，所以可以和首轮标过的卡片放在同一目录。

2. 照常运行 `review`，它只问还没有 verdict 的卡片：

   ```sh
   node rotom/evals/scripts/session-cards.mjs review --limit 40
   ```

3. 补标完成后仍用 `labels` 与 `agreement` 汇总；新增样本与首轮样本一起统计，不需要分开维护。

规则命中不等于人工 fail，只是可疑；最终仍由 bob 判断满意或不满意。

## 完成标准

- 至少 30 张卡片有 bob 本人的 verdict。
- 规划者收到脱敏失败原因及计数，可以开始归纳类别；bob 不负责手工分类。
- 类别归纳阶段仍以每类至少 3 个真实样本为目标；不足的由规划者合并或归入 other，不由 review 自动处理。

## 注意

- 卡片和 review 的输出含私有会话信息，**不要**复制进仓库、issue 或聊天。
- 重新运行 build 不会覆盖已经填了 verdict 的标注块。
- `--out <cards dir>` 可指定已有卡片目录；不重新读取 session，且输出必须在 Git 工作树外。
