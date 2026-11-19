# Terminal-Bench 2.1 Runta 两臂 smoke

日期：2026-11-15。操作手册见 [容器隔离与公开基准](../../rotom/evals/docs/benchmarks.md#runta-远端沙箱)。

## 结论

- **链路：PASS。** 两臂各 10 题全部完成产出，0 retry；产品 bundle、agent 安装、verifier 和 Runta 沙箱回收都走通。
- **分数：rotom 7/10，native-pi 5/10。** rotom mean 0.700、$1.588、40 分 35 秒；native-pi mean 0.500（含 1 个 AgentTimeoutError）、$1.296、54 分 30 秒。
- **手臂限制：dev-agent 臂跑在上游公开 Pi 1.4.0 上。** 适配器把全局 `pi` 换成 shim、用 `ROTOM_PI` 指回上游二进制，rotom 只提供扩展与 coding policy，`runtime/pi` 的 fork 没有加载。所以两臂的差异只反映「rotom 扩展 + policy」，**不代表发布版 rotom 的成绩**；fork 臂见后续同条件实验。
- **这不是代表性分数。** 10 题是 `profiles/release-smoke.txt` 的事先选题，单模型（`openai/gpt-5`）、单样本、单后端（Runta），不能和其他榜单数字拼接或对外宣称"优于原生 Pi"。差异只落在 2 题上，样本不足以支持质量结论。
- **一个看起来像 rotom 短板的失败与 rotom 无关。** `configure-git-webserver` 两臂完全相同：2 步、0 次工具调用、直接输出操作步骤。

## 固定条件

| 项 | 值 |
|---|---|
| 数据集 | Terminal-Bench 2.1，固定 commit `d49e28f1`，本地 registry |
| 环境 | Harbor 0.26.0 + `runta` backend，4 vCPU / 8192 MiB / 32768 MiB 磁盘，并发 4 |
| Agent 版本 | 两臂同为 `@earendil-works/pi-coding-agent@1.4.0`（上游公开版）；dev-agent 臂通过 `ROTOM_PI` shim 加载该 worktree 的产品 bundle，未加载 `runtime/pi` 的 fork |
| 模型 | `openai/gpt-5`，thinking 用 Pi 默认（未显式指定） |
| 轮次 | 每题 1 次，`n-attempts=1`，`max-retries=0` |
| 产品源码 | `e2303c77`（含未提交的 evals 适配改动），bundle 368 文件，sha256 `cca07980…` |

## 逐题

| 任务 | rotom | 步数 | 成本 | native-pi | 步数 | 成本 |
|---|---|---:|---:|---|---:|---:|
| build-cython-ext | 1 | 74 | $0.668 | 1 | 54 | $0.496 |
| cancel-async-tasks | **1** | 3 | $0.066 | 0 | 3 | $0.034 |
| configure-git-webserver | 0 | 2 | $0.034 | 0 | 2 | $0.039 |
| custom-memory-heap-crash | 1 | 9 | $0.088 | 1 | 15 | $0.113 |
| db-wal-recovery | 0 | 21 | $0.134 | 0 | 20 | $0.095 |
| fix-code-vulnerability | 1 | 18 | $0.167 | 1 | 13 | $0.127 |
| git-multibranch | 0 | 12 | $0.135 | 0 | 13 | $0.086 |
| large-scale-text-editing | **1** | 10 | $0.085 | 0 (timeout) | 10 | $0.153 |
| polyglot-c-py | 1 | 6 | $0.161 | 1 | 4 | $0.071 |
| query-optimize | 1 | 6 | $0.050 | 1 | 12 | $0.081 |

聚合：rotom 4,619,557 input / 4,329,216 cache / 68,420 output；native-pi 2,629,647 / 2,376,064 / 68,197。
`build-cython-ext` 一题占 rotom 总成本 42%，两臂成本差异主要来自它。

## 唯一的两题差异

- **`cancel-async-tasks`**：rotom 通过、native-pi 失败，两臂都是 3 步。单次样本，不能据此判断这是产品的稳定能力。
- **`large-scale-text-editing`**：rotom 10 步通过；native-pi 10 步后触发 `AgentTimeoutError: Agent execution timed out after 1200.0 seconds`，未产出 reward。按仓库口径这属于超时/环境类失败，单独计数，不当答错；若排除该题，native-pi 为 5/9 = 0.556。

## `configure-git-webserver`：两臂同时失败，与 rotom 无关

调查结论：不是工具缺失，不是产品资源没加载，不是崩溃或超时。

- rotom 该 trial 的 system prompt 里注入了 26 个工具，含 `bash`、`edit`、`write`；`coding_policy` section 也已注入（整个 system prompt 18,727 字符）。
- 但该 trial 只有 2 步、0 次工具调用，模型直接输出"你可以这样配置"的步骤。它的 reasoning 明说：判断用户在要 general steps，准备给指令和脚本。
- native-pi 同题表现一致：2 步、0 次工具调用、同样是步骤说明。

因此这条失败属于 **Harbor Pi `--print` 单轮形态 + 题目措辞**：任务被读成"教我怎么配"，两边都没有"你现在在一个容器里，必须把它配出来"的框架。它既不能算 rotom 的短板，也说明这类任务在这个 arm 上测的是提示理解而非执行能力。若要评执行能力，需要额外的执行性 system prompt 或换用带自主执行框架的 harness —— 这一改动未做、未验证。

## 其他两个失败（两臂都失败，但原因不同）

- **`db-wal-recovery`**：rotom 21 步后报告 `/app/main.db-wal` "now missing"。它先前观察到该文件 16,512 字节、整体 XOR 0x42（首 4 字节还原出 SQLite WAL magic），随后文件消失，最终没有产出 verifier 要的 recovered 文件。**推测**是它自己执行 sqlite 命令时触发 checkpoint 删除 WAL，从而销毁了取证对象；未进一步验证。
- **`git-multibranch`**：rotom 12 步，自建 SSH Git 服务并把 HTTPS 部署放在 8443，与 verifier 期望的多分支 HTTPS 部署形态不符，`test_multi_branch_https_deploy` 断言失败。

## 限制

- 单样本、10 题自选、单模型、单后端；不构成代表性分数或 pass@k。
- 未跑 89 题全集（按本次 $0.159/题均值外推约 $15 起，长尾会更高，**未实测**）。
- 未验证其他模型、thinking level、并发数或沙箱规格对成绩的影响；本次默认 1 vCPU / 2048 MiB 时同题 verifier 会报 `TimeoutError`，说明规格能改变结论，本报告只覆盖 4 vCPU / 8 GB。
- Qoder 未参与：沙箱内只能用 key 型 provider，浏览器登录态不迁移。
- `profiles/release-preparation.json` 仍记 `piVersion: 0.85.1` 与其 integrity，本次实际用 1.4.0；正式发布评测前需要重新冻结版本与 integrity。

## 复现

```sh
cd rotom/evals
. <含 OPENAI_API_KEY 的私有文件>
export RUNTA_CONFIG="$HOME/.config/runta/config.toml"

TASKS=""
while read -r bench task; do
  case "$bench" in \#*|"") continue ;; esac
  TASKS="$TASKS --task=$task"
done < profiles/release-smoke.txt

# dev-agent 臂
./bin/benchmark terminal-bench-2.1 --provider=openai --model=gpt-5 --environment=runta \
  --product=/absolute/path/to/rotom --run-name=rotom-smoke10 --n-concurrent=4 $TASKS \
  -- --override-storage-mb 32768 --override-memory-mb 8192 --override-cpus 4

# native-pi 对照臂：同样的参数，只把 --arm 换成 native-pi 并去掉 --product
```

结果目录：`rotom/evals/.eval/benchmarks/{rotom-smoke10,nativepi-smoke10}/`（私有，不入库）。每个 trial 带 `agent/dev-agent-manifest.json`（产品 HEAD、dirty、bundle sha256）、`agent/trajectory.json` 和 `verifier/`。
