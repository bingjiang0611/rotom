# 离线轨迹分析与压缩工作状态

参考：[CASD](https://arxiv.org/abs/2609.26261)、[AutoCompact](https://arxiv.org/abs/2610.02163)。这是维护侧的小规模验证流程，不是 AutoCompact 的 SFT/RL 复现，也不是新的运行时记忆、自动学习或主动压缩能力。

## 1. 离线分析入口

仓库根运行（Node 24，维护 Pi workspace 的锁定依赖及构建输出须已就绪）：

```bash
node scripts/analyze-session-trajectories.mjs --help
node scripts/analyze-session-trajectories.mjs /absolute/snapshot-a.jsonl /absolute/snapshot-b.jsonl
node --test --test-concurrency=1 scripts/analyze-session-trajectories.test.mjs
```

只接收显式文件，不扫描 HOME、不读凭据、不加载用户 extension、不调用模型、不改源文件、不增加 trace 正文采集。复用 Pi 原生 `parseSessionEntries` 与 `SessionManager.inMemory().getBranch()`，不调用可能修复/重写文件的 `SessionManager.open()`。仅支持 Pi v3 稳定快照；损坏行、无效树、重复输入、非普通文件、最终路径 symlink 或读取期间变化会使整个命令失败，不输出部分报告。

每次最多 32 文件、单文件 16 MiB、总量 64 MiB；重复调用例子每文件最多 20 个，聚合计数完整并给出省略数量。超限应先按任务拆分授权快照；确需更大单文件时，先实现流式有界解析并增加对应测试，不直接去掉上限。

### 统计口径

- 选择每个文件**最后持久化 entry 的祖先链**，排除其他分支；不声称它等于存活 UI 此刻选择的分支。需要其他分支时，先由用户导出对应快照。
- 统计原始执行记录，不把压缩或 context edit 当成删除历史执行；不能将这些计数冒充模型实际输入。报告包含 context edit 数量。
- 同名工具与规范化 JSON 参数相同，记为重复候选；跨压缩比较与上次相同调用之间是否有 compaction。重复读取可能完全合理，**不是已证明的无效调用**。
- Codemode 只统计已记录的 nested calls；参数省略与 `complete=false` 单独计数，未记录的调用不可推断。
- `isError`、assistant error/abort、缺失工具结果是协议事实，不是业务成功/失败标签。任务成功、验证遗漏、无效重试与摘要一致性保持 `unknown` / `not-assessed`。
- JSON 只输出输入序号、统计与原文件行号/块索引，不含文件名、session/call ID、正文、参数或参数 hash。未知工具名折叠为 `other`。错误输出同样不回显原始解析错误或路径。报告仍是用户数据，不默认提交或上传。

### 从统计到规则

1. 用户指定数据范围、用途，并说明是否允许正文交给模型及允许的 provider；本地统计授权不等于正文上传授权。
2. 按任务划分分析集与留出集，相关分支/同一任务不得分到两边；同时检查成功、失败与 unknown 样本。
3. 依据候选行号检查代表性案例与合理反例，记录“现象、分母、证据位置、反例、归因、最小改动、验证方法”。不由关键字自动生成成功标签。
4. 第一轮只选择 1–3 个有证据的问题；复用现有 helper/提示，根因在工具或上下文组装时不要只加提示补丁。
5. 模型 A/B 须另定模型、预算、停止条件与外部写入范围。留出任务上比较正确性、重复探索、验证完整性及包括摘要生成在内的总成本。小样本结果不外推。

尚未导入真实私人会话、提炼跨任务规则或进行付费评测。合成 fixture 只能证明解析和统计口径，不能证明 CASD 的行为收益。

## 2. 本轮源码证据与修复

检查现有共享压缩链路发现：

| 可复现问题 | 最小修复 | 证据边界 |
|---|---|---|
| `serializeConversation` 丢失工具名、调用 ID、`isError`；空正文结果被省略 | 保留这些协议字段，空正文显式占位；工具调用也带 ID | 证明输入证据不丢失，不保证摘要模型正确使用 |
| 长结果只保留开头，末尾错误/测试结论不可见 | 原 2000 字符正文预算内保留头尾各 1000；明确中间省略 | 不是全文读取，中部证据仍可能缺失 |
| branch summary 主动丢弃所有 toolResult | 保留结果，按有界序列化长度估算其预算 | 不把工具调用意图当成实际结果 |

共享摘要提示补充：保留授权与禁止事项，区分假设/事实、尝试/完成、实现/验证，记录检查适用状态，保留未解决错误与 unknown，下一步必须与状态一致，更新摘要时使用新证据替换过时事实。

继续沿用现有摘要格式、触发阈值、会话存储和 resume 路径；不添加独立状态库、compact 工具或在线 judge。自定义 hook 完全替换摘要生成时不继承此提示。文本序列化格式发生变化；原始会话格式和公开函数签名未变。

### 最小验证

- 离线分析器：原生分支选择、跨压缩重复、参数顺序、nested 不完整记录、context edit、输出隐私、损坏输入与限制。
- 压缩定向回归：错误标志/空结果/并行 ID 对应/尾部诊断；初次、更新、split-turn、branch 四种请求均携带共享要求；长 branch 结果预算；原生 JSONL 重新载入与再次摘要请求保持 checkpoint。
- 摘要测试使用 mock provider；只证明序列化、请求与持久化传递，**不证明真实模型生成的摘要质量或 continuation 行为**。没有用模拟响应冒充 AutoCompact 训练效果。

后续获授权的行为评测至少覆盖：根因已定位后继续编辑、测试失败后继续修复、测试通过后又修改必须重新验证、unknown 外部写只读核验、禁止提交约束保留、假设不升级成事实。使用相同检查点对比旧版/新版；外部写入用模拟工具，不派发真实发布或重复写入。跨首次压缩、再次压缩和恢复分别验收。

### 本轮执行记录

- 定向 Pi 回归：74 passed、7 skipped（其中包含需要真实模型的测试）；分析器 6 passed。
- `build:pi`：隔离锁定安装、offline workspace build 通过，构建器内 25 文件 / 283 passed、2 skipped；`check:pi` 通过。
- distribution 与构建器测试 27 passed；公开基线干净 clone 的 runtime identity 39 passed。
- 新 fork 归档在独立 HOME 下按锁安装后，公开基线 default/full runtime smoke 均通过：真实 SDK + faux provider，各 2 次假响应，`lifecycleErrors=0`。未启动真实 provider 推理。
- 本地维护目录曾因已有的 Subagent 声明为 `.4`、installed source 为 `.3` 而使 identity 测试失败；未覆盖这份安装，改在最新公开基线的独立 clone 仅重放本次 diff、干净安装后验证。其他任务的本地 Subagent 改动不混入交付。
- 没有 npm 发布、升级用户安装或迁移活跃会话。模型生成质量、真实续跑行为、收益及真实语料规则提炼仍未验证。
