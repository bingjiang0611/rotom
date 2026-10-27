# 任务 11 · 命令失败是正常迭代还是在原地打转

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/11-command-failures.md`。

## 背景

任务 09、10 合起来看，工具出错的大头是**命令失败**：bash `nonzero_exit` 约 2,000 次，Action Fusion 的 then_run 失败约 500 次；真正的 edit 失败只有约 150 次。
但命令非 0 退出很多是正常的：grep 没搜到、测试在修复过程中本来就会失败。bob 反馈的「出错太多」指的是**过程在折腾**，所以要回答两个问题：

1. 失败的命令都是什么**类型**（搜索、测试、构建、git……）？
2. 有多少失败属于**原地打转**：同一条命令原样再跑、依然失败，或者连续很多次调用都失败？

trace 里没有命令内容（合同要求），`pi.tool.operation_digest` 只有部分工具有。所以和任务 10 的回推一样，**在本机内存里**读会话文件中工具调用的参数来计算，输出只有类别和计数。

## 交付物

| 文件 | 说明 |
|---|---|
| `rotom/evals/scripts/command-failures.mjs` + `.d.mts` | 纯函数：`commandCategory(commandText)`、`callFingerprint(toolName, args)`、`failureLoops(calls)`、`aggregateCommandFailures(rows)` |
| `rotom/evals/scripts/session-cards.mjs` | 给 `breakdown` 增加 `commandFailures` 输出和私有表，不新开子命令 |
| `rotom/evals/test/command-failures.test.ts` | 合成数据单测 |
| `.github/workflows/evals-l1.yml` | 测试过滤词加 `command-failures` |

## 1. 命令类别

对 bash 调用的 `command` 参数，以及 edit 的 `then_run` 参数，取**第一个实际执行的程序**归类（跳过 `cd … &&`、环境变量赋值、`sudo`、`npx`/`pnpm exec` 这类前缀；管道取第一段）。类别是固定枚举，程序名在规则表里写死：

`search`（grep、rg、find、fd、ls）· `test`（vitest、jest、pytest、`npm test`、`npm run test*`、`node --test`、go test、cargo test）· `build`（tsc、`npm run build*`、`npm run typecheck`、make、cargo build、go build）· `lint`（eslint、prettier、ruff、`npm run lint*`）· `git` · `package`（npm/pnpm/yarn install、ci、add）· `read`（cat、head、tail、sed -n、wc）· `run`（node、python、bash 脚本等其它解释器）· `other`。

识别不了就归 `other`，不要猜。规则用具名常量表，单测逐条覆盖。

输出：每个类别的调用数、失败数、失败率、占全部命令失败的比例；bash 与 then_run 分开两列。`search` 类的 exit code 1 单独计数（通常就是没搜到）。

## 2. 原地打转

把一个会话当前分支上的工具调用按顺序排好，每个调用记 `{ fingerprint, failed }`：

- `fingerprint` = sha256(工具名 + 规范化后的参数 JSON)，只在内存里用，不输出、不写文件。
- `failed` 以 trace 的 outcome 为准（通过 `pi.tool.call_id_digest` 关联）；trace 缺失时用 toolResult 的 `isError`，并分开计数。

统计（均为会话级，再汇总）：

- **原样重试仍失败**：同一个 fingerprint 失败后，又出现且**再次失败**的次数（中间隔多少个调用不限）。
- **最长连续失败**：每个会话最长的连续失败调用数；汇总给中位数、p90 和 ≥ 5 的会话数。
- **打转会话**：原样重试仍失败 ≥ 3 次，或最长连续失败 ≥ 5 次的会话。阈值写成具名常量。
- 打转会话贡献了多少比例的全部工具失败。

## 3. 和 bob 的标注对照

bob 已标注 44 张卡片（`labels.jsonl`）。按 session id 关联，输出 2×2 计数：打转会话 / 非打转会话 × pass / fail。只是计数，不算 precision/recall（fail 只有 4 个，样本太少），表下标注 n。

## 约束

- 命令文本、参数、fingerprint、程序名以外的任何内容都不能出现在 stdout、私有文件或报告里。私有 `breakdown.md` 可以列出打转会话的 session id（同任务 09）。
- 不改 trace 合同，不改任何产品代码。

## 单测至少覆盖

各类别（含前缀剥离、管道、`cd &&`、识别不了 → other）；fingerprint 对参数键顺序不敏感；原样重试仍失败的计数（中间夹其它调用、成功后再失败不算）；连续失败在 n = 0、1 时的结果；trace 缺失时回退到 `isError`；stdout 不含命令文本和 session id。

## 验收命令

同任务 10 的 eval 部分。推送后 Actions 要绿，报告附运行链接。

## 真实数据

运行 `breakdown --since 28d`，报告写出类别表、打转统计和与标注的 2×2 计数。最后用 3 到 5 句话回答：命令失败里，有多少比例像是正常迭代（搜索没结果、测试在修复中失败），多少比例像是原地打转。只陈述数字，不提修复方案。

## 不在本任务范围

修复任何工具、改提示词、改 trace 合同、LLM、标注。
