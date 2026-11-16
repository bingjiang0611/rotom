# FrontierHarness Eval 62 题自跑（gpt-6-luna / max）

日期：2026-11-15。这是**我们自己的 runner 在 FrontierHarness 的题集上自跑**，不是他们榜上的成绩。

## 结论

- **37/62 = 59.7%**（严格口径：异常按 0 计，含两次补跑）。只看 verifier 正常出分的 58 题是 **63.8%**。
- 成本 **$2.9443**（$0.048/题），壁钟 4 小时 56 分（08:36–13:32，并发 4），加两轮共约 1 小时补跑。
- 与榜上 `Pi` 行（同 62 题，Kimi K3，57.7%）**量级一致**，但模型不同、attempts 不同，**不能当成同配置对照**，也不能据此说 rotom 与 Pi 谁强。
- 这次跑出 3 个真实发现：Harbor 的 positional prompt bug（已修，补跑 `reward=1` 验证）、`launch_browser` 在沙箱里崩掉整个进程（已修，沙箱复跑验证）、4 个 1200s 超时（8 vCPU/16 GB 复跑后 1 题翻成通过，2 题变成真实失败，1 题 Runta 执行状态 unknown）。

## 补跑与修正（同一天）

| 题目 | 原结果 | 补跑条件 | 补跑结果 |
|---|---|---|---|
| pytorch-model-recovery | 异常（`-` 指令被当选项） | 修 `prompt_argument` 后重跑 | **1** |
| mteb-leaderboard | 异常（`launch_browser` EPIPE 崩进程） | 修 Linux helper 流错误后重跑 | 0（正常判分，不再崩） |
| mvcc-lsm-compaction | 异常（verifier 崩） | verifier 超时 ×2 | 仍异常（EOFError/ExecutionError） |
| gcode-to-text | 异常（1200s 超时） | 8 vCPU/16 GB，超时 ×2 | 0（真实失败） |
| make-doom-for-mips | 异常（1200s 超时） | 同上 | 仍异常（Runta `ExecutionError`，执行状态 unknown） |
| rstan-to-pystan | 异常（1200s 超时） | 同上 | **1**（**超时属规格不足**） |
| video-processing | 异常（1200s 超时） | 同上 | 0（真实失败） |

因此 4 个超时里有 1 个确认是规格问题、2 个在更大规格下变成真实失败、1 个落到 Runta 侧 unknown。

## 固定条件

| 项 | 值 |
|---|---|
| 题集 | `frontier-harness-eval/frontier-harness-eval@sha256:9236400f…`（62 题；`@latest` 与它内容逐字节相同） |
| 臂 | dev-agent（rotom 产品 bundle） |
| 模型 | `openai/gpt-6-luna`，thinking **max**，`openai-responses` |
| 环境 | Harbor 0.26 + Runta，4 vCPU / 8192 MiB / 32768 MiB 磁盘，并发 4 |
| 次数 | 每题 1 attempt（他们发榜用 4 attempts、取 first valid attempt） |
| 结果目录 | `rotom/evals/.eval/benchmarks/fh62-gpt6luna-max`、`fh62-fixups`（私有，不入库） |

## 结果

通过 36：adaptive-rejection-sampler、caffe-cifar-10、cancel-async-tasks、circuit-fibsqrt、code-from-image、constraints-scheduling、feal-linear-cryptanalysis、fix-code-vulnerability、fix-git、fix-ocaml-gc、hf-model-inference、install-windows-3.11、kv-store-grpc、large-scale-text-editing、log-summary-date-ranges、mailman、merge-diff-arc-agi-task、model-extraction-relu-logits、nginx-request-logging、openssl-selfsigned-cert、path-tracing-reverse、polyglot-c-py、polyglot-rust-c、portfolio-optimization、prove-plus-comm、pypi-server、pytorch-model-cli、pytorch-model-recovery、regex-log、sam-cell-seg、schemelike-metacircular-eval、sparql-university、sqlite-db-truncate、sqlite-with-gcov、tune-mjcf、vulnerable-secret

失败 20（verifier 正常判 0）：batched-eval-parity、bun-sourcemap-leak、cargo-flight-dispatch、chess-best-move、dna-assembly、dna-insert、embedding-drift-monitor、filter-js-from-html、foodstuff-beta-activity、freecad-impeller、glycan-ms2-elucidation、gsea-proteomics、html-js-filter、intrastat-meldung、music-harmony、ontology-kg-querying、roy-polymorph-cn、session-window-debug、vpp-loss-divergence、wal-recovery-ordering

异常 6（严格口径计 0）：gcode-to-text、make-doom-for-mips、rstan-to-pystan、video-processing（AgentTimeoutError 1200s）、mvcc-lsm-compaction（verifier 崩，EOFError/ExecutionError）、mteb-leaderboard（`launch_browser` 崩溃）

## 三个发现

### 1. Harbor 把指令当裸 positional，`-` 开头的题目直接崩（已修）

`pytorch-model-recovery` 的指令以 `- You are given a PyTorch …` 开头。Harbor 的 Pi agent 把
`shlex.quote(instruction)` 直接拼在 `pi --print …` 后面、没有 `--` 终止符，于是 Pi 的参数解析把它当未知选项：

```
Error: Unknown option: - You are given a PyTorch state dictionary …
```

模型一次都没被调用，trial 直接异常。修法在 `benchmark_adapters/dev_agent_pi.py`：两条臂共用
`prompt_argument()`，指令以 `-` 开头时前面补一个空格（对模型无意义，文本不变）。补跑该题
reward 由异常变 **1**，证明是唯一原因。上游 Harbor 本身仍有这个问题。

### 2. 沙箱里 `launch_browser` 会把整个进程搞崩（已修）

`mteb-leaderboard` 需要查 HuggingFace 的 MTEB 榜，模型调了 `launch_browser`：

```
{"type":"tool_execution_start","toolName":"launch_browser","args":{"url":"https://huggingface.co/spaces/mteb/leaderboard"}}
node:events:505 throw er; // Unhandled 'error' event
Error: write EPIPE   (errno -32, socket write)
```

两次尝试都以 `EPIPE` 崩溃收场。根因在 `packages/rotom-computer-use/src/platform/linux/helper.ts`：
Linux helper 客户端往子进程 stdin 写命令时没有给 child 的 stdin/stdout/stderr 挂 `error` 监听，
bridge 起不来时 `write` 抛出的 EPIPE 成为未捕获事件，直接打死 Pi 进程。

本分支已修并打包为 `0.5.1-rotom.11`：只改 `src/platform/linux/helper.ts`，`.rotom.10` 的 8 个 native prebuilt
逐字节沿用，归档内容与 `.rotom.10` 的差别仅此文件与版本号。三个组件测试覆盖，撤掉监听后同一测试复现生产的
`Error: write EPIPE`。沙箱复跑同一题（当时用的是实验期打出的 `.rotom.4`）：`launch_browser` 返回
`isError=true, "write EPIPE"`，无未捕获事件，trial 继续用 bash 干活并正常判 0。

注意这条修复落在实验之后：上面 248 个 trial 里只有补跑用了修好的 bundle，其余仍用会崩的版本。

任务本身仍然失败：沙箱里没有 Chrome relay，模型也拿不到 MTEB 榜数据。这属于环境限制，不是 agent 能力。

### 3. 1200s 超时 4 题

gcode-to-text、make-doom-for-mips、rstan-to-pystan、video-processing 都在 1200s 触发
`AgentTimeoutError`。他们的规则是「agent 已开始执行后的超时按失败计 0」，所以严格口径里就是对 0。
但我们的 4 vCPU / 8 GB 是否与他们发榜时一致未知，**这些超时有规格归因的嫌疑，未验证**。

## 四次 attempt 的方差（attempts 2–4）

第二轮 62 题 × 3 次 = 186 trials，并发 6，$8.51，19:56 → 04:54，用修好 `launch_browser` 与 `-` 指令之后的 bundle。

| 指标 | 值 |
|---|---|
| 4 次合计 trials | 248（62 × 4） |
| Harbor 判了分 | 243（24 个异常里 19 个仍拿到 verifier 分数，5 个完全没分） |
| 通过 | 141 |
| 池化通过率（有分数） | **58.0%** |
| 严格口径（异常计 0，全部 248） | 56.9% |
| 只看没有异常的 trial | 139/224 = 62.1% |
| pass@4（至少过 1 次） | 42/62 = **67.7%** |
| pass^4（4 次全过） | 30/62 = **48.4%** |

逐题 4 次序列、成本与步数见 [FrontierHarness 62 题 × 4 次明细](frontier-harness-eval-attempts-20261115.md)（同名 CSV 可机读）。`polyglot-c-py` 与 `sqlite-with-gcov` 各有一个 trial 被判异常但 verifier 仍给 1 分，池化口径按「判了分就计」处理；把它们当失败则是最严的 56.9%。

**单次样本会误报具体题目。** 12 题不是四次全过也不是四次全败：

| 题目 | 通过/有分 | 序列（attempt 1–4） |
|---|---|---|
| code-from-image | 3/3 | 1, 异常, 1, 1 |
| polyglot-c-py | 3/4 | 1, 1, 0, 异常 |
| adaptive-rejection-sampler | 2/4 | 1, 0, 1, 异常 |
| install-windows-3.11 | 2/4 | 1, 异常, 1, 0 |
| model-extraction-relu-logits | 2/4 | 1, 1, 0, 0 |
| pytorch-model-cli | 2/4 | 1, 1, 异常, 0 |
| rstan-to-pystan | 2/4 | 异常, 1, 异常, 1 |
| chess-best-move | 1/4 | 0, 1, 0, 异常 |
| gcode-to-text | 1/4 | 异常, 0, 0, 1 |
| mteb-leaderboard | 1/4 | 异常, 0, 1, 0 |
| mvcc-lsm-compaction | 1/2 | 异常, 异常, 1, 0 |
| session-window-debug | 1/4 | 0, 1, 0, 0 |

`mteb-leaderboard` 崩溃修好后有一次真的通过（模型改用 bash 取数），所以它的失败不是产品缺陷。
20 题 4 次全败：batched-eval-parity、bun-sourcemap-leak、cargo-flight-dispatch、dna-assembly、dna-insert、embedding-drift-monitor、filter-js-from-html、foodstuff-beta-activity、freecad-impeller、glycan-ms2-elucidation、gsea-proteomics、html-js-filter、intrastat-meldung、make-doom-for-mips、music-harmony、ontology-kg-querying、roy-polymorph-cn、video-processing、vpp-loss-divergence、wal-recovery-ordering。

第二轮 18 个异常没有一个是产品崩溃：`AgentTimeoutError` 9（make-doom-for-mips 3 次全超时）、`runta.ExecutionError` 6、`EnvironmentStartTimeoutError` 3、`runta.ApiError` 1。

## 排行对比的正确用法

| | 我们 | 榜上 Pi |
|---|---|---|
| 题集 | 同一 62 题（同一 pin） | 同一 62 题 |
| 模型 | gpt-6-luna, max | Kimi K3 |
| attempts | 1 | 4（取 first valid） |
| 环境 | 我们的 Harbor+Runta 4vCPU/8GB，无 egress allowlist / 隔离协议 | 他们自己的 runta + 隔离协议 |
| 通过率 | 59.7%（单次）；4 次池化 58.0%，pass@4 67.7% | 57.7% |
| 成本 | $0.048/题（模型便宜） | $0.563/题 |

数字接近，但模型和协议都不同，只能说明「这个量级下我们的 harness 不掉队」，不能作为排名依据。

## 复现

```sh
cd rotom/evals
. <含 OPENAI_API_KEY 的私有文件>
export RUNTA_CONFIG="$HOME/.config/runta/config.toml"
./bin/benchmark frontier-harness-eval --provider=openai --model=gpt-6-luna --thinking=max \
  --environment=runta --product=/absolute/path/to/rotom --all --n-concurrent=4 \
  -- --override-storage-mb 32768 --override-memory-mb 8192 --override-cpus 4
```

补跑个别题把 `--all` 换成 `--task=terminal-bench/<名字>`（FH 的任务名带来源前缀，与结果目录名不同）。

## 限制

- 4 次 attempt 的方差已跑（见上一节）。但要在榜上同列，仍缺 Kimi K3：模型不同，池化通过率不能直接与他们那一栏比较。
- 单模型 `gpt-6-luna`；换 Kimi K3 才可与榜同列，需要 fireworks 一类 provider 的 key。
- 沙箱规格与他们不保证一致；4 个超时可能由此产生。
- 没有走他们的隔离协议（egress allowlist、secret stub、frozen price table），成本按实际 API 计费。
- 浏览器类任务在本沙箱根本不可用（无 relay），这类题在这个环境测的是失败处理而非能力。
