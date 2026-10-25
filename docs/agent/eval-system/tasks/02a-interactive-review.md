# 任务 02a · 逐条提问的标注命令

阶段：Phase 1。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/02a-interactive-review.md`。

## 背景

bob 反馈完整卡片太长，读不下去，希望「一项一项问我」。所以把任务 02 的标注改成在终端里逐条提问：每个会话只显示几行摘要，bob 只回答满不满意，不满意的再补一句原因。分类不再由 bob 来做，规划者会根据 bob 写的原因来归纳。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/session-cards.mjs` | 新增子命令 `review [--out <cards dir>] [--limit N]` |
| `rotom/evals/scripts/review.mjs` + `.d.mts` | 摘要提取和交互循环；输入输出流可注入，方便测试 |
| `rotom/evals/test/review.test.ts` | 用注入的输入流驱动的合成测试 |
| `rotom/evals/README.md` | 补 5 行以内的用法 |
| `docs/agent/eval-system/tasks/02-label-sessions.md` | 把步骤改成先用 `review`，原来手工编辑的方式保留为备选 |

## 交互

只处理 `verdict` 为空的卡片，按 `started` 从新到旧排列，默认最多 50 张。每张卡片输出**不超过 8 行**：

```
[3/40] 10-24 21:03 · 12 分钟 · 工具 18 次 · 出错 2 次
你的请求：<首条 user 消息，压成一行，前 120 字>
规则提示：oversized-tool-result（没有 hit 就不显示这一行）
最终回复：<最终回复，压成一行，前 160 字>
满意吗？ y 满意 / n 不满意 / s 跳过 / o 看完整卡片 / q 退出 >
```

- `y`：写入 `verdict: pass`。
- `n`：接着问 `一句话说哪里不对（回车跳过）>`，写入 `verdict: fail`，`note` 填这句话。
- `s`：不写，进入下一张。
- `o`：输出这张卡片的绝对路径，然后再问一遍同一个问题，不自动打开编辑器。
- `q`：退出，已经回答的都已保存。
- 其它输入：重复提问，不报错退出。
- 每答完一张就立即写回这张卡片的标注块（沿用现有的私有原子写入），`categories` 保持为空。中途 Ctrl+C 不会丢失已经保存的回答。
- 结束时打印一行：`本次 pass N / fail M / 跳过 K，还剩 R 张未标注`。

摘要从卡片文件本身读取（frontmatter 和各个小节），不重新读 session。字段缺失时显示 `?`，不要报错。

## 约束

- stdin 不是 TTY 时拒绝运行并退出非 0（测试里通过注入流绕过）。
- 只改标注块，卡片其它内容逐字节不变；已有 verdict 的卡片不出现。
- 标注块格式损坏的卡片跳过，计入结束时的 `损坏 N 张`，不覆盖。
- 输出路径的 Git 工作树检查、权限要求同 `build`。

## 单测至少覆盖

y / n（有原因和无原因）/ s / o / q / 非法输入的流程；只改标注块；已标注的卡片不出现；排序和 limit；8 行上限和截断；字段缺失；损坏的标注块；结束统计。

## 验收命令

同任务 04（定向测试加上 `test/review.test.ts`）。CI 的测试过滤词要加上 `review`，即修改 `.github/workflows/evals-l1.yml` 的 `npm test -- session-cards trace-assertions agreement review`；推送后确认 Actions 是绿的，报告附运行链接。

## 不在本任务范围

自动分类、LLM、改卡片的生成格式、编辑器集成。
