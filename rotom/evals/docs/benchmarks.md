# 容器隔离与公开基准

[返回评测入口](../README.md)。本页命令和反引号内的相对路径以 `rotom/evals/` 为工作目录，除非另有说明。

## 使用 Apple container 隔离运行

macOS 上安装并启动 Apple `container` 后，可以把相同评测放进独立 Linux VM：

```sh
cd rotom/evals
ROTOM_NODE=/absolute/path/to/node npm run eval:container -- \
  --container-env=OPENAI_API_KEY \
  --provider=openai \
  --model=model-id
```

runner 每次会增量构建 `dev-agent-evals:local`，并执行以下隔离：

- 构建前用系统 `tar` 归档当前 eval 工作树（包含未提交源码），排除 `node_modules`、`.eval` 和 macOS 扩展属性；临时构建目录只含 Containerfile、package/lock 与 `source.tar`，成功或失败均清理。不再直接把源码目录作为构建上下文，也不再使用 `.dockerignore`；

- 镜像固定到 `node:24.18.0-bookworm-slim` 的 OCI digest，依赖继续使用精确 lockfile；
- 目标 `rotom` 目录只读挂载到 `/workspace/product`，Pi 来自该候选的 `runtime/pi`，不再使用镜像内的另一套旧 Pi；候选依赖必须已安装且可在 Linux 中运行，不挂载宿主机 Home 或完整 `~/.pi`；
- rootfs 只读、Linux capabilities 全部移除，`/tmp` 使用 2 GiB tmpfs；Vite 启动所需的
  `node_modules/.vite-temp` 单独覆盖为 64 MiB tmpfs；
- 默认限制 4 CPU、8 GiB 内存，artifact 是唯一宿主机可写挂载；
- 镜像 digest、Apple container CLI 版本、Linux platform、网络名和资源限制写入 run manifest；
- API key 等变量只有通过 `--container-env=NAME` 点名且宿主机确实存在时才继承；
- 如需 Pi subscription credential，必须用 `--container-auth=/absolute/path/auth.json` 显式选择；runner
  只把该文件复制到一次性私有临时目录，容器退出后删除。

验证镜像自身、Linux 下的 product verifier 和真实 `AgentSession` faux smoke：

```sh
ROTOM_NODE=/absolute/path/to/node npm run test:container
```

当前 Apple container `1.2.2` 下，最小用例中的 `COPY .` 与显式目录 `COPY` 都遗漏嵌套文件；`ADD source.tar` 能保留深层文件和可执行权限。因此 Containerfile 由上述 runner 准备输入，不支持直接对源码目录运行 `container build`。只有后续版本的深层文件复制用例与完整 `test:container` 都通过，才移除归档适配并恢复目录 COPY 及对应排除规则。

离线验证已在 macOS 和真实 `linux/arm64` 容器通过：各 **141 通过、1 项原有 sidecar 条件跳过**（Node `24.18.0`、Pi `1.4.0-rotom.2`）。测试复用候选产品路径，并显式设置权限反例，避免 `umask 077` 把“不安全文件”意外创建为安全权限；未转发凭据、未调用付费模型，不代表真实模型或桌面操作验证。

常用控制参数：

```sh
npm run eval:container -- \
  --container-cpus=6 \
  --container-memory=12G \
  --container-tmpfs=4G \
  --container-network=default \
  --container-artifacts=/absolute/path/to/artifacts \
  --container-product=/absolute/path/to/rotom \
  --container-models=/absolute/path/to/models.json \
  --no-container-build \
  --provider=openai \
  --model=model-id
```

Apple `container` 的独立网络能隔离不同容器网络，但默认网络仍允许模型请求；这里不把 `--no-dns` 冒充成
完整断网。Browser/Computer Use 的真实桌面登录态与外部写入仍属于宿主机 L3 suite；container 主要承载可复现的离线 fixture、fake CLI 和模型驱动 L2 评测。

每次原生运行写入私有权限的 `.eval/<timestamp_uuid>/`，container 运行写入
`.eval/container_<timestamp_uuid>/`。harness teardown 先 await `session_shutdown`（其中 Observability flush），再保存最终 session/trace，最后删除临时根，避免丢失 terminal/unknown closure：

- `vitest-results.json`：供 `vitest-evals` 本地报告 UI 使用；
- `runs.jsonl`：每个 harness run 的索引、usage、timing、artifact 引用和 run manifest；
- `comparisons.json`：baseline/candidate 配对汇总与缺失观测诊断；
- `sessions/<run-hash>/session.jsonl`：shutdown 后的最终 Pi 原生 session；
- `traces/<run-hash>/trace.jsonl`：metadata-only 本地 trace；默认最多 1 MiB，超限保留从完整 JSONL 边界开始的 tail；
- `traces/<run-hash>/trace-snapshot.json`：original/captured bytes、full/tail strategy 与 truncation；
- `sources/<run-hash>/*`：case 显式登记的源码或结果附件。

这些 artifact 可能包含 prompt、模型回答、工具输出和业务数据，只能放在本机私有目录，不能提交。

## SWE-bench Multilingual 与 Terminal-Bench 2.0

默认只跑 1 题，避免一次命令意外触发完整数据集的模型费用和数十 GB 镜像下载：

```sh
cd rotom/evals

# SWE-bench Multilingual 单题
npm run benchmark -- swe-bench-multilingual \
  --provider=openai \
  --model=model-id \
  --task=apache__druid-13704

# Terminal-Bench 2.0 单题
npm run benchmark -- terminal-bench-2 \
  --provider=openai \
  --model=model-id \
  --task=terminal-bench/make-mips-interpreter
```

运行完整数据集必须显式使用 `--all`：

```sh
npm run benchmark -- swe-bench-multilingual \
  --provider=openai --model=model-id --all --n-concurrent=2

npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id --all --n-concurrent=2
```

还可以使用 `--n-tasks=N`、重复 `--task=NAME`、`--attempts=N` 和 `--run-name=NAME`。重复显式 `--task` 时，未显式给 `--n-tasks` 会自动使用 task 数量，避免默认一题截断；`--all` 不能与 `--task/--n-tasks` 混用。agent 安装超时默认使用
Harbor 基线的 5 倍，避免 Node/Pi/extension 首次下载超过 Harbor 的 360 秒；可用
`--setup-timeout-multiplier=N` 单独调整，不改变任务执行或 verifier 超时。默认从
`ROTOM_EVAL_PROVIDER` / `ROTOM_EVAL_MODEL` 读取模型。用 `--dry-run` 查看最终 Harbor argv；需要传递
Harbor 自己的 timeout/debug/retry 参数时放在 `--` 后面。runner 会拒绝从透传参数覆盖 agent、dataset、
registry、task selection、model、environment、verifier 和结果路径。

### Apple container 与 amd64

两个官方评测集的大量预构建镜像只有 `linux/amd64`。Harbor 原生 `apple-container` backend 默认按 arm64
拉取，会在完整下载后才报 `does not support required platforms`。因此默认环境是本目录的
`Amd64AppleContainerEnvironment`：保持官方 task image 和 verifier 不变，只在 Apple container 的 build/run
命令上加入 `--platform linux/amd64`，运行时再加入 `--rosetta`。

可选环境：

```sh
--environment=apple-container-amd64   # 默认，Apple Silicon + Rosetta
--environment=apple-container-native  # 只适合明确提供 arm64 的题
--environment=docker                  # 官方 Docker backend，需要运行中的 daemon
--environment=runta                   # Runta 远端沙箱，需要 harbor[runta] 且已 runta login
```

Rosetta 解决的是 CPU 架构，不会把 GPU、嵌套虚拟化、多容器 Compose 或 Windows 特性变出来。遇到这类题时，
Harbor 的 exception 必须按基础设施失败单列，不能算成 Agent 得 0 分。若要提交官方 leaderboard，仍应在官方
推荐的 Docker/云环境上复跑；Apple container 结果用于本项目内部同环境 A/B 回归。

### Runta 远端沙箱

本机没有可用的 Apple container 服务或 Docker daemon 时，`--environment=runta` 把 task 容器、agent 安装和
verifier 全部放到 Runta 沙箱里跑，runner 只传 `--env runta`，不要求本地 daemon。前置条件:

```sh
uv tool install 'harbor[runta]==0.26.0'   # 0.22.0 没有 runta extra
runta login && runta ps                   # MISSING_TOKEN 就是没登录
export RUNTA_CONFIG="$HOME/.config/runta/config.toml"   # 或用 RUNTA_TOKEN；否则报 Runta requires RUNTA_TOKEN or RUNTA_CONFIG
npm run benchmark -- doctor --environment=runta
```

`doctor --environment=runta` 只检查 Harbor 版本、product 文件、adapter 与 `harbor.environments.runta` 可导入，
不检查本机 container/docker。沙箱磁盘仍用 Harbor 自己的参数调整:

```sh
export RUNTA_CONFIG="$HOME/.config/runta/config.toml"
npm run benchmark -- terminal-bench-2.1 \
  --provider=openai --model=model-id --environment=runta \
  --product=/absolute/path/to/rotom --task=make-mips-interpreter \
  -- --override-storage-mb 32768
```

`--task` 要写 registry 里的裸任务名（如 `make-mips-interpreter`）。Harbor 0.26 + 本地 registry 不会把 dataset
名当命名空间；写成 `terminal-bench/make-mips-interpreter` 会报 `No tasks matched the filter(s)`。

Runta 现在要求 `disk_gib` 在 32–256 之间，而 Harbor 0.26 的内置下限仍是 16，并且只有在传
`--override-storage-mb` 时才会把 `resources` 一起发出去。所以 `--override-storage-mb 32768` 不是可选项：
不传会直接拿到 `HTTP 422: resources.requests.disk_gib must be between 32 and 256`，只传 CPU/内存不传磁盘也一样。
沙箱起不来时先用 `runta run --cpus 4 --memory 8192 --disk-size-gib 32` 加 `runta inspect <name> --json` 看
`error_code`：`balance_exhausted` 是账号余额不足，与本仓库配置无关。

沙箱内的 rotom 只能用 key 型 provider（`--provider/--model` 加对应 API key 环境变量）；Qoder 的浏览器登录态
和宿主 Pi 凭据都不会进沙箱。Anthropic 协议的自建网关走 `--model-api-format`（或 `--api-format`）显式声明，
provider 名只用于本地路由：`--provider=custom --model=custom/bailian/deepseek-v4.1-flash` 会把
`bailian/deepseek-v4.1-flash` 原样作为 API 的 model 发出去。

实测记录（单题 `make-mips-interpreter`、`openai/gpt-5`、dev-agent 臂）：一条 30 步、0.42 USD 的 trial 从
安装、bundle、agent 到 verifier 完整结束，无 exception，verifier 2 passed / 1 failed，reward 0.0。失败项
是 verifier 拿不到 stdout（它等到已有的 `frame.bmp` 就把进程终止了），不是 rotom 没启动；同题的有效重跑
需要先确认工作区没有遗留 `frame.bmp`。

两臂 10 题 smoke 的完整数据与限制见
[Terminal-Bench 2.1 Runta 两臂 smoke](../../../docs/agent/terminal-bench-runta-smoke-20261115.md)。

资源规格直接影响结论：默认 1 vCPU / 2048 MiB 下同题 verifier 报 `test_vm_execution` TimeoutError，换成
`-- --override-cpus 4 --override-memory-mb 8192` 后才变成普通的断言失败。慢题在默认规格上的超时应按
环境限制单列，不能直接算成 Agent 失败。

### baseline / candidate 对比

分别指向两个隔离 Git worktree，并保证任务筛选、模型、attempts 和环境完全相同：

```sh
npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id \
  --product=/absolute/baseline/rotom \
  --task=terminal-bench/make-mips-interpreter \
  --run-name=tb2-baseline

npm run benchmark -- terminal-bench-2 \
  --provider=openai --model=model-id \
  --product=/absolute/candidate/rotom \
  --task=terminal-bench/make-mips-interpreter \
  --run-name=tb2-candidate
```

结果默认写入 `.eval/benchmarks/<run-name>/`。Harbor 的 `lock.json` 固化本次实际 task digest；每个 trial 的
agent logs 还包含 `dev-agent-manifest.json`，记录 product Git HEAD、dirty 状态和实际上传 bundle 的 SHA-256。

### 三臂对照（Pi 来源不同）

`--arm` 有三个值，`--product` 相同也可以跑出不同的 Pi：

| arm | 沙箱里的 `pi` | 量的是什么 |
|---|---|---|
| `native-pi` | 官方 `@earendil-works/pi-coding-agent` | 上游 Pi 原始行为 |
| `dev-agent` | shim 导出 `ROTOM_PI` 指回那个官方二进制 | rotom 扩展与 policy，跑在上游 Pi 上 |
| `rotom-fork` | shim 不导出 `ROTOM_PI`，launcher 按默认路径加载 `runtime/pi` | 发布版 rotom 实际加载的 Pi fork |

`rotom-fork` 会在沙箱里对 `runtime/pi` 按锁文件执行 `npm ci`（vendor tgz 随 bundle 上传），随后回读三样写入
`agent/pi-runtime.json`：`rotom --version` 报的版本、`resolve-installed-pi.mjs` 解析出的实际可执行路径、
`build-info.json`（源码 bundle 没有这个文件时为 `null`，此时以 bundle manifest 的 Git HEAD 为溯源）。任一臂如果
落回另一个 Pi，`pi-runtime.json` 会显示出来，而不是只留下一个可疑分数。
查看与比较结果：

```sh
harbor view .eval/benchmarks
```

SWE-bench Multilingual 走 Harbor 官方 adapter 的原始 F2P/P2P verifier；Terminal-Bench 2.0 走每题官方
`tests/test.sh` 与 reward 文件。这里不增加 LLM judge，也不把 Agent 最终文本当成功证据。
