# 工具执行卫生与源头输出控制：验收报告

日期：2026-10-09。目标：落实历史建议 **5（工具执行卫生）和 6 的第一阶段（源头输出控制）**，并进行明确授权的真实模型验收；没有改 compaction 或子任务生命周期，没有发布 npm / 替换用户全局安装。

## 结论

**功能与证据保全验收通过；“整体减少 token / 工具调用 / 成本”的收益未获支持。**

- 正式真实模型：26/26 固定任务运行通过，139 个已结束模型请求 span，没有 assistant error/abort。
- 自然任务 A/B 两臂均为 10/10；候选定向能力任务 6/6。
- 编辑漂移后能够读取当前内容再修复，检查只执行一次，截断日志保留完整证据，逐字源码未被摘要代替。
- 自然 A/B 中候选的工具调用 **+10.5%**、工具结果正文 **+12.2%**、报告的总 token（含缓存读取）**+26.2%**。不可宣传为普遍省 token，也不据此自动改压缩阈值或默认降低全部工具输出。
- `compact` 是可选的可控上限，不是语义摘要。baseline 已会自行重定向和筛选日志；原生有界尾部有时比它自行筛选的几行更长。

## 交付内容

1. **复用现有执行卫生和 repair hints**：复用已观察的 Git root/cwd、路径、package scripts；状态改变后再查证；不猜路径、不重放 stale edit；失败后区分已写入与后续检查失败。
2. **原生 edit 写入前拒绝回执**：只在纯匹配阶段失败时说明 `No edits were written by this call`。写入失败/取消等可能已发生写入的错误不附加“未写入”，保持 unknown。
3. **原生 bash 可选 `compact: true`**：direct 与 programmatic/Codemode 均返回最后 80 行或 8 KiB；完整日志使用既有私有权限临时文件保留。默认输出合同不变，退出码、超时、取消不变；共用 shell 实现的 PowerShell 同步支持。
4. **源头输出选择**：大 diff 先概览再按文件读取；进程诊断只查相关对象/聚合，不倾倒全机 command arguments；日志过滤不得覆盖原命令退出状态；缺少证据时读日志，不重跑检查。
5. **可重跑验收**：`rotom/evals/cases/tool-efficiency.eval.ts`、判分回归，以及 Pi 原生 `test/tool-efficiency.test.ts`。没有新增调度器、通用摘要模型或工具 wrapper。

完整产品合同见 [tool-efficiency.md](../../docs/agent/tool-efficiency.md)。

## 真实模型方法与运行身份

- Provider/model：`openai-codex/gpt-6-astra`，thinking=`low`。
- 真实 `AgentSession` + 实际 read/bash/edit，合成隔离 Git 工作区；不把合成工作区说成 OS 沙箱。没有业务外部写入或真实进程参数采集。
- baseline：已安装 rotom 0.1.15；candidate：本地仓库候选构建。Pi 版本字符串均为 `1.0.4-rotom.2`，**通过不同源码摘要区分**。
- 每个产品复用自己的 launcher `resolveInstalledPi()`，核验 installed identity、源码摘要、锁、归档与入口，不凭版本号或 PATH 猜测。
- baseline Pi source SHA-256：`e9376ae48d0c230695d72a176a9efbbd2de97d41e8c3819f7281bcf8ea481dcc`。
- candidate Pi source SHA-256：`50f38de814acca0ba2fbbd6c48a246a51e5966afd1a6593cfd225cfc4594f39a`。
- 归档 integrity、policy 文件摘要、逐运行指标及 session/trace 摘要见 [summary.json](summary.json)。完整原始 session/trace 私有保留，不上传会话正文。
- 五个自然任务每臂两次，顺序交替；另有三类候选能力检查各两次。没有把较差的样本删掉，也没有仅挑最后一次成功。
- 这是实际产品对比，不是单变量因果实验；第三方资源合同在本地维护面和公开发行面存在差异。结果不用于归因某一句提示词的净收益。

## 任务验收结果

| 任务 | baseline | candidate | 独立检查 |
|---|---:|---:|---|
| 定位真实仓库、唯一 edit、真实 package 验证 | 2/2 | 2/2 | alpha 保持 2、beta 改为 3；其他源码不变；check 仅执行一次 |
| 失败检查的实际证据 | 2/2 | 2/2 | 正确定位 `src/widget.mjs:73`、EXPECTED=314 / ACTUAL=271；只执行一次 |
| 逐字完整源码 | 2/2 | 2/2 | 110 个分支的整个函数精确包含在回答中，无省略；文件未改 |
| 大 diff 定向审查 | 2/2 | 2/2 | 识别 production 下 auditEnabled true→false；未改文件 |
| 合成进程快照聚合 | 2/2 | 2/2 | COUNT=30、CPU=60；无无关进程参数进入工具输出 |
| 显式 compact 成功检查 | 不适用 | 2/2 | 实际调用 compact；文件正确、检查一次 |
| 显式 compact 失败日志回读 | 不适用 | 2/2 | 原命令非零退出、完整日志回读到中部错误；未重跑 |
| 文件漂移后的 edit 恢复 | 不适用 | 2/2 | 每轮一次真实拒绝→重读 beta=4→改为 3→回读；无重复失败 |

文件漂移由 fixture 在首个 edit 派发前把 beta 从 2 改成 4；模型与原生 edit 返回均非 mock。它验证指定恢复链路，不代表已完成真实多人同时编辑的生产验证。定向任务明确要求相应能力，不能当作自然任务中自动选择该能力的成功率。

### 工具 error 计数不能误读

自然失败检查中，baseline 两次 shell 最后都执行了成功的 grep，未 `exit "$status"`，因此整个工具结果显示成功，虽然最终回答正确报告了失败。candidate 两次都保留了实际非零状态；这就是指标中的两个 tool error，**不是候选多失败两个任务**。

候选定向任务另有四次预期 tool error：两次失败检查、两次写入前 stale edit 拒绝。所有最终状态/文件验收均通过。

## 自然 A/B：效率结果（每臂 10 轮）

| 指标 | baseline | candidate | 候选变化 |
|---|---:|---:|---:|
| 工具调用 | 38 | 42 | +10.5% |
| 工具结果 UTF-8 bytes | 73,670 | 82,633 | +12.2% |
| 报告 input tokens（不含 cacheRead） | 56,693 | 53,109 | −6.3% |
| 报告 cacheRead tokens | 66,560 | 103,936 | +56.2% |
| 报告 total tokens | 129,164 | 162,990 | +26.2% |
| 累计 harness 时长 | 225.81 s | 247.57 s | +9.6% |
| 价格表估算 USD | 0.929040 | 0.932276 | +0.35% |

解释：compact 增加了 schema/guideline，且额外证据回读与更明确的 preflight 会多出调用。进程聚合和 diff 定向读取本来就能被 baseline 做到；完整源码任务不能为了降低 bytes 省略正文。缓存命中差异会影响 input/total/cost，两个重复不足以估计稳定分布。

工具结果 bytes 是已存储文本测量，不是 provider 精确 token；harness 时长包括本地工具及初始化，不是服务端延迟。USD 是模型价格表估算，不等于 Codex 订阅实际扣费。没有从 byte/4 推导 token、成本或全局收益。

## 初轮无效验收与全部用量

初轮 20 轮不能用于证明新核心：`build:pi` 更新归档和锁，但仓库 `node_modules` 尚未重装，候选核心仍是旧源码。发现后执行锁定安装，并加入 launcher installed/source gate；正式验收重新运行有明确的新环境证据，不是盲目重复未知业务写入。

初轮另有 3 个原始判分失败：回答使用 Markdown 粗体/反引号包裹数值，旧 regex 误判。文件与运行次数均正确。修复只归一化格式，不放宽 source/expected/actual 条件，补正反例单测；初轮原始状态保留于 summary，不篡改成原始通过。

| 范围 | 任务运行 | 模型请求 span | 总 tokens | 估算 USD |
|---|---:|---:|---:|---:|
| 初轮（排除正式核心结论） | 20 | 91 | 277,470 | 1.900820 |
| 正式自然 A/B | 20 | 97 | 292,154 | 1.861316 |
| 正式候选能力验收 | 6 | 42 | 121,628 | 0.481560 |
| **合计** | **46** | **230** | **691,252** | **4.243696** |

这里只统计本次 eval，不含主对话和 Goal completion reviewer 用量；用户已明确授权真实调用且不设费用预算。

## 离线 / 运行时验证

- Pi focused：`test/tool-efficiency.test.ts`、`test/tools.test.ts`、`test/powershell-tool.test.ts`、`test/edit-tool-legacy-input.test.ts`：104 pass / 1 skip。
- `build:pi`：隔离锁定构建与内置六组回归，683 pass / 3 skip；`check:pi` 通过。
- 产品 coding-policy：10 pass；eval hygiene/prompt 判分与新 Markdown 判分：9 pass；eval typecheck 通过。
- `check-personal` 最终通过：产品 313 pass、固定离线 Provider 矩阵通过、Goal 70 pass、默认 context contract PASS。没有用这些 faux/离线检查冒充真实模型。
- 真实 SDK full / scoped-full smoke：各 2 次 faux provider 调用，lifecycleErrors=0。默认/full/scoped schema 精确合同按实测增加 352 bytes、guideline 增加 227 bytes；保留旧 reference，不抬高模糊预算来掩盖回归。这些是 bytes，不是 token。
- 初次 `check-personal` 因新增 schema 的精确静态合同未同步而退出 1；已按三种实际 smoke 数值同步，再完整通过。所有其他修复和环境准备过程保留本地日志。

## 范围和交付边界

- 没有验证生产业务任务的全局省时、省钱或减少错误率；未测试真实 Chrome/手机，因为本次改动不涉及其交互。
- Codemode 返回合同由原生 structured-output 回归覆盖；这轮真实模型的工具白名单是 read/bash/edit，没有把它称作真实 Codemode 工作流验收。
- 不自动改全部命令默认输出、不恢复旧的独立 `CONTEXT_EFFICIENT_TOOL_USE_POLICY` 块或新增逐轮摘要、不重写 compaction。
- 候选源代码和可复现 Pi 归档已生成；没有 npm publish、没有升级本机全局 rotom，也没有迁移存活会话。公开合并的实际提交与远端回读由交付记录和最终回复单列，不用本地验收结果冒充已推送或已安装。

## 公开基线整合验证

从公开 main 的独立干净 clone 重放本次改动，没有推送维护仓私有历史。公开与维护面的 Subagent 完整工具合同本来不同；保留各自基线，只同步本次实测的 +352 schema bytes / +227 guideline bytes，没有用维护面的完整 schema 覆盖公开面。

公开 clone 验证：check:pi 与 installed/source identity 通过；原生 focused 104 pass / 1 skip；eval typecheck 与 9 项判分/prompt 回归通过；check-personal 的产品 312 pass、Provider 矩阵、Goal 70 pass 和默认合同通过。default/full/scoped SDK smoke 均 lifecycleErrors=0；公开面精确计量分别为：

| 表面 | 工具数 | normalized schema bytes | guideline bytes |
|---|---:|---:|---:|
| default | 24 | 22,995 | 9,328 |
| full | 25 | 37,858 | 11,950 |
| scoped-full | 25 | 39,119 | 12,443 |

公开 clone 首次 check-personal 缺少源码测试依赖 vitest；按源码锁文件安装后再通过。公开合并检查是离线/SDK 检查，未重新跑真实模型，也不冒充在不同完整工具面上的额外模型验收。

## 复跑

在 `rotom/evals`，按 README 安装评测依赖；先为 candidate 执行 `build:pi` 并按 `runtime/pi/package-lock.json` 安装，确认两臂的 `resolve-installed-pi.mjs` 通过。执行：

```sh
ROTOM_EVAL_TOOL_EFFICIENCY=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_ARTIFACT_DIR=/absolute/private/artifacts \
npm run eval -- --provider=openai-codex --model=gpt-6-astra \
  cases/tool-efficiency.eval.ts --maxWorkers=1 --testTimeout=600000
```

每次复跑需要当前有效的真实模型授权；此报告不为未来无限调用授权。
