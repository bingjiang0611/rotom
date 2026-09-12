# Owned scope：真实 Opus 小样本对照

> 历史 A/B：下文“未改变默认 / 不自动开启”指本次实验的隔离行为，不代表现行 launcher。`alpha.3` 起发行包已默认 scoped，见 [当前默认](../../docs/agent/subagent-owned-default.md)；本页性能结果不外推到新版本，也不构成重跑授权。

## 本次结论

**功能 PASS；性能 INCONCLUSIVE：这 3 对样本没有观察到明显变慢，但不能证明性能等效。** 默认 scope 未改变。

配置：macOS arm64、Node 24.18.0、公开 Pi 0.85.1、实际安装的 `rotom@0.1.0-alpha.1` / `pi-subagents@0.52.1-rotom.0`；路由 **`cc-switch/claude-opus-5`，thinking=off**。这是配置/运行消息报告的模型身份，不是对网关背后模型或账单的独立认证。

用户授权开/关各 3 次，共 6 个真实子任务；顺序为 **A B / B A / A B**（A=legacy scope，B=owned-process-groups-v2），串行执行、不自动扩样。每次新 SDK host、新 store、新原生 Pi session，固定只读 `payload.txt` 一次，返回 token 和数组和。全部 6 次答案正确、实际调用路径均为 `read("payload.txt")`、payload 字节未改，两个 assistant 响应/任务、一个 model attempt/任务，无模型替换或本地重试。三个 B 样本均有匹配当前 store 的 owned close 与 lease-release 证明。

### 耗时（毫秒）

主指标从 **执行器派发开始 → 观察到 process-terminal 关闭证明**；不把启动回执或模型答完当作关闭。

| 配对 | 关闭 scope | 开启 scope | 开 − 关 |
|---|---:|---:|---:|
| 1（A→B） | 5659.08 | 5723.41 | +64.32 |
| 2（B→A） | 5761.94 | 5680.35 | −81.60 |
| 3（A→B） | 5940.58 | 5908.26 | −32.32 |
| **均值** | **5787.20** | **5770.67** | **−16.53（−0.29%）** |
| 中位数 | 5761.94 | 5723.41 | −38.54 |

不能把负差解释为提速。分项均值：

| 分项 | 关闭 | 开启 | 差值 |
|---|---:|---:|---:|
| 派发至回执 | 22.83 | 26.82 | +3.99 |
| 派发至 before_agent_start | 1830.06 | 1836.42 | +6.37 |
| Agent 区间（含模型/网络及 read） | 3898.37 | 3880.26 | −18.11 |
| agent_end 至观测关闭 | 58.78 | 53.99 | −4.79 |

Agent 区间外的启动+收尾合计均值仅差 **+1.58ms**，不能归因或视为精确的纯本地开销。观察器是 **10ms 轮询间隔**，不是 ≤10ms 的误差保证；调度、I/O 和跨进程时钟观测也会带来误差。

### 用量与成本

6 个原生 Opus 子任务，12 个 assistant 响应，控制器没有模型调用。客户端累计报告：input 24、output 473、cacheRead 12814、cacheWrite 7203、totalTokens 20514（含缓存）；客户端价格字段合计 0，**实际计费未知，不能称为免费**。未额外调用 Opus 做评审或扩样，未观察/声明网关内部 HTTP 重试次数。

### 范围与限制

- 固定拓扑使用当前组件的 `createSubagentExecutor.execute` 和真实 native writer，经公开 Pi loader 加载；没有使用 Pi 私有导出、修改安装源码或复制凭据。原生客户端按既有 HOME 发现账号配置，项目内关闭 request retry/compaction。三个 helper 在每个阶段冻结并记录 SHA256。
- **这是执行器/原生子进程对照，不是完整外层 rotom CLI 或 public subagent_wait 的性能测试。** `executePublic` 在 legacy 会把 single 包装为 workflow，而 scoped single 保留原身份；若直接比那两条路，会把不同拓扑混入 scope 开销。本次两组均确认 `status.mode=single`。
- 主指标不含一次性 store 初始化与父 SDK host 建立。由派发前 ledger 重建的 host-start→close 均值为 A 8774.52ms / B 8692.62ms，也只是这次隔离 host 的观测，不是常驻父会话的必付开销。
- 固定任务、工具和 thinking 相同；有效 system prompt 都为 2742 bytes，但摘要不同，不能称逐 token 输入完全相同。模型输出长度、首次/后续缓存命中和网络仍有差异，未做 prompt 差异的归一化归因。
- n=3/组，不测并发、资源争用、取消/超时、owner loss、外部 CLI、长任务或实际业务效果，不外推 Windows/Linux 性能或整体吞吐。不自动开启 owned scope。

## 重现与预算

以下只支持本次固定产品/模型。根目录必须是既有私有空目录。先运行无模型请求的 metadata preflight 和本地 faux dry-run；**再次执行 live 必须获得新的模型调用授权**。

```sh
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/rotom-scope-bench.XXXXXX")
ROOT=$(cd "$ROOT" && pwd -P)
PRODUCT="$HOME/.local/share/rotom/releases/0.1.0-alpha.1/node_modules/rotom"
node experiments/subagent-owned-performance/prepare.mjs "$PRODUCT" "$ROOT"
node experiments/subagent-owned-performance/benchmark.mjs --dry-run "$ROOT"
# 仅新授权后执行；固定 6 个子任务，不是 6 个单轮 API 响应：
node experiments/subagent-owned-performance/benchmark.mjs --live "$ROOT"
node experiments/subagent-owned-performance/analyze.mjs "$ROOT/live/results.json"
```

每任务最多 3 turns、1 tool、token budget 20000、120 秒；这些是客户端控制，不是上游账单硬上限。phase 不允许重入；每次尝试在派发前记账，未知执行立即停止并保留目录，不重放。`tap.mjs` 的独占 writer marker 拒绝意外的第二次已加载 writer。任务只有 read 工具，但这仍不是 OS 安全沙箱。

本地分析测试：

```sh
node --test --test-concurrency=1 experiments/subagent-owned-performance/analyze.test.mjs
```

## 证据与修正记录

`/tmp/rotom-opus-scope-root` 指向私有实测根；`live/plan.json`、`attempts.jsonl`、冻结 helper、六个 `result.json` / events / status / native session / process-terminal，以及 `summary.json` 可逐项核验。只在维护文档记录上述聚合 metadata，不提交账号配置、模型正文或本机 runtime artifacts。

两次早期 dry-run 的工具设计问题保留在先前私有根：首次 public single 实际变成 workflow，错误期待 single terminal；随后 bare executor 没注册公开 wait tracker，使手工调用 wait 空返。最终固定 single 执行器拓扑、取消无效 wait 指标，改为观测真实 process-terminal。最终 dry A/B 均通过后才消耗六次真实授权；这些 dry-run 不是产品回归或真实性能数据。实测后仅修正 child helper 对“10ms 误差上限”的注释，不改变执行逻辑；测量时的原文件与摘要仍冻结保存。
