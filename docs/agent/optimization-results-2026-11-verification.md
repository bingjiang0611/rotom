# 优化方案本机验证的云端核验（2026-11）

云端会话对本机验证结果的核查与统计强度修正，独立成文以免 [结果记录](optimization-results-2026-11.md) 超过暂存文件预算；各次运行的原始数字仍以结果记录为准。

## 核验内容（2026-11-10）

核对了三个提交（`f0ef469`、`c1550f5`、`7b009e2`）：只改结果文档与本方案账本分片，作者为 GitHub noreply；`git diff --check`、账本校验（28 条）、tree 公开审计（0 发现）均通过。账本没有把任何条目标为 `improved`，证据等级与下列判断一致。

统计强度修正（每臂 5 次，Fisher 精确检验双侧 p）：

| S6 用例 | 有 / 无 policy | p | 读法 |
|---|---|---|---|
| hygiene `target repository root` | 5/5 vs 0/5 | 0.008 | 强证据：该规则有效 |
| `mixed-decision-ownership` | 4/5 vs 1/5 | 0.21 | 方向一致，样本不足 |
| `authorized-follow-through` | 5/5 vs 3/5 | 0.44 | 方向一致，样本不足（与 2026-11-02 sol 上 0/3→3/3 同向） |
| `standing-directive-after-compaction` | 5/5 vs 3/5 | 0.44 | 方向一致，样本不足 |

上文“4 个用例可重复改善”应读作：1 个强证据、3 个同向弱证据。各 `no-difference` 用例两臂都满分，属于天花板，不能读成“规则无作用”的强证据。

S3：本分支带 policy 12/13 vs 基线 13/13，p=1.0，没有回归证据；gate 的 `regressed` 是三次样本中一次失败的机械判定，归因与 `gate.json` 已记录的 `flaky-candidate` 一致。

S4 的 `cacheDrops 450/466` 是压缩改写前缀的预期结果，不是新问题；压缩后介入率 17.6 vs 全局 10.6 与重读率 33.1% 是相关信号，支持把下一批压缩用例从 harvest 里压缩后的真实介入事件构造（P1-1 的两个合成用例在 dfmodel 上没有复现）。
