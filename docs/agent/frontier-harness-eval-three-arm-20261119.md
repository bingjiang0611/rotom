预注册于 2026-11-19，实验运行中，结果待补。

# FrontierHarness Eval：Pi 来源三臂对比

预注册依据：[L-2026-11-19-three-arm-pi-source-ab](../../rotom/evals/loop/ledger/2026-11-three-arm-pi-source.json)。此前 dev-agent 通过 `ROTOM_PI` 使用公开 Pi 1.4.0，成绩不能证明发行版 Pi fork 的效果。本设计区分扩展／策略和 Pi fork 的贡献，并检查 62 个任务能否把差异与噪声分开。

- **三臂**：native-pi、dev-agent、rotom-fork。后两臂用相同 bundle，只换 Pi binary；rotom-fork 的每次 trial 记录 `agent/pi-runtime.json` 证明实际加载的 runtime。
- **条件与顺序**：固定 FrontierHarness Eval 62 题（此前使用的摘要 `sha256:9236400f`）、`custom/bailian/deepseek-v4.1-flash`、thinking max、固定并发。Runta：4 vCPU，内存 8192 MiB，磁盘 32768 MiB。先选 3 个快任务对三臂冒烟，再估算成本和耗时。正式计划 62 × 3 × 4 = 744 次；三臂均完成同一轮才开始下一轮，平衡时段与负载。
- **主要指标**：每题每臂四次的通过率（k/4），比较 rotom-fork 与 native-pi 的逐题配对差；按 62 题 bootstrap 取 95% 区间，仅当区间不含 0 才判有差异。dev-agent 与 native-pi 的差用于拆分扩展／策略贡献，不是主结论。
- **次要指标**：各臂的 pass@4、pass^4、成本、步数、agent 超时数。ExecutionError、EnvironmentStartTimeoutError、ApiError 作为基础设施 unknown，按臂单列，不进主指标；AgentTimeoutError 计失败，使用各题 `task.toml` 的预算。
- **外推限制**：结论只适用于这个模型和题集；没有 Kimi K3 臂，不是排行榜比较。

**进度核对（2026-11-20）**：本机核实到预注册记录；在所查本地工作区、评测产物目录与会话索引中，未核实三臂冒烟或正式 trial 的完成数。不将计划次数当成实跑次数，也不据此推断远端进度。
