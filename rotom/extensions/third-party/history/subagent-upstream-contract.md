# Wait/control：上游测试合同迁移

> 历史报告；下文安装状态与采用结论仅指该批。当前默认及旧命令的重放限制见 [历史索引](README.md)。

## 结论

**定向合同 PASS；完整采用仍 BLOCKED。**

本轮只维护测试，不修改四个 runtime 候选或安装。重新复现历史 8 个失败后，迁移旧测试合同，并用原始源码作反事实检查。没有跳过失败用例、降低原有 completion 内容断言或把 send 返回当成 receipt。

## 8 个失败的归因

| 数量 | 旧断言 | 迁移后的合同 |
|---|---|---|
| 1 | control event 对象不含 ID | 保留原字段精确比较，另断言 UUID、序列化保留身份、同属性新事件使用不同 ID |
| 6 | send 返回即删除订阅 | mock 显式保存真实发送 envelope 到 session readback；只有匹配 owner/token/run/attempt/outcome 的 receipt 才清理 |
| 1 | attention 和 timeout 都消费订阅 | attention 后保持同 token/原 deadline，不重复唤醒；timeout 只消费对应订阅，原 attention 订阅仍能收到 completion |

receipt fixture 只是公开 session readback 的 **L1 模拟形状**，不是实际 SDK session、fsync 或模型消费证明。它复制实际发送的 envelope，不从管理器记录拼装一个必定匹配的回执。

新增三项上游测试：事件身份；accepted 投递的重启/foreign-file/错误 attempt 拒绝；throw 前后 receipt 可见性的 unknown 恢复。原有“cleanup fails before delivery”更名为“attempt persistence fails before delivery”，保留持久化失败时不能发送、恢复后发送一次的断言。

## 可复现反事实矩阵

同一个 upstream tag：`v0.52.1 / afa22c811f81883acdb248c84f116ac7534e2fb4`。

| 源码 | 测试 | pass / fail | 含义 |
|---|---|---|---|
| 原始 | 原始 | **42 / 0** | 基线定向测试可运行 |
| 四个候选 | 原始 | **34 / 8** | 精确复现历史差异 |
| 四个候选 | 迁移后 | **45 / 0** | 旧合同迁移及新增断言通过 |
| 原始 | 迁移后 | **40 / 5** | 新断言确实能拒绝旧行为，不是无条件放行 |

四组都没有 cancelled/skip，并逐项核对失败测试名称，防止相同失败数掩盖无关错误。预期失败组的 Node exit 为 1；外层 harness PASS 表示矩阵与预期一致，不表示基线满足新合同。矩阵重复通过，迁移后 upstream `tsc --noEmit` 通过；另外四 patch wait **55/55**、startup 协议 **21/21** 通过。

复现从 dev-agent 根运行，`SOURCE` 是有依赖的独立 upstream Git 根，不能是安装目录：

```bash
SUBAGENT_UPSTREAM_SOURCE="$SOURCE" \
  node --experimental-strip-types --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-upstream-contract-regression.test.mjs
```

新 harness 从固定 Git tag archive 取原始源码/测试，私有 HOME/TMP，分别应用四个源码 patch 和独立的 `subagent-upstream-contract-tests.patch`。只跑 `wait-subscriptions`、`subagent-control`、`spawn-budget` 三个文件；Node 24 的 `--experimental-test-isolation=none` 避免为这组纯本地合同再产生逐文件子进程。依赖只通过副本内链接复用，不安装或修改 node_modules；不是 OS 沙箱。

未传 source 时仅执行 patch 路径静态检查，矩阵明确 skip。每个命令请求 30 秒截止，超时/信号/缺少汇总不能冒充 gate 完成，异常保留 fixture；这不是主机硬时间或全进程图终止保证。

## 完整 unit 尝试：未完成有效配对

本轮也尝试过串行完整 unit，但门禁控制出了问题：计划 180 秒截止的基线进程没有被可靠收束，外层工具在 385 秒报超时；Node 后来继续到约 31 分钟才自行结束。没有生成预期结果清单，候选完整 suite **未启动**。不能声称 watchdog 生效，也没有扩大截止再跑完整套件。

最终基线日志：**2213 tests，2206 pass / 4 fail / 3 skip**：

- `agent-frontmatter` 的 bundled hot-update：archive 副本能借父目录解析依赖，但其嵌套 fixture 指向本地 `node_modules`，当时该路径不存在，导致缺 `yaml`。补上副本的依赖链接后，**只重跑这一个原始测试并通过**；没有修改原始源码/测试。这是 fixture 布局问题，不是候选回归。
- `mission-store` 的 abandoned-lock 竞争：approved writer timeout。
- `orca-progress-tabs` 两项同 worktree 排队创建：等待文件超时。

后三项尚未归因，不能算成候选缺陷，也不能宣称已修复。后续观察中原测试 PID/进程组已消失，未补发信号；没有据此宣称主机无逃逸 writer。旧 baseline archive、临时 HOME 等不确定历史目录保留，不清理活跃 `.pi` 状态。

因此本次只关闭“八项定向旧合同失败尚未迁移”的事项。完整 unit/integration、真实非阻塞恢复、多 manager、RPC 生命周期与不配合取消的工具仍阻塞采用。没有重跑模型/UI/平台验收，没有付费评测模型请求，不报告性能/token 收益。

## 文件与证据

- `subagent-upstream-contract-tests.patch`：只改变两个 upstream unit 文件；与已有候选一样使用零上下文，应用时需 `git apply --unidiff-zero`。
- `subagent-upstream-contract-regression.test.mjs`：有界四组反事实与 typecheck。
- 本机日志：`/tmp/dev-agent-contract-matrix.log`、`/tmp/dev-agent-wait-contract-{before,after,baseline}.log`、`/tmp/dev-agent-contract-{full-baseline,layout-check,wait,startup}.log`。不上传原始日志或业务会话。
- 四个源码候选、package/lock、launcher 和 installed source 保持不变。本轮未运行产品全量 fast 或付费 canary；变更仅是维护测试，上一阶段的产品/SDK证据不冒充本轮重跑。
- 独立重放后，208 个源码文件和 2 个迁移后的 test 文件逐字节匹配实测隔离树；206 个 installed source 文件仍匹配原 tag。

SHA-256：

| 文件 | SHA-256 |
|---|---|
| `subagent-upstream-contract-tests.patch` | `001bc87f1dd13a3c1a32eb3948db8d1cc98b3d4f022001f2a36fc59f45ac66df` |
| `subagent-upstream-contract-regression.test.mjs` | `ec54803fbc733b51eb6f9b3df5a35b20bbba4616ee21fb0c9973a25eb299c54f` |
