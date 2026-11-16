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

| 题目 | A1 | A2 | A3 | A4 | 通过/有分 | 成本 $ | 步数 |
|---|---|---|---|---|---|---|---|
| adaptive-rejection-sampler | 1 | 0 | 1 | 超时 | 2/4 | 0.193 | 68 |
| batched-eval-parity | 0 | 0 | 0 | 0 | 0/4 | 0.528 | 192 |
| bun-sourcemap-leak | 0 | 0 | 0 | 0 | 0/4 | 0.244 | 149 |
| caffe-cifar-10 | 1 | 1 | 1 | 1 | 4/4 | 0.226 | 184 |
| cancel-async-tasks | 1 | 1 | 1 | 1 | 4/4 | 0.026 | 32 |
| cargo-flight-dispatch | 0 | 0 | 0 | 0 | 0/4 | 0.295 | 107 |
| chess-best-move | 0 | 1 | 0 | 超时 | 1/4 | 0.057 | 38 |
| circuit-fibsqrt | 1 | 1 | 1 | 1 | 4/4 | 0.196 | 57 |
| code-from-image | 1 | 超时 | 1 | 1 | 3/3 | 0.008 | 18 |
| constraints-scheduling | 1 | 1 | 1 | 1 | 4/4 | 0.034 | 33 |
| dna-assembly | 0 | 0 | 0 | 0 | 0/4 | 0.272 | 122 |
| dna-insert | 0 | 0 | 0 | 0 | 0/4 | 0.091 | 84 |
| embedding-drift-monitor | 0 | 0 | 0 | 0 | 0/4 | 0.359 | 175 |
| feal-linear-cryptanalysis | 1 | 1 | 1 | 1 | 4/4 | 0.260 | 102 |
| filter-js-from-html | 0 | 0 | 异常 | 0 | 0/3 | 0.318 | 133 |
| fix-code-vulnerability | 1 | 1 | 1 | 1 | 4/4 | 0.037 | 43 |
| fix-git | 1 | 1 | 1 | 1 | 4/4 | 0.049 | 64 |
| fix-ocaml-gc | 1 | 1 | 1 | 1 | 4/4 | 0.158 | 132 |
| foodstuff-beta-activity | 0 | 0 | 0 | 0 | 0/4 | 0.309 | 88 |
| freecad-impeller | 0 | 0 | 0 | 0 | 0/4 | 0.184 | 125 |
| gcode-to-text | 超时 | 0 | 0 | 1 | 1/4 | 0.147 | 91 |
| glycan-ms2-elucidation | 0 | 0 | 0 | 0 | 0/4 | 0.185 | 60 |
| gsea-proteomics | 0 | 异常 | 0 | 0 | 0/4 | 0.228 | 129 |
| hf-model-inference | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 52 |
| html-js-filter | 0 | 超时 | 0 | 0 | 0/3 | 0.363 | 152 |
| install-windows-3.11 | 1 | 异常 | 1 | 0 | 2/4 | 0.308 | 165 |
| intrastat-meldung | 0 | 0 | 0 | 0 | 0/4 | 0.812 | 239 |
| kv-store-grpc | 1 | 1 | 1 | 1 | 4/4 | 0.029 | 52 |
| large-scale-text-editing | 1 | 1 | 1 | 1 | 4/4 | 0.038 | 51 |
| log-summary-date-ranges | 1 | 1 | 1 | 1 | 4/4 | 0.030 | 34 |
| mailman | 1 | 1 | 1 | 1 | 4/4 | 0.330 | 159 |
| make-doom-for-mips | 超时 | 超时 | 超时 | 超时 | 0/4 | 0.391 | 149 |
| merge-diff-arc-agi-task | 1 | 1 | 1 | 1 | 4/4 | 0.068 | 88 |
| model-extraction-relu-logits | 1 | 1 | 0 | 0 | 2/4 | 0.125 | 47 |
| mteb-leaderboard | 异常 | 0 | 1 | 0 | 1/4 | 0.433 | 255 |
| music-harmony | 0 | 0 | 0 | 0 | 0/4 | 0.427 | 175 |
| mvcc-lsm-compaction | 异常 | 超时 | 1 | 0 | 1/2 | 0.076 | 57 |
| nginx-request-logging | 1 | 1 | 1 | 1 | 4/4 | 0.047 | 60 |
| ontology-kg-querying | 0 | 异常 | 0 | 0 | 0/4 | 0.777 | 216 |
| openssl-selfsigned-cert | 1 | 1 | 1 | 1 | 4/4 | 0.040 | 35 |
| path-tracing-reverse | 1 | 1 | 1 | 1 | 4/4 | 0.507 | 162 |
| polyglot-c-py | 1 | 1 | 0 | 超时 | 3/4 | 0.077 | 52 |
| polyglot-rust-c | 1 | 1 | 1 | 1 | 4/4 | 0.074 | 45 |
| portfolio-optimization | 1 | 1 | 1 | 1 | 4/4 | 0.082 | 88 |
| prove-plus-comm | 1 | 1 | 1 | 1 | 4/4 | 0.017 | 34 |
| pypi-server | 1 | 1 | 1 | 1 | 4/4 | 0.060 | 69 |
| pytorch-model-cli | 1 | 1 | 超时 | 0 | 2/4 | 0.102 | 74 |
| pytorch-model-recovery | 1 | 1 | 1 | 1 | 4/4 | 0.054 | 36 |
| regex-log | 1 | 1 | 1 | 1 | 4/4 | 0.048 | 37 |
| roy-polymorph-cn | 0 | 0 | 0 | 0 | 0/4 | 0.064 | 46 |
| rstan-to-pystan | 超时 | 1 | 超时 | 1 | 2/4 | 0.104 | 100 |
| sam-cell-seg | 1 | 1 | 1 | 1 | 4/4 | 0.139 | 47 |
| schemelike-metacircular-eval | 1 | 1 | 1 | 1 | 4/4 | 0.179 | 90 |
| session-window-debug | 0 | 1 | 0 | 0 | 1/4 | 0.277 | 98 |
| sparql-university | 1 | 1 | 1 | 1 | 4/4 | 0.046 | 48 |
| sqlite-db-truncate | 1 | 1 | 1 | 1 | 4/4 | 0.043 | 39 |
| sqlite-with-gcov | 1 | 异常 | 1 | 1 | 4/4 | 0.094 | 92 |
| tune-mjcf | 1 | 1 | 1 | 1 | 4/4 | 0.064 | 74 |
| video-processing | 超时 | 0 | 0 | 0 | 0/4 | 0.193 | 126 |
| vpp-loss-divergence | 0 | 异常 | 异常 | 0 | 0/4 | 0.515 | 261 |
| vulnerable-secret | 1 | 1 | 1 | 1 | 4/4 | 0.023 | 36 |
| wal-recovery-ordering | 0 | 0 | 0 | 0 | 0/4 | 0.239 | 93 |
