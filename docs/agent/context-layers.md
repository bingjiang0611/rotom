# Context Layers

独立实现的默认启用产品 extension，位于 `rotom/extensions/context-layers/`。不加载旧实现，不增加代理或数据库，不修改 Pi fork，不增加独立摘要模型。`ROTOM_CONTEXT_LAYERS=0` 关闭工具和提醒；已存在的 Pi `context_edit` 仍由 Pi 投影，不隐式展开历史。

## 端到端链路

```text
session 原始条目（不修改）
  → buildSessionProjection → 划分完整步骤 → context_status
  → 模型编写摘要 → context_compress 校验并排队
  → 成功的 turn_end 再校验 → 追加块记录、摘要替换、原文隐藏、回执
  → Pi 刷新上下文 → 下一次请求只见摘要与近期原文

context_recall → 当前分支原始条目 → 分页工具结果（不展开旧前缀）
```

- 工具为 `context_status`、`context_compress`、`context_recall`，均 sequential、model-only。尊重显式工具选择；没有三工具的完整 active set 时不注入提醒。deferred loader 原有“保留非 deferred 工具”合同已覆盖，不新增分组。
- 步骤是用户消息，或助手消息及其全部工具结果。工具调用/结果不配对、已错误/中止的助手步骤不可压缩。系统提示和工具声明不参与压缩。保护第一条、最新用户请求以及最近四个步骤；当前长任务中已经结束的更早步骤仍可压缩。
- 首轮只压新完成的连续步骤。两个以上连续、同层活跃块可合并，最多三层；单块可改写，保留同层级和原始覆盖关系。新记录引用旧块，不修改旧记录。三级仍可改写，但不继续升层；达到此限制且无法缩小时交给 Pi 原生压缩，不假装无限容量。
- `context_status` 分页列出摘要块及可压范围，`query` 搜索当前分支摘要和原始文本。候选范围每组最多 16 步，只是展示单位，不丢历史。
- 净收益依据 Pi 原生 token 估算，不是计费量；计入摘要标记本身。零收益、负收益、重叠排队、外部编辑或待提交区间变化均拒绝。
- 从估算占用 30% 起，且有 ≥1024 可压 token 或至少两个活跃块时提醒；重复提醒须继续增长至少 `max(1024, 5% window)`。提醒只追加到当前请求末尾，不写 session，不强制循环或自动重试。30% 选在 32K 小窗口常见原生压缩余量之前；不是保证先于所有用户自定义阈值。

## 恢复与一致性

- 原文来自当前分支的 session 消息。`one` 返回子块摘要和本层直接原文；`full` 返回覆盖范围全部可呈现原始内容。可用 `@entryId` 精确回查。工具参数、错误标记、call ID 保留；provider-private thinking/signature 不作为工具文本回显，原始 session 不变。
- 文本页约 12000 UTF-16 字符，避免拆开代理对；图片单独分页，保持原始 mime/data。图片页遇到文本模型明确报错，不静默转文字。`nextOffset=null` 与 `complete=true` 只描述选定视图；query 结果标为 matching-parts，不冒充全文。
- session 启动、切换、分支切换、原生压缩与 shutdown 清除内存待提交项和提醒计数。块状态由当前分支及 Pi 可见投影重建，不从其他分支恢复。原生压缩覆盖的块标为 archived，只要原文仍在分支就可回查。
- Pi boundary 会预览草稿，但其 session 多条追加**不是磁盘事务**。因此记录顺序是块来源 → 摘要 → 隐藏原文 → 回执。进程中断最多留下重复上下文或 partial 状态，不先删原文再补摘要。每个中间前缀都有负向测试；不自动重放 partial 写入。`context_status` 暴露 partial，仍可回查；需要恢复一致可由用户另行执行原生 `/compact`，不静默修复。
- 其他 boundary handler 的冲突编辑/压缩会令本次队列拒绝。取消或 provider error 不提交可见性变更。排队回执不冒充成功，最终 applied 回执位于全部 edits 之后。
- 无独立内容日志。业务历史仍只在用户已有的 Pi session 存储中；没有新增 trace 内容记录。

## 验证（2026-10-20）

验证使用独立公开基线 clone 及其按 lock 新安装的 `1.3.0-rotom.2`，不覆盖存活安装。维护 checkout 原有 Pi installed source 摘要漂移、Subagent WIP 与 installed version 不一致曾使产品 gate 拒绝；独立 clone 没有这两个问题。无需为本次 extension 重建 Pi。

- `index.test.ts`：8/8。真实 SDK/faux 工具循环、增量/三级合并/改写、磁盘重启、分支切换、原生压缩后回查、中止、外部编辑冲突、每个中断写入前缀、工具配对、净收益、分页/Unicode/图片、provider-private reasoning 不外露。
- TypeScript strict/noEmit：四个运行时文件通过，使用固定 Pi 的类型及 TypeBox。
- launcher identity/resource：39/39；distribution：25/25；默认、全工具模式、Layers 关闭模式三组真实 loader smoke 通过，三工具实际 active 且 model-only，未改变默认模型。eval product-resource 测试 8 通过、1 个未配置 stock sidecar 的既有 skip。
- Harbor adapter suite 7 通过、2 失败（fixture 缺少 `bin/rotom`）；在未修改的公开 HEAD 导出副本重跑得到相同两处失败，未为此扩大修复。系统 Python 未装 Harbor 的首次尝试不作为测试结果，实际 suite 使用项目脚本指定的 Harbor Python。
- Qoder `dfmodel` 真实请求：最终四次有界运行均完成精确文件写入；候选 2/2 完成“压缩 → 磁盘重启 → 回查 → 写 result.json”。验收先确认两项随机细节不存在于任何模型可见消息，然后独立校验输出文件字节对应值，不以工具调用成功代替恢复。

| 轮次 | 模式 | 模型请求 | 服务端报告 credits | 原文回查验收 |
|---|---|---:|---:|---|
| 1 | Layers | 6 | 0.232638 | 通过 |
| 1 | 原生对照 | 3 | 0.159560 | 直接可见原文，输出通过 |
| 2 | 原生对照 | 3 | 0.154841 | 直接可见原文，输出通过 |
| 2 | Layers | 7 | 0.239635 | 通过 |

完整 metadata 见 [verification JSON](context-layers-verification.json)。候选在压缩提交前后估算输入约 `14657 → 3429`、`14626 → 3452`；最终这组 fixture credits 合计约 **0.786674 Cr**，候选/对照约 **1.502×**。两组都未触发原生压缩，因此这不是“优于原生压缩算法”的实证，不作省钱或统计显著性宣称。按用户明确要求默认开启，用途是控制上下文并保持回查能力。

保留失败：最初 live harness 重用了已 dispose session 的 extension 闭包，并把合成历史误标为 Qoder 历史，触发 stale context / unbound session 拒绝；修复为每次重开重载资源、独立 runtime，合成历史明确用 fixture provider。早期一轮候选通过，另一轮模型把测试 key 保留在摘要中，未满足 hidden-answer 控制；最终改为在压缩后选择确实不在可见消息中的随机观察值，没有删除隐藏性检查。早期已报告约 0.819519 Cr；第一次通过隐藏答案控制的四次运行已报告约 0.813299 Cr。自审修复“成功压缩后重置提醒增长基准”，补回归并重新跑最终四次，结果如上表。本次所有有界运行已报告合计约 2.419491 Cr，非完整账号账单，USD unknown。

L3 范围为 Qoder + Layers + 原生 read/write，禁用独立付费 Reducer，避免超出本次 Qoder 费用授权。完整默认工具加载由离线产品 smoke 验证。该轮未覆盖真实图片往返和多轮压力；补充实测见下节。多日长期会话、多 Provider 和 Windows 仍未实测。摘要语义和模型何时回查仍依赖模型，不由状态一致性证明。

## 图片与长会话对照（2026-10-20）

**结论：功能 PASS；本次长会话费用比原生对照高约 30.2%，不能宣称省钱。** 使用公开 commit `6c4c072` 的独立干净安装、Qoder `dfmodel`、原始 272000 上下文窗口及默认原生压缩参数，没有缩小窗口来人为提前触发压缩。只开启 Qoder、原生 read/write，以及候选组的 Layers；不包含另行付费的 Reducer。这是压缩机制对照，不是完整默认 rotom 工具组合的 A/B。

### 真实图片往返

两种来源各用一张随机 500×500 PNG 色块图，逐像素构造独立答案。先真实送给 Provider，再加入明确标为 fixture 的 10 个历史填充步骤，主动压缩并从磁盘重启。回查前确认原图字节及 image 内容均不在可见上下文；独立检查最终 JSON 中红、蓝色块的位置。

| 场景 | Layers | 原生压缩 | Layers / 原生 credits |
|---|---|---|---:|
| 原图文件仍在 | 正确；最终重新读文件 | 正确；重新读文件 | 0.909457 / 0.532809 |
| 只有会话附件 | 正确；`context_recall` 返回原始图片字节，Provider 正确识别 | 明确报告无法恢复，没有猜测 | 0.896119 / 0.535325 |

对应实际模型请求为 10/7 次、8/6 次，包含原生摘要请求。附件对照仅允许 read/write，未提供 session 文件路径；**不意味着原生压缩删除了 JSONL 中的原图**。Layers 的实测优势是提供了模型可直接调用的原图恢复路径。文件仍在时，两者都能完成任务，Layers 并不更省。

初版验收误把“原图条目还有投影消息”当作“原图仍可见”，没有考虑该条目可成为摘要载体。已改成检查像素字节与 image 内容；恢复原图的负向对照会失败。只重测附件对照，未改产品实现。最终图片组报告 2.873710 Cr；含被替代的附件诊断组共 4.263866 Cr。

### 32 轮真实长会话

两组读取相同的 32 个合成文件，每个 600 行、低于 read 的 50 KB 上限；每轮真实调用模型读文件、写校验 JSON，并独立检查精确值。不是把 32 轮假助手记录塞进历史。第 11、22 轮后重启；最后再次重启，选取当前可见内容中不存在的早期细节，恢复证据并写最终结果。原始文件在两组中都保留，原生对照可以正常重新读取。

| 指标 | 原生压缩 | Layers |
|---|---:|---:|
| 正确完成文件任务 | 32/32 | 32/32 |
| 重启后的隐藏细节回查 | 通过 | 通过 |
| 原生自动压缩 | 2 次（默认阈值） | 0 次 |
| Layers 块 / 压缩工具调用 | — | 18 / 25 |
| 实际模型请求，含摘要 | 103 | 142 |
| Pi 记录的上下文观测峰值 | 266038 | 142810 |
| 服务端报告 credits | 10.309560 | 13.426778 |

两组最终回查都通过原生 read 取证，**不把长会话最终回查冒充 `context_recall` 验证**；图片附件组才证明真实图片回查链路。18 个块是增量压缩实证，不代表真实 Provider 已覆盖全部三级合并路径。三级合并仍由确定性测试覆盖。

候选组在初始整组 20 Cr 软限额附近中断：进度计数记到 24 轮，但第 25 个输出也已写完且逐值核验正确。保留会话，以额外最多 5 Cr 接续；跳过全部 25 个已验证输出，只执行剩余 7 轮和最终回查，没有重放写入。接续实际 3.276740 Cr，已包含在候选总费用内。原生组重启 3 次，候选组另多 1 次预算接续重启；因此成本比与耗时有该干扰因素。两组有效运行段累计耗时分别约 300 秒和 404 秒，候选数字不含接续之间的人工诊断间隔，不作为延迟收益结论。

同时修复测试 harness 的预算守卫：SDK 会报告并吞掉 observer 抛错，单独 throw 不能中断工具循环；现在先显式 abort，再报错，未知计费也停止。最终 runner 的整组软限额为 30 Cr，仍不是服务端硬账单上限。新增预算测试 2/2；移除 abort 后负向对照按预期失败。产品 extension 测试仍为 8/8。守卫修正是测试代码变更，不是 Context Layers 产品修复。

本次全部图片、长会话及诊断已报告 **28.000204 Cr**，unknown 计量为 0，USD unknown，非完整账号账单。完整 metadata 和原始报告摘要见 [stress verification JSON](context-layers-stress-verification.json)。单个配对长任务、两张最终 PNG 样本不支持统计显著性或普遍费用结论；多日会话、其他图片格式/内容、其他 Provider 和完整默认工具组合仍未测。Context 峰值是 Pi 的采样观测，不是完整 Provider token trace；预算 observer 抛错时遗漏了 3 次主请求前采样，但其服务端 credits 和请求数已计入。

## 重复验证

```sh
# 在已按锁安装 Pi/third-party 的 checkout 根目录：
node --experimental-strip-types --test rotom/extensions/context-layers/index.test.ts
# 需要明确 Qoder credits 授权；不读凭据文件，不回退模型，不自动重试：
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node rotom/extensions/context-layers/live.mjs \
  "$PWD/rotom" /absolute/private/results.json dfmodel
# 图片与 32 轮真实长会话；两条独立执行，不并发：
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node experiments/context-layers/stress.mjs \
  "$PWD/rotom" /absolute/private/images.json images
ROTOM_CONTEXT_LIVE=1 ROTOM_OBSERVABILITY=0 node experiments/context-layers/stress.mjs \
  "$PWD/rotom" /absolute/private/long.json long
node --test experiments/context-layers/budget.test.mjs
```

Live harness 每次最多 12 次请求、20 次工具执行，每个 prompt 180 秒截止；一轮失败立即停止并保留私有诊断目录，不重放已有成功写入。每次 AgentSession 单独加载 extension，正常结果只记录计量与摘要，不保存任务内容。验证脚本和测试不进入产品 package files。新 `stress.mjs` 每个对照臂最多 180 次主请求、每 prompt 180 秒、整个套件 45 分钟/30 Cr 软保护；计量在请求完成后获得，保护不保证零超支。失败保留私有诊断目录，默认不自动续跑或重放；`images attachment-only` 可单独重测附件场景。
