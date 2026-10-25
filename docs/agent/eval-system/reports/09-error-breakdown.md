# 任务 09 报告 · 工具出错与 provider 出错拆解

执行者按 [tasks/09-error-breakdown.md](../tasks/09-error-breakdown.md) 实现，只读 trace metadata，不读会话正文、工具参数或错误正文，也不替 bob 标注。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/evals/scripts/error-breakdown.mjs` | 新增纯函数 `toolErrorRows(traceRecords)`、`providerErrorRows(traceRecords)`、`aggregateBreakdown(sessions)` |
| `rotom/evals/scripts/error-breakdown.d.mts` | 对应类型声明 |
| `rotom/evals/scripts/session-cards.mjs` | `readTrace` 额外返回原始 span 记录（不新增读取）；新增 `errorBreakdown({root,since,out})`、`renderBreakdownMarkdown`，CLI 子命令 `breakdown [--root] [--since 28d] [--out]` |
| `rotom/evals/scripts/session-cards.d.mts` | `BreakdownSummary`、`errorBreakdown` 声明 |
| `rotom/evals/test/error-breakdown.test.ts` | 新增 11 个合成 trace 单测 |
| `rotom/evals/test/session-cards.test.ts` | 新增 2 个集成测试：stdout 不含 session id + 私有文件 0600；Git 工作树与 build-only 参数拒绝 |
| `.github/workflows/evals-l1.yml` | 测试过滤词加 `error-breakdown` |
| `rotom/evals/README.md` | 3 行以内用法补充，CI 过滤词说明同步 |
| `docs/agent/eval-system/README.md` | 状态表 09 → `in-review` |

实际 span 名（以本机 512 个 trace、1,201,569 条记录核实）：工具是 `pi.tool.execute`；provider 请求是 `pi.ai.request`，`pi.ai.startup`／`pi.ai.prefill`／`pi.ai.generation`／`pi.ai.reasoning` 只是它的子阶段，本身不带错误属性。任务说明里写的属性名全部实测存在（`pi.ai.error.category`、`pi.ai.error.http_status`、`pi.ai.qoder.error_code`、`pi.ai.qoder.transport_phase`、`pi.ai.request.end_reason`、`pi.ai.response.stop_reason`）。

## 验收命令与结果

| 命令 | 结果 |
|---|---|
| `cd rotom/evals && npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown`（与 CI 过滤词一致） | 6 文件 / 150 用例全通过 |
| `npm test`（全量） | 238 passed / 10 failed / 1 skipped（249）；失败仍是既有 10 个：`pi-harness` 3、`coding-hygiene-rule-ablation` 3、`product-runtime` 2、`tool-surface-ablation` 2，原因同前几次任务：装机的 `@injaneity/pi-computer-use` 是 `0.5.1-rotom.0`，分支 manifest 要求 `0.5.1-rotom.2`，失败在 package identity gate。本次改动新增 13 个用例，全在通过这些之内 |
| `npm run typecheck` | 通过（无输出） |
| `git diff --check` | 通过 |
| `python3 scripts/audit-public.py --root .` | 树审计 PASS，0 处命中（7,824 个文件） |
| `python3 scripts/audit-public.py --root . --history`（隔离公开 clone 内） | BLOCKED：14 条 finding，全部是 `eval/system` 已公开历史里 7 个规划者提交的 `noreply@anthropic.com` author/committer 身份（6 个 compaction 文档提交 + `fc539150e67d`）。本次提交用 GitHub noreply 身份，未新增 finding，也未改写已公开历史。注：本次拉取后这 6 个 compaction 提交已在该分支历史里，比之前记录的 1 个提交多 |

GitHub Actions `Evals L1`：[run 40206497180](https://github.com/bingjiang0611/rotom/actions/runs/40206497180) 在 `5bdd5cc` 上通过（31 秒内完成 npm ci、6 个测试文件过滤运行、typecheck 与树审计）。

## 真实数据冒烟

命令：`node scripts/session-cards.mjs breakdown --since 28d --out <仓库外临时目录>/cards`，退出码 0，stderr 空，stdout 只有聚合 JSON（已断言不含 `sessionId`）。私有 `breakdown.md` 权限 0600，位于 Git 工作树外。

一次运行（数字随正在写入的会话会小幅变化）：

- 会话 175（skipped 325，trace missing 15，trace partial 3，parse errors 0）。
- 已结束工具 span 53,853，出错 4,079（其中 aborted 12）。
- 工具出错表（前 6）：bash 19,261 span / 2,131 出错（11.1%，占全部工具出错 52.2%）；edit 7,268 / 724（10.0%，17.7%）；browser_interact 451 / 451（100%，11.1%，全部是 `unknown_outcome`）；act_ui 286 / 203（71.0%，5.0%）；codemode 3,129 / 168（5.4%，4.1%）；write 1,961 / 140（7.1%，3.4%）。
- 集中度：114 个会话有工具出错；出错最多的前 12 个（前 10%）贡献 2,411/4,079（59.1%）。
- provider：请求 span 40,959，出错 1,213，aborted 请求 55（不计入出错）。前 5 组都是 `openai-codex`：gpt-6-astra timeout 438（36.1%）、gpt-6.1-sol timeout 254（20.9%）、gpt-6.1-sol network 210（17.3%）、gpt-6-astra network 87（7.2%）、gpt-6.1-sol websocket 55（4.5%）；`qoder/dfmodel` network 50（4.1%）带 `qoder.error_code=transport_failure`、`transport_phase=request` 49／`stream` 1。http 类里 `cc-switch/claude-opus-5-5` 429 24、403 4，`radius/*` 402。
- 会话以 provider 错误结束 22 个：run 内重试 0 个，整个会话 ≥2 次出错请求 5 个，只有 1 次 17 个。

最大的两个出错来源（只陈述数字）：工具侧是 bash，2,131 次占全部工具出错的 52.2%，其中 `nonzero_exit` 1,998 次、`command_timeout` 100 次；第二是 edit，724 次占 17.7%，其中 706 次没有 `error_code`。provider 侧单一来源是超时，`openai-codex` 两个模型合计 692/1,213 次（57.0%）。工具出错很集中：12 个会话（占有出错会话的前 10%）贡献 59.1% 的出错，不是均匀分布。

## 与任务说明不一致的地方

1. **「同一 run 内已有重试」实测恒为 0。** 本机 trace 里每次 provider 尝试都新建一个 `pi.agent.run`，一个 run 内最多只落 1 次出错请求（核对了 25 个以 provider 错误结束的会话，每个 run 的出错请求数都是 1）。按任务原文（同 run 出错请求数 ≥ 2）统计得到 0，会掩盖真实的重试。因此额外输出同口径的会话级计数：最后出错请求所在 run 的出错数（`runRetried`）、整个会话 ≥2 次出错请求（`sessionRetried`）、只有 1 次（`single`）。run 口径保留，没有替换。
2. **aborted 的处理。** 工具「出错数」按任务定义取 outcome ≠ `ok`，因此包含 aborted；同时单列 `aborted` 列并在报告里说明，避免把用户中断算成工具故障（`classifyFaultSide` 对 aborted 不判 fault_side，与之一致）。
3. **provider「出错」的判据。** 用请求 span 的 `status=error`，而不是 `pi.ai.error.category` 是否存在：本次 28d 窗口有 24/1,213（2.0%）出错请求没有 category（记 `(none)`），全历史 1,966 个出错请求里则有 514 个（旧 trace 早于 category 属性），只按 category 会漏算。`aborted` 与 `unknown` 状态的请求不计入出错，单独计数。
4. **`pi.ai.request.end_reason` 只有 6 条**（`turn_closed`），基本全是 `(none)`；它只作为附列，不参与分组。

## 未验证项

- 只在 macOS 本机、单用户 trace 上跑过；未在 CI 或其它机器验证真实数据数字，CI 只跑合成测试。
- `unknown_outcome`（如 browser_interact 328 次无 fault_side、无 error_code）无法从 metadata 判断是工具真失败还是调用方放弃，本任务按要求不猜，也不并入 harness 出错。
- 未验证 token 成本或耗时与出错的相关性（不在任务范围）。

## 遗留问题

- browser_interact 出错率 100%（451/451 全是非 `ok`），但其中 406 次是 `unknown_outcome`：这个工具的错误面需要在后续任务里单独定口径（是工具问题还是「写操作结果未证明」的诚实标记），本任务只做计数。
- 真正决定「修什么」还缺 fail 样本：bob 目前 44 张里 4 个 fail，仍不足以训练 judge；本报告只提供出错分布。
