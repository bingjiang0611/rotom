# FrontierHarness Eval 62 题 × 4 次 attempt 的逐题明细

`gpt-6-luna` / thinking `max` / `openai-responses`，Runta 沙箱，4 vCPU / 8 GB，并发 4–6。
数据来自 `rotom/evals/.eval/benchmarks/{fh62-gpt6luna-max,fh62-fixups,fh62-attempts234}`，本文件与同名 CSV 由这些 trial 的 `result.json` / `trajectory.json` / `verifier/reward.txt` 汇总。

| 指标 | 值 |
|---|---|
| trials | 248（62 × 4） |
| Harbor 判了分 | 243 |
| 通过 | 141 |
| 池化通过率（有分数） | 58.0% |
| 严格口径（异常计 0） | 56.9% |
| 只看没有异常的 trial | 139/224 = 62.1% |
| pass@4（至少过 1 次） | 42/62 = 67.7% |
| pass^4（4 次全过） | 30/62 = 48.4% |
| 成本 | $11.75 |

两次 attempt 有两个 trial 被 Harbor 记为异常、但 verifier 仍判 1 分（`polyglot-c-py`、`sqlite-with-gcov`）。表里按「Harbor 判了分就计」处理，所以池化口径是 141/243；把异常一律算 0 就是最严的 56.9%。

A1–A4 四次尝试：`1` 通过、`0` 判 0、`异常` 是 trial 级异常。A1 一律是第一次 run 的原始结果；`fh62-spec8c16g`（8 vCPU/16 GB 规格复跑）与 `fh62-cufix-verify`（崩溃修复后复跑）不计入这四次，所以 `rstan-to-pystan` 的 A1 是超时、`mteb-leaderboard` 的 A1 是崩溃，而运行报告「结果」表里记的是补跑后能通过。

## 每题预算与实测耗时

每题预算来自数据集 `task.toml` 的 `[agent] timeout_sec`，不是我们设的。撞满预算（`AgentTimeoutError`）的 12 次分布在 8 题上。

| 预算 | 题数 | 其中撞满预算的题 |
|---|---|---|
| 900s | 26 | 6 |
| 1200s | 3 | 0 |
| 1800s | 7 | 1 |
| 2400s | 1 | 0 |
| 3600s | 7 | 1 |
| 7200s | 1 | 0 |
| 28800s | 17 | 0 |

**撞满预算的 8 题**：

| 题目 | 预算 | 超时/尝试 | 通过/有分 | 当时在做什么 | 加预算是否有用 |
|---|---|---|---|---|---|
| make-doom-for-mips | 900s | 4/4 | 0/4 | 4/4 超时，34–41 步、2.7–3.3M prompt token，持续在改代码 | 大概率有用：任务量本身超 900s |
| rstan-to-pystan | 1800s | 2/4 | 2/4 | 1800s，其中一次单条 bash 跑 1201s（rstan 编译） | 已证实用：8 vCPU/16 GB 下通过 |
| adaptive-rejection-sampler | 900s | 1/4 | 2/4 | 900s，第 3 步一条 `apt-get install -y`（R 包）吃掉约 14 分钟 | 有用：预算都花在装包 |
| chess-best-move | 900s | 1/4 | 1/4 | 900s，8 次调用；已解包并运行 stockfish，最后卡在 UCI 管道 | 未必：更像 agent 没让交互进程退出 |
| gcode-to-text | 900s | 1/4 | 1/4 | 900s，24 次调用，读 PNG 裁剪图 + Python 解析 | 可能有用 |
| polyglot-c-py | 900s | 1/4 | 3/4 | 900s，最后一次是 gcc 编译后立即超时；同题另两次通过 | 低优先：A2/A3 已通过 |
| pytorch-model-cli | 900s | 1/4 | 2/4 | 900s，15 步，末段在 grep/read 源码 | 低优先：同题 2/4 已通过 |
| video-processing | 3600s | 1/4 | 0/4 | 3600s 用完，46 次工具调用主要在跑 Python 分析 | 可能有用：需实测单步耗时 |

**没超时但已贴着预算的题**（余量薄，重跑时更可能翻成超时）：

| 题目 | 预算 | 最长耗时 | 占比 | 通过/有分 |
|---|---|---|---|---|
| path-tracing-reverse | 1800s | 1642s | 91% | 4/4 |
| filter-js-from-html | 1800s | 1475s | 82% | 0/3 |
| feal-linear-cryptanalysis | 1800s | 1235s | 69% | 4/4 |
| install-windows-3.11 | 3600s | 2440s | 68% | 2/4 |

## 建议的重跑方案

按上面证据，用 `--timeout-multiplier 2` 只重跑 6 题（make-doom-for-mips、video-processing、gcode-to-text、adaptive-rejection-sampler、polyglot-c-py、pytorch-model-cli），每题 2 次，共 12 trials，成本估 **$0.9**，墙上时间约 1.5–2 小时。

`chess-best-move` 不建议靠加预算解决：它已经拿到 stockfish，卡在 UCI 交互进程没退出，属于 agent 自己的问题。`rstan-to-pystan` 已证明是规格问题，不必再跑。

`path-tracing-reverse`（91%）和 `filter-js-from-html`（82%）没超时但余量很薄；如果加大并发让沙箱变慢，这两题会先翻成超时。

## 逐题 4 次明细

| 题目 | 预算 | A1 | A2 | A3 | A4 | 通过/有分 | 成本 $ | 步数 |
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
| gsea-proteomics | 28800s | 0 | 异常 | 0 | 0 | 0/4 | 0.228 | 129 |
| hf-model-inference | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 52 |
| html-js-filter | 28800s | 0 | 超时 | 0 | 0 | 0/3 | 0.363 | 152 |
| install-windows-3.11 | 1 | 异常 | 1 | 0 | 2/4 | 0.308 | 165 |
| intrastat-meldung | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.812 | 239 |
| kv-store-grpc | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.029 | 52 |
| large-scale-text-editing | 1200s | 1 | 1 | 1 | 1 | 4/4 | 0.038 | 51 |
| log-summary-date-ranges | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.030 | 34 |
| mailman | 1800s | 1 | 1 | 1 | 1 | 4/4 | 0.330 | 159 |
| make-doom-for-mips | 900s | 超时 | 超时 | 超时 | 超时 | 0/4 | 0.391 | 149 |
| merge-diff-arc-agi-task | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.068 | 88 |
| model-extraction-relu-logits | 900s | 1 | 1 | 0 | 0 | 2/4 | 0.125 | 47 |
| mteb-leaderboard | 3600s | 异常 | 0 | 1 | 0 | 1/4 | 0.433 | 255 |
| music-harmony | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.427 | 175 |
| mvcc-lsm-compaction | 28800s | 异常 | 超时 | 1 | 0 | 1/2 | 0.076 | 57 |
| nginx-request-logging | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 60 |
| ontology-kg-querying | 28800s | 0 | 异常 | 0 | 0 | 0/4 | 0.777 | 216 |
| openssl-selfsigned-cert | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.040 | 35 |
| path-tracing-reverse | 1800s | 1 | 1 | 1 | 1 | 4/4 | 0.507 | 162 |
| polyglot-c-py | 900s | 1 | 1 | 0 | 超时 | 3/4 | 0.077 | 52 |
| polyglot-rust-c | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.074 | 45 |
| portfolio-optimization | 3600s | 1 | 1 | 1 | 1 | 4/4 | 0.082 | 88 |
| prove-plus-comm | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.017 | 34 |
| pypi-server | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.060 | 69 |
| pytorch-model-cli | 900s | 1 | 1 | 超时 | 0 | 2/4 | 0.102 | 74 |
| pytorch-model-recovery | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.054 | 36 |
| regex-log | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.048 | 37 |
| roy-polymorph-cn | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.064 | 46 |
| rstan-to-pystan | 1800s | 超时 | 1 | 超时 | 1 | 2/4 | 0.104 | 100 |
| sam-cell-seg | 7200s | 1 | 1 | 1 | 1 | 4/4 | 0.139 | 47 |
| schemelike-metacircular-eval | 2400s | 1 | 1 | 1 | 1 | 4/4 | 0.179 | 90 |
| session-window-debug | 28800s | 0 | 1 | 0 | 0 | 1/4 | 0.277 | 98 |
| sparql-university | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.046 | 48 |
| sqlite-db-truncate | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.043 | 39 |
| sqlite-with-gcov | 900s | 1 | 异常 | 1 | 1 | 4/4 | 0.094 | 92 |
| tune-mjcf | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.064 | 74 |
| video-processing | 3600s | 超时 | 0 | 0 | 0 | 0/4 | 0.193 | 126 |
| vpp-loss-divergence | 28800s | 0 | 异常 | 异常 | 0 | 0/4 | 0.515 | 261 |
| vulnerable-secret | 900s | 1 | 1 | 1 | 1 | 4/4 | 0.023 | 36 |
| wal-recovery-ordering | 28800s | 0 | 0 | 0 | 0 | 0/4 | 0.239 | 93 |
