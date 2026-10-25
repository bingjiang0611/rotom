# 任务 02 · 标注会话、归纳失败类别（bob 本人）

阶段：Phase 1。执行人：**bob**，不交给 agent。预计 2 到 3 小时，可以分几次做。

## 为什么必须人来做

后面的规则检查和 LLM judge 都要拿这份标注当标准答案。如果标注也让模型来打，就等于让模型给自己判卷，judge 准不准就没法验证了。

## 步骤

1. 生成卡片（输出在仓库外，不会进 Git）：

   ```sh
   node rotom/evals/scripts/session-cards.mjs build --limit 100
   ```

   卡片在 `~/.rotom/evals/cards/`。Pi 不认的非会话文件会被跳过，100 个文件大约能出 50 张卡片。

2. 逐张读卡片，在末尾的标注块里填写：

   ```
   <!-- label:begin -->
   verdict: fail
   categories:
   note: 声称测试通过，但过程里没有跑测试
   <!-- label:end -->
   ```

   - `verdict` 只填 `pass` 或 `fail`。判断标准只有一条：**如果这是你交给同事的活，你会不会满意**。不确定就填 `fail`，并在 note 里写为什么。
   - `note` 用一句话写**第一个出错的地方**，只写第一个，后面连带出的问题不用写。
   - `categories` 先**留空**。读完 30 张之前不要急着分类。

3. 读完 30 到 50 张后，把所有 fail 的 note 放在一起看，归成 5 到 10 类。每类起一个短的英文 slug（例如 `false-completion`、`blind-retry`、`wrong-target`），再回头把 slug 填进各卡片的 `categories`，可以填多个，用逗号隔开。

4. 汇总：

   ```sh
   node rotom/evals/scripts/session-cards.mjs labels
   ```

   会生成 `~/.rotom/evals/labels.jsonl`，并打印 pass/fail 数和各类别数量。

5. 把类别表发给规划者。只需要发**每类的 slug、一句话定义、出现次数**，不要发会话内容。规划者会把它写进 `rotom/evals/failure-taxonomy.md`，用的是合成的例子。

## 完成标准

- 至少 30 张卡片有 verdict。
- 每个类别至少有 3 个真实样本；不到 3 个的并进相近的类，或者归到 `other`。
- 规划者收到类别表。

## 注意

- 卡片是完整的对话内容，**不要**复制进仓库、issue 或聊天。
- 重新运行 `build` 不会覆盖已经填了 verdict 的标注块。
