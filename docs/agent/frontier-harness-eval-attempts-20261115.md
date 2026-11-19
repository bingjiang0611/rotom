# FrontierHarness Eval 62 题 × 4 次 attempt 的逐题明细

`gpt-6-luna` / thinking `max` / `openai-responses`，Runta 沙箱，4 vCPU / 8 GB，并发 4–6。
dev-agent 臂当时跑在上游公开 Pi 1.4.0 上（经 `ROTOM_PI` shim 指向已安装的上游 `pi`），没有加载 rotom 的 fork，所以这些数字不代表发布版 rotom。
数据来自 `rotom/evals/.eval/benchmarks/{fh62-gpt6luna-max,fh62-attempts234,fh62-fixups,fh62-spec8c16g,fh62-cufix-verify}`；本文件与两个 CSV 由这些 trial 的 `result.json` / `trajectory.json` / `verifier/reward.txt` 汇总：`...-attempts-20261115.csv`（248 个 attempt，`attempt` 1 为首轮、2–4 为第二轮）、`...-reruns-20261115.csv`（8 个补跑）。

| 指标 | 值 |
|---|---|
| 四次 attempt 的 trials | 248（62 × 4） |
| 通过 | 139 |
| 判 0（含 `AgentTimeoutError`） | 98 |
| 基础设施 unknown（Runta/环境异常、无 verifier 分数） | 11 |
| 严格口径（unknown 计 0，全部 248） | 56.0% |
| 排除 unknown（237 个有效） | 58.6% |
| **首轮 62 题（无补跑）** | **35/62 = 56.5%** |
| pass@4（四次至少过一次） | 42/62 = 67.7% |
| pass^4（四次全过） | 28/62 = 45.2% |
| 四次合计成本 | $11.73（不含补跑） |

表内 248 个 trial 不含补跑；8 个补跑在 `...-reruns-20261115.csv` 里，带 `run` 与 `reason` 列。

A1–A4 四次 attempt：`1` 通过、`0` 判 0、`异常` 是 trial 级异常。**A1 一律是首轮（`fh62-gpt6luna-max`）的原始结果，不用补跑替换**。
首轮 7 个异常里，`pytorch-model-recovery` 是 `-` 开头指令让 agent 根本没启动、`mteb-leaderboard` 是 `launch_browser` 崩溃；两者后来补跑过，补跑结果单独列出，不进 A1。
补跑 CSV 里 `pytorch-model-recovery` / `mteb-leaderboard` / `mvcc-lsm-compaction` 的 `started_at` 同为 `2026-11-15T21:48:55`，说明它们是同一批 `fh62-fixups` 补跑。

## 补跑（不计入四次 attempt）

| 题目 | 轮次 | 原因 | 结果 |
|---|---|---|---|
| gcode-to-text | fh62-spec8c16g | 规格复跑 8 vCPU/16 GB | 判 0 |
| make-doom-for-mips | fh62-spec8c16g | 规格复跑 8 vCPU/16 GB | 异常 ExecutionError |
| mteb-leaderboard | fh62-cufix-verify | 崩溃修复后复跑 | 判 0 |
| mteb-leaderboard | fh62-fixups | 首轮修复后复跑 | 判 0 |
| mvcc-lsm-compaction | fh62-fixups | 首轮修复后复跑 | 异常 ExecutionError |
| pytorch-model-recovery | fh62-fixups | 首轮修复后复跑 | 通过 |
| rstan-to-pystan | fh62-spec8c16g | 规格复跑 8 vCPU/16 GB | 通过 |
| video-processing | fh62-spec8c16g | 规格复跑 8 vCPU/16 GB | 判 0 |

## 每题预算与实测耗时

每题预算来自数据集 `task.toml` 的 `[agent] timeout_sec`，不是我们设的。

| 预算 | 题数 | 其中撞满预算的题 |
|---|---|---|
| 900s | 26 | 6 |
| 1200s | 3 | 0 |
| 1800s | 7 | 1 |
| 2400s | 1 | 0 |
| 3600s | 7 | 1 |
| 7200s | 1 | 0 |
| 28800s | 17 | 0 |

**撞满预算的题**（12 次超时，8 题）：

| 题目 | 预算 | 超时/4 | 通过/有效 | 当时在做什么 |
|---|---|---|---|---|
| make-doom-for-mips | 900s | 4/4 | 0/4 | 34–41 步、2.7–3.3M prompt token，持续在改代码 |
| rstan-to-pystan | 1800s | 2/4 | 2/4 | 一次单条 bash 跑 1201s（rstan 编译） |
| adaptive-rejection-sampler | 900s | 1/4 | 2/4 | 一条 `apt-get install -y`（R 包）吃掉约 14 分钟 |
| chess-best-move | 900s | 1/4 | 1/4 | 8 次调用；解包并运行 stockfish，最后卡在 UCI 管道 |
| gcode-to-text | 900s | 1/4 | 1/4 | 24 次调用，读 PNG 裁剪图 + Python 解析 |
| polyglot-c-py | 900s | 1/4 | 3/4 | 最后是 gcc 编译后立即超时；同题另两次通过 |
| pytorch-model-cli | 900s | 1/4 | 2/4 | 15 步，末段在 grep/read 源码 |
| video-processing | 3600s | 1/4 | 0/4 | 46 次工具调用，主要在跑 Python 分析 |

**没超时但已贴着预算的题**：

| 题目 | 预算 | 最长耗时 | 占比 | 通过/有效 |
|---|---|---|---|---|
| path-tracing-reverse | 1800s | 1642s | 91% | 4/4 |
| filter-js-from-html | 1800s | 1475s | 82% | 0/3 |
| feal-linear-cryptanalysis | 1800s | 1235s | 69% | 4/4 |
| install-windows-3.11 | 3600s | 2440s | 68% | 2/3 |

## 逐题 4 次明细

| 题目 | 预算 | A1 | A2 | A3 | A4 | 通过/有效 | 成本 $ | 步数 |
|---|---|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | 900s | 1 | 0 | 1 | 超时 | 2/4 | 0.193 | 68 |
| batched-eval-parity | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.528 | 192 |
| bun-sourcemap-leak | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.244 | 149 |
| caffe-cifar-10 | 3600s | 1 | 1 | 1 | 1 | 4/4 | 0.226 | 184 |
| cancel-async-tasks | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.026 | 32 |
| cargo-flight-dispatch | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.295 | 107 |
| chess-best-move | 900s | 0 | 1 | 0 | 超时 | 1/4 | 0.057 | 38 |
| circuit-fibsqrt | 3600s | 1 | 1 | 1 | 1 | 4/4 | 0.196 | 57 |
| code-from-image | 1200s | 1 | 超时 | 1 | 1 | 3/3 | 0.008 | 18 |
| constraints-scheduling | 1200s | 1 | 1 | 1 | 1 | 4/4 | 0.034 | 33 |
| dna-assembly | 1800s | 0 | 0 | 0 | 0 | 0/4 | 0.272 | 122 |
| dna-insert | 1800s | 0 | 0 | 0 | 0 | 0/4 | 0.091 | 84 |
| embedding-drift-monitor | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.359 | 175 |
| feal-linear-cryptanalysis | 1800s | 1 | 1 | 1 | 1 | 4/4 | 0.260 | 102 |
| filter-js-from-html | 1800s | 0 | 0 | 异常 | 0 | 0/3 | 0.318 | 133 |
| fix-code-vulnerability | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.037 | 43 |
| fix-git | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.049 | 64 |
| fix-ocaml-gc | 3600s | 1 | 1 | 1 | 1 | 4/4 | 0.158 | 132 |
| foodstuff-beta-activity | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.309 | 88 |
| freecad-impeller | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.184 | 125 |
| gcode-to-text | 900s | 超时 | 0 | 0 | 1 | 1/4 | 0.147 | 91 |
| glycan-ms2-elucidation | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.185 | 60 |
| gsea-proteomics | 28800s | 0 | 异常 | 0 | 0 | 0/3 | 0.228 | 129 |
| hf-model-inference | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 52 |
| html-js-filter | 28800s | 0 | 超时 | 0 | 0 | 0/3 | 0.363 | 152 |
| install-windows-3.11 | 3600s | 1 | 异常 | 1 | 0 | 2/3 | 0.308 | 165 |
| intrastat-meldung | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.812 | 239 |
| kv-store-grpc | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.029 | 52 |
| large-scale-text-editing | 1200s | 1 | 1 | 1 | 1 | 4/4 | 0.038 | 51 |
| log-summary-date-ranges | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.030 | 34 |
| mailman | 1800s | 1 | 1 | 1 | 1 | 4/4 | 0.330 | 159 |
| make-doom-for-mips | 900s | 超时 | 超时 | 超时 | 超时 | 0/4 | 0.391 | 149 |
| merge-diff-arc-agi-task | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.068 | 88 |
| model-extraction-relu-logits | 900s | 1 | 1 | 0 | 0 | 2/4 | 0.125 | 47 |
| mteb-leaderboard | 3600s | 异常 | 0 | 1 | 0 | 1/4 | 0.433 | 257 |
| music-harmony | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.427 | 175 |
| mvcc-lsm-compaction | 28800s | 超时 | 超时 | 1 | 0 | 1/2 | 0.065 | 56 |
| nginx-request-logging | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 60 |
| ontology-kg-querying | 28800s | 0 | 异常 | 0 | 0 | 0/3 | 0.777 | 216 |
| openssl-selfsigned-cert | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.040 | 35 |
| path-tracing-reverse | 1800s | 1 | 1 | 1 | 1 | 4/4 | 0.507 | 162 |
| polyglot-c-py | 900s | 1 | 1 | 0 | 超时 | 3/4 | 0.077 | 52 |
| polyglot-rust-c | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.074 | 45 |
| portfolio-optimization | 3600s | 1 | 1 | 1 | 1 | 4/4 | 0.082 | 88 |
| prove-plus-comm | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.017 | 34 |
| pypi-server | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.060 | 69 |
| pytorch-model-cli | 900s | 1 | 1 | 超时 | 0 | 2/4 | 0.102 | 74 |
| pytorch-model-recovery | 900s | 异常 | 1 | 1 | 1 | 3/4 | 0.043 | 28 |
| regex-log | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.048 | 37 |
| roy-polymorph-cn | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.064 | 46 |
| rstan-to-pystan | 1800s | 超时 | 1 | 超时 | 1 | 2/4 | 0.104 | 100 |
| sam-cell-seg | 7200s | 1 | 1 | 1 | 1 | 4/4 | 0.139 | 47 |
| schemelike-metacircular-eval | 2400s | 1 | 1 | 1 | 1 | 4/4 | 0.179 | 90 |
| session-window-debug | 28800s | 0 | 1 | 0 | 0 | 1/4 | 0.277 | 98 |
| sparql-university | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.046 | 48 |
| sqlite-db-truncate | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.043 | 39 |
| sqlite-with-gcov | 900s | 1 | 异常 | 1 | 1 | 3/3 | 0.094 | 92 |
| tune-mjcf | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.064 | 74 |
| video-processing | 3600s | 超时 | 0 | 0 | 0 | 0/4 | 0.193 | 126 |
| vpp-loss-divergence | 28800s | 0 | 异常 | 异常 | 0 | 0/2 | 0.515 | 261 |
| vulnerable-secret | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.023 | 36 |
| wal-recovery-ordering | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.239 | 93 |
