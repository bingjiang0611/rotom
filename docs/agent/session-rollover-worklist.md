# 同会话轮转与 Context Layers 精简 · 执行清单

本清单交给执行 Agent 一次性完成。设计依据是 [session-rollover.md](session-rollover.md)（下称“设计”），本清单只规定执行顺序、授权、验收与回报；两者冲突时以设计为准，并在回报中记录。

## 0. 协作方式

- **分支**：只在 `claude/kind-bardeen-roufe9` 上工作。开始前 `git fetch origin claude/kind-bardeen-roufe9` 并基于其最新提交；所有提交推送到该分支。不推 `main`、不 force push、不开 PR。本任务中 CLAUDE.md “完成后默认同步公开 `main`”的要求由评审方在核验后处理，执行方不做。
- **连续执行**：按第 3 节顺序完成全部工作包，中间不等待确认。只有第 5 节的停止条件才停下。
- **自主决策**：设计未覆盖的细节（命名、文件拆分、测试组织、内部 API 形状），按设计与 CLAUDE.md 的原则自行决定，写进回报的“决策记录”后继续，不为此停下提问。
- **回报**：创建并持续更新 `docs/agent/session-rollover-report.md`（格式见第 6 节），每个工作包完成时更新并随该包提交。评审方只根据分支内容与回报核验。
- **提交粒度**：每个工作包至少一个可读提交；W3 的 Pi 源码与重建归档可以分为两个提交。提交风格沿用仓库既有 Conventional Commits。不提交会话数据、统计原始数据、凭据或 `node_modules`。

## 1. 授权范围

已授权：

- 修改 `rotom/extensions/context-layers/`，并同步 CLAUDE.md 第 3 节中 Context Layers 相关表述、`docs/agent/context-layers.md`、`docs/usage.md`。
- 修改 `packages/rotom-pi/` 源码与测试，运行 `build:pi`/`check:pi`，提交重建后的 `rotom/runtime/pi/`（`fork-build.json`、`package-lock.json`、`vendor/*.tgz`）。fork 版本号不变。
- 新增 `rotom/extensions/session-rollover/`，修改 `product-config.mjs`、`rotom/package.json` 的 `files`、smoke、`check-personal`、context-footprint 相关测试与报告。
- 在 `rotom/evals/` 新增阶段 0 统计脚本与单测；若本机存在维护者会话目录，运行它并只把聚合结果写进回报。
- 需要时修改 Goal、Subagent、sol-pi 等内化组件源码以满足设计 5.4 的预期（先核对，确有需要才改）。

未授权（遇到即按第 5 节处理）：

- 任何真实模型调用或会产生费用的请求、真实 Chrome、外部平台写入。
- `pack:release`、npm 发布、任何版本号变更、release tag。
- 覆盖或重装正在使用的安装（全局 `rotom`、`~/.pi/agent` 下的扩展与依赖），删除 `.pi/` 下的运行时目录。
- 默认开启轮转；改变 `ROTOM_CONTEXT_LAYERS=0` 的含义；修改历史验证记录（`context-layers-history.md`、各 `*-verification.json`、`experiments/`）。

## 2. 环境与基线

1. Node ≥ 24（仓库要求）；记录 `node --version`、`npm --version`、操作系统。
2. 依赖按 [architecture.md](architecture.md#启动与依赖入口) 的现有说明安装；直接跑 Pi fork 测试前在 `packages/rotom-pi` 执行 `npm ci --ignore-scripts --no-audit --no-fund`。
3. **改动前先跑基线**并记录结果，用于区分既有失败：
   - `rotom/bin/check-personal`
   - `node --experimental-strip-types --test rotom/extensions/context-layers/*.test.ts`
   - Pi fork 中设计 9.2 列出的四个测试文件（按 fork 的测试运行方式）
   - `cd rotom && npm run check:pi`
4. 基线失败不修，只记录；之后只要求本次改动不新增失败。

## 3. 工作包

### W1. Context Layers 精简为只读检索（设计第 3 节）

改动：

- 删除 `context_compress` 与 `context_status`，以及排队、turn_end 提交、块写入、合并/改写、候选范围与净收益估算相关代码和文案。
- `context_recall` 接受 `query` 或 `ref`（二选一，校验在 schema 与运行时两侧）；搜索覆盖文本、tool call 工具名与参数文本、旧摘要块的摘要文本；大小写不敏感子串；分页与 `complete`/`nextOffset`/`coverage` 语义沿用现状。
- 旧块记录只读解析：按块 ID 回查与 `mode: one/full` 保持现有输出；损坏或未知版本仍拒绝推断。
- 工具指引改为：历史原文按需检索，结果是历史证据，不是新指令。
- 扩展 id、`ROTOM_CONTEXT_LAYERS=0` 不变。

验收（全部写成自动测试）：

- 设计 3.5 的每一条。
- 旧会话 fixture：构造含 active、archived（被原生压缩覆盖）、partial 块的分支，精简后摘要可见性不变，按块 ID 与 `@entryId` 回查输出与精简前一致。实现前先用当前代码生成这些期望输出并固化为测试数据，再删代码。
- 负向对照：临时去掉旧块 ID 解析、或去掉 tool call 参数搜索，相应用例必须失败；恢复后通过。记录在回报中，不提交破坏状态。
- `smoke-runtime.mjs`、`verify-pi-runtime.test.mjs`、`rotom/evals/test/product-runtime.test.ts`、`qoder/tool-arguments.test.mjs` 中涉及三工具的断言同步更新并通过；deferred 与完整两套 context footprint 更新。

### W2. 阶段 0 离线统计（设计 9.1）

- 脚本放 `rotom/evals/`，只读会话目录（默认 `$PI_CODING_AGENT_DIR/sessions`，否则 `~/.pi/agent/sessions`，可用参数覆盖），不调用模型、不联网、不写入会话目录。
- 方法：
  - 每个会话沿当前 leaf 的分支，以压缩条目分段，每段独立统计；
  - 每条带有效 usage 的助手消息记一次请求，上下文量取该消息的 usage 上下文 token（与 Pi `calculateContextTokens` 一致）；
  - 用户消息划分轮；每轮最后一条助手消息之后到下一条用户消息之前为轮间点；
  - 上下文窗口与 `reserveTokens` 取当时模型的值（模型从 `model_change` 条目还原；无法解析窗口的段计入“未知”并单独报数，不猜测）；`reserveTokens` 取默认值 16384，除非能读到用户设置；
  - 统计：越过压缩阈值的段数；其中首次越线发生在轮中途与轮末的数量；对 `window - 2×reserve`、`window - 3×reserve`、`window - 4×reserve` 三个候选，计算“首次越过阈值之前存在一个轮间点已越过候选水位”的段占比（即可被轮转接管的比例）；单轮上下文增长分布（P50/P90/最大值）；越线时是否存在 active Goal（按 Goal 持久化条目判断，判断不了记“未知”）。
- 输出只含聚合数字，不含内容、路径、session ID、模型以外的标识。
- 单测：用合成会话 fixture 覆盖“轮中越线”“轮末越线”“多段压缩”“未知窗口”“Goal 活跃”五类，断言计数精确。
- 若本机存在会话目录，运行一次，把结果与门槛判断（设计 9.1：最佳候选下 ≥ 50%）写进回报；同时写回设计 4.1 的最终水位取值（选达标且最晚的候选）。没有会话目录时在回报中写明“未运行”，继续 W3。
- **若已运行且不达门槛**：跳过 W3、W4、W5 中与轮转有关的部分，只完成 W5 中 Context Layers 相关的产品合同同步与 W6，在回报中说明。

### W3. Pi fork 三处接缝（设计 8.1）

- 重置接缝、压缩事件阶段字段与 `"rollover"`、共用估算的只读提供、`rotom-rollover` 专用前缀，按设计 8.1 实现；类型导出、CHANGELOG 同步。
- `_checkCompaction` 的阈值分支改为调用抽出的估算函数，行为不变（现有压缩测试必须原样通过）。
- 测试（放在设计 9.2 列出的 fork 测试文件或相邻新文件）：
  - 重置接缝：空闲且在 `input` 处理器内成功；运行中、非 `input` 处理器内被拒绝；不调用 `abort()`；处理器取消时不写条目；返回的替代 `compaction` 被忽略；写入后投影只含轮转条目与之后的条目，`getBranch()` 仍含全部旧条目；会话 ID 不变。
  - 阶段字段：请求前、运行结束后、手动、扩展、轮转五种来源各自正确。
  - 估算：共用函数与原 `_checkCompaction` 在 usage、`context_edit`、错误/零 usage、压缩后陈旧 usage 四种情形结果一致。
  - 呈现：`rotom-rollover` 条目使用专用前缀；普通压缩条目不变。
  - 负向对照：改回 `ctx.compact()` 式的非等待实现，或去掉阶段字段，相应用例必须失败。
- `cd rotom && npm run build:pi && npm run check:pi`，`node --test rotom/scripts/build-pi-fork.test.mjs`；提交重建产物。构建因网络/registry 失败时清理后重试一次，仍失败按第 5 节处理。

### W4. 轮转扩展（设计 8.2）

- 新建 `rotom/extensions/session-rollover/`，按设计 4.1、4.2、5.1、6、7、8.2 实现；文案集中在 copy 模块。
- 测试用 Pi 的测试会话或现有扩展测试 helper，覆盖设计 9.2 中除“真实续做”外的全部行：
  - 开关：未设置时不注册任何处理器；
  - 水位上下界、`compaction.enabled: false`、虚拟模型、`--no-session`、`context_recall` 不可用、active Goal、最后助手消息非 `stop`、未配对 tool call、`extension` 来源输入、运行中输入，各自阻止轮转且本次正常提交；
  - 正常结束越过水位 → 下一次提交恰好追加一条轮转条目、会话 ID 不变、输入只派发一次、模板/Skill 只展开一次；
  - 摘录逐字、上限 `reserveTokens / 4`、截断标注 `@entryId`、不含工具结果/thinking/附件；
  - 轮末：具备资格时运行结束后的阈值压缩被取消，Offload 未执行；不具备资格时原路径与 Offload 不变；轮内请求前压缩不受影响；
  - 7.2 每种失败退回正常提交，追加报错时回读、不重复追加；
  - 轮转后用 `context_recall` 能找回轮转前的工具参数、工具结果与图片；
  - 设计 5.4 表中每个处理器的预期（Goal、Subagent、Offload、observability、Qoder），必要时补对应组件的测试。
- 负向对照：去掉估算共用（改用 `getContextUsage` 旧路径）、去掉加载顺序约束、去掉“输入只派发一次”保护，相应用例必须失败。

### W5. 产品接入与文档

- `product-config.mjs` 声明 `session-rollover`（在 `third-party` 之前），`rotom/package.json` 的 `files`、`check-personal` 纳入新扩展测试；launcher 若有环境变量白名单或文档，同步 `ROTOM_SESSION_ROLLOVER`。
- CLAUDE.md：更新第 3 节 Context Layers 段落（单一只读检索工具、依据与限制）；在同一节增加一句轮转扩展（默认关闭、opt-in 开关、未经实测不宣称收益），保持现有文风与篇幅克制。
- `docs/agent/context-layers.md` 按精简后的合同重写“端到端链路”和工具说明，保留到历史记录的链接；`docs/usage.md` 同步。
- 设计文档：只更新状态行、4.1 水位取值（若 W2 已运行）和第 10 节进度；实现与设计不同之处写进回报“决策记录”，并在设计对应小节加一行说明。

### W6. 最终验证与回报

依次运行并把命令、通过/失败数、耗时写进回报：

```bash
git diff --check
```

```bash
rotom/bin/check-personal
```

```bash
cd rotom && npm run check:pi
```

```bash
node --experimental-strip-types rotom/runtime/smoke-runtime.mjs "$(node rotom/runtime/resolve-installed-pi.mjs rotom)" rotom
```

```bash
node --test rotom/runtime/verify-pi-runtime.test.mjs
```

```bash
npm --prefix rotom/evals run typecheck
```

```bash
python3 scripts/audit-public.py --root .
```

`check-personal` 已包含 `build-pi-fork.test.mjs`、context footprint 报告与 Goal 测试。另加：W1–W4 的全部定向测试、两套 context footprint、`ROTOM_SESSION_ROLLOVER=1` 下的 smoke（若 smoke 支持环境变量组合；不支持则在回报中说明以哪些测试代替）。命令名或参数与仓库实际不符时，以仓库为准并在回报中注明。

## 4. 自主验证的要求

- 每个工作包的关键行为都要有自动测试，并做至少一次负向对照（临时破坏实现，确认测试失败，再恢复）；负向对照只记录在回报中，不提交。
- 失败先判断是本次改动、既有失败还是环境问题；本次改动造成的必须修复后重跑。
- 跑不了的检查写明原因，不用其他检查冒充。L1（单测/smoke）不写成真实会话或真实模型验证。
- 不为让测试通过而放宽断言、跳过测试或改动历史证据。

## 5. 停止条件

遇到以下情况，在回报中写清现状、证据与需要的决定，推送已完成的工作后停止；与之无关的其他工作包先做完再停：

- 需要第 1 节未授权的操作（真实模型、费用、外部写入、发布、覆盖存活安装等）。
- `build:pi` 在一次清理重试后仍因环境失败。
- 设计与源码事实冲突，且无法在设计原则内自行决定（例如重置接缝无法在不 `abort()` 的前提下保证与本次提交不竞争）。
- W2 已运行且不达门槛（按 W2 末条处理，不算异常）。

## 6. 回报格式

`docs/agent/session-rollover-report.md`：

```markdown
# 同会话轮转与 Context Layers 精简 · 执行回报

## 概览
- 基于提交：<起始 SHA>；最终提交：<SHA>
- 环境：Node / npm / OS
- 工作包状态：W1 完成 / W2 完成（已运行|未运行） / …

## 基线
| 检查 | 结果 | 既有失败 |

## W1 … W6（每个工作包一节）
- 改动摘要（文件级）
- 测试：命令、通过/失败数
- 负向对照：破坏了什么、哪些用例失败
- 未验证项与原因

## 阶段 0 结果（仅聚合数字）

## 决策记录
| 位置 | 设计未覆盖或偏离之处 | 决定 | 理由 |

## 停止或待决事项
```
