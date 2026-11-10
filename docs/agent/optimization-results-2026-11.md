# 优化方案本机验证结果（2026-11）

由本机 Agent 按 [交接说明](optimization-handoff-2026-11-10.md) 填写；云端会话据此核验。数字注明来源命令与日期；路径写 `~`；不放会话正文或摘录。

## 总览

| 步骤 | 状态 | 一句话结论 | 证据位置 |
|---|---|---|---|
| S1 本机确定性检查 | pending | | |
| S2 真实会话冒烟 | pending | | |
| S3 gate | pending | | |
| S4 harvest（P1-2） | pending | | |
| S5 压缩后续跑 baseline（P1-1） | pending | | |
| S6 coding-policy 开/关（P1-3） | pending | | |
| S7 Subagent 有/无（P1-4） | pending | | |
| S8 Reducer 开/关（P1-5） | pending | | |

环境：macOS 版本、Node 版本、分支 HEAD、基线 `9798c5a`、日期。

## S1 本机确定性检查

| 检查 | 结果 | 计数/输出摘要 |
|---|---|---|
| `check:pi` | | |
| `check-personal` | | |
| Subagent unit/SDK/typecheck | | |
| eval 离线测试 / 类型 | | |
| distribution | | |

新增失败及处理（提交号）：

## S2 真实会话冒烟

- `coding_policy` 分段出现：
- forced 整块 system 文本不存在：
- 任务结束状态与错误：
- Subagent 委派（如执行）：

## S3 gate

| 用例 | 角色 | baseline | candidate | 判定 |
|---|---|---|---|---|

gate 输出目录（`~/.rotom/loop/gate-…`）：

## S4 harvest（P1-2）

| 指标 | 值 |
|---|---|
| 会话数 / 用户轮 | |
| 全局每 100 轮介入 | |
| 压缩次数 | |
| 压缩后每 100 轮介入（介入/轮） | |
| 重读所列文件比例 | |
| 用了 recall 的压缩次数 | |
| 压缩后 Goal 暂停 | |
| 摘要输出 token 中位数 | |
| cacheDrops | |

## S5 压缩后续跑 baseline（P1-1）

| 用例 | baseline 失败/3 | candidate 通过/3 | 判定（not-reproduced / flaky-candidate / reproduced-regression） | 是否入 gate |
|---|---|---|---|---|
| behavior-standing-directive-after-compaction | | | | |
| behavior-exact-detail-after-compaction | | | | |

## S6 coding-policy 开/关（P1-3）

| 套件 / 用例 | 有 policy 通过 | 无 policy 通过 | token 差 | 工具调用差 | 判定 |
|---|---|---|---|---|---|

## S7 Subagent 有/无（P1-4）

| 用例 | 臂 | 正确/次数 | 平均 subagentCalls | 父会话 usage（in/out/cacheRead） | 子任务 usage | 耗时 |
|---|---|---|---|---|---|---|

## S8 Reducer 开/关（P1-5）

用户是否同意 openai-codex 花费：

| 套件 | Reducer 开 通过 | 关 通过 | 是否触发 Reducer | 总 token 差（含 Reducer） | 耗时差 |
|---|---|---|---|---|---|

## 建议交给用户决定的 P2 事项

按证据列出：哪一项有支持证据、哪一项被证据否定、哪一项仍无证据。
