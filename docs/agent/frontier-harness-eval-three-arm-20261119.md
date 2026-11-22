预注册于 2026-11-19；实际只跑了第一轮（62 × 3 = 186 次），第二轮及以后未跑。

# FrontierHarness Eval：Pi 来源三臂对比

预注册依据：[L-2026-11-19-three-arm-pi-source-ab](../../rotom/evals/loop/ledger/2026-11-three-arm-pi-source.json)。此前 dev-agent 通过 `ROTOM_PI` 使用公开 Pi 1.4.0，成绩不能证明发行版 Pi fork 的效果。本设计区分扩展／策略和 Pi fork 的贡献，并检查 62 个任务能否把差异与噪声分开。

- **三臂**：native-pi、dev-agent、rotom-fork。后两臂用相同 bundle，只换 Pi binary；rotom-fork 的每次 trial 记录 `agent/pi-runtime.json` 证明实际加载的 runtime。
- **条件与顺序**：固定 FrontierHarness Eval 62 题（此前使用的摘要 `sha256:9236400f`）、`custom/bailian/deepseek-v4.1-flash`、thinking max、固定并发。Runta：4 vCPU，内存 8192 MiB，磁盘 32768 MiB。先选 3 个快任务对三臂冒烟，再估算成本和耗时。正式计划 62 × 3 × 4 = 744 次；三臂均完成同一轮才开始下一轮，平衡时段与负载。
- **主要指标**：每题每臂四次的通过率（k/4），比较 rotom-fork 与 native-pi 的逐题配对差；按 62 题 bootstrap 取 95% 区间，仅当区间不含 0 才判有差异。dev-agent 与 native-pi 的差用于拆分扩展／策略贡献，不是主结论。
- **次要指标**：各臂的 pass@4、pass^4、成本、步数、agent 超时数。ExecutionError、EnvironmentStartTimeoutError、ApiError 作为基础设施 unknown，按臂单列，不进主指标；AgentTimeoutError 计失败，使用各题 `task.toml` 的预算。
- **外推限制**：结论只适用于这个模型和题集；没有 Kimi K3 臂，不是排行榜比较。

**进度核对（2026-11-20）**：本机核实到预注册记录；在所查本地工作区、评测产物目录与会话索引中，未核实三臂冒烟或正式 trial 的完成数。不将计划次数当成实跑次数，也不据此推断远端进度。

## 第一轮实跑结果（2026-11-22）

**跑法与预注册的差异**（都在开跑前确定，理由写在这里，不改预注册的判断规则）：

- 沙箱换成 GCP 单机 Docker：`e2-standard-8`，asia-east1-b，容器 2 vCPU / 4096 MiB，并发 4，Harbor 0.26.0。Runta 侧 `balance_exhausted` 无法开沙箱，注册写的 4 vCPU / 8192 MiB / 32768 MiB 磁盘没做到。
- 模型网关 `idealab.alibaba-inc.com` 对云上 IP 直接超时（asia-east1、asia-southeast1 都试过），所以 API 流量走操作机到 VM 的反向 SSH 隧道。这意味着整轮实验依赖那条链路和那台机器在线，是这轮最脆的一环。
- 只跑第一轮：三臂各 1 次，`k/4` 这个主指标算不出来，只能用单轮通过率做配对差。

**三臂（62 题，打分为 reward≥1，缺失记 unknown 不入主指标）**

| 臂 | 有分 | 通过 | 通过率 | 模型花费 | unknown（排除） |
|---|---|---|---|---|---|
| native-pi | 60 | 37 | 61.7% | $2.56 | 2：`pytorch-model-recovery`（VerifierTimeout）、`batched-eval-parity`（RuntimeError） |
| dev-agent | 61 | 30 | 49.2% | $2.41 | 1：`batched-eval-parity` |
| rotom-fork | 58 | 36 | 62.1% | $2.29 | 4：`batched-eval-parity`、3 题仍被限流 |

**逐题配对（62 题 bootstrap，10,000 次重采样）**

| 对比 | 配对题数 | 差值 | 95% 区间 | 赢/输 |
|---|---|---|---|---|
| rotom-fork − native-pi（主对比） | 57 | +0.0pp | [−8.8, +8.8] | 3 / 3 |
| dev-agent − native-pi | 60 | −11.7pp | [−21.7, −1.7] | 2 / 9 |
| rotom-fork − dev-agent | 58 | +10.3pp | [+0.0, +20.7] | 8 / 2 |

**限流事故**：18:53 UTC 起网关对 `deepseek-v4.1-flash` 返回 429 `Allocated quota exceeded`。rotom-fork 臂 62 次里 28 次命中，dev-agent 2 次，native-pi 0 次。未修复前的读数会说“fork 比 native 低 28.3pp”，这是限流造成的假象，不能用。补跑这 30 次（并发降到 2–3）后有 27 次干净、3 次仍限流（`vpp-loss-divergence`、`freecad-impeller`、`tune-mjcf`），保留为 unknown。原始逐题记录见 [CSV](frontier-harness-eval-three-arm-20261122.csv)，`source` 列标出哪一臂用的是补跑（`a1b`）。

**结论**：第一轮看不出 Pi fork 改变通过率（+0.0pp，区间含 0、宽约 ±9pp）；rotom 的扩展和策略叠加在公开 Pi 上反而低 11.7pp，区间不含 0，代价主要是 agent 超时翻倍（10 对 5）。这两个结论都只是一轮、一个模型、62 题的结果，`rotom-fork − dev-agent` 的区间下界正好压在 0 上。

**没做到或没验证**：`k/4` 主指标（需要 4 轮）、`pass@4`、`pass^4`（同前）、步数统计（`result.json` 未填 `step_results`，本轮未改用 trajectory 统计）、Runta 沙箱条件、以及不限流条件下的完整一轮（仍是每臂一次，有 3 题缺 fork 数据）。
