# 任务 05：校准判定与回放设计（零费用）

## 结论与范围

基于任务说明提交 `f0660170042cbe1392f782629ad95dfed7ec56a8`，完成 A→B→C→D。A 没有推翻十六进制 fixture 被 chars/4 低估的假设，因此继续 B；但 **04b 当时的拒绝原因仍无法追溯**，不能把本次代理分词和 faux 复现当作历史根因证明。

本轮真实推理请求为 **0**。没有复用 04b 授权、发布 npm、升级 rotom 产品版本、修改 Pi fork / trace 合同或覆盖活跃安装。rotom 默认仍关闭 Compaction Offload。只在任务 worktree 安装开发依赖和新组件归档。

04b 授权常量已置为 `null`，旧本地 receipt 保留。当前 live 入口即使给出旧模型/次数参数也会在创建 campaign 前拒绝；测试中的授权均为显式合成记录，runtime 为 faux 或注册桩，不是新授权。

## A. 先补决定证据

### 实现

- Observation Pack 的每次 threshold 决定记录 `before`、`after`、`T`、`candidates`、`originalBytes`。覆盖 `defer`、`defer_stale`、`native`；native 同时记录拒绝原因。
- `defer_stale` 不重扫候选，故本次候选数/字节为 0，`after` 沿用已确认卸载记录。它不表示又卸载了一批数据。
- eval 在输出及 shutdown 阶段、临时 session 清理前读取 ledger，存入 `ReplayMetrics.offloadDecisions`。只复制枚举/数值白名单，不复制正文、原始 ledger 行或错误正文。
- baseline 没启用 offload，决定数组为空；candidate 的决定条数必须对应 threshold 事件数。未来 live campaign 若缺记录，会保留 failed 行并停止后续请求；没有更早熔断原因时记为 `decision-ledger-incomplete`，不把缺失记录冒充成功。
- 零费用集成测试从实际产品 loader + faux session 采集推迟、`insufficient_savings`、`no_candidates`；另测 stale 元数据、正文不导出及读取后清理文件不丢指标。

### 对初步诊断的核对

源码链路证实：`tokensBefore` 可来自最近有效 provider usage 加尾部估算；旧 `saved` 来自候选及占位符的 chars/4。旧减法把两种估算尺度直接相减。Pi 在没有有效新 usage 等情况下会自行退回投影估算，本次没有改变该规则。

使用本机已有 tiktoken 和公开 `o200k_base` 词表做本地分词，没有调用推理服务、没有新增项目依赖。词表来自 OpenAI 公共 blob，SHA-256 为 `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`；下载后按已知摘要核验，分词过程禁止网络。

| 文本 | 字符数 | chars/4（向上取整） | 本地 o200k 分词 |
|---|---:|---:|---:|
| 04b 的 module-0 合成内容 | 6,145 | 1,537 | 3,532 |
| 等长普通英文注释对照 | 6,145 | 1,537 | 1,064 |

十六进制样本的代理 token 数约为估算的 **2.30 倍**，与诊断方向一致。普通英文对照反而被高估，不能泛称“真实代码/日志总被低估”。**没有证明 Luna 使用这个 tokenizer，也没有恢复 04b 已删除的 ledger。** 因而结论是“尺度不一致有源码证据，密集文本有代理证据”，不是“已确认 04b 两次拒绝都是 insufficient_savings”。没有发现足以触发停下条件的反证。

## B. 同尺度校准与组件交付

改为：

```text
ratio = savedEstimate / contextEstimate
after = preparation.tokensBefore × (1 − ratio)
defer iff after ≤ 0.6 × T
```

`contextEstimate` 复用 Pi 的当前分支投影及逐消息 chars/4 估算，再投影已经确认的 offload。系统上下文使用 `getCurrentSystemMessage` 合并 content、section 替换和工具增删，不只取最后一条 system；没有持久系统消息时才使用当前 system prompt。不会把已有 provider usage 当分母。

候选规则、对象/记录持久化合同、旧 usage 锚点、原文保留及原有投影行为不变；没有用 clamp 强制通过。现有 TUI 继续显示原 chars/4 节省估算，校准的是推迟判定。分母不是 provider tokenizer，也不模拟其他任意 extension 的瞬时 context 变换。

回归检查：

- 相同候选分别用十六进制及普通代码构造，比较旧减法与新公式；`before` 从 1 倍变为 2.3 倍时，新公式在这两个样本中均保持可推迟，旧算法改判原生。
- 同时测试 100 倍压力必须回原生：**任意放大 before 都保证结论不变并不成立，也不应成为合同。** `T` 固定时，剩余估算最终必须超过目标线。
- 系统 section 替换、工具删除/增加被正确合并。仅取最后 system 消息的负对照会失败。
- 恢复旧减法的负对照：两种密度回归 2/2 失败。system-delta 负对照：对应 1 个回归失败。已恢复正确实现。
- 原候选边界测试仅移到独立 selection 文件，未删除；主测试文件因此保持在大小门禁内。TUI 测试改为独立核对未改变的 chars/4 显示，而非把显示值与新判定差值混为一谈。

组件升级为 `sol-pi@0.1.0-rotom.5`；同步组件 manifest/lock、第三方 manifest/lock、`product-config.mjs`、vendor README、UPSTREAM、配置说明及 notices。按既有惯例删除被替代的 `.rotom.4` tgz，历史仍在 Git 中。

最终归档：

- `rotom/extensions/third-party/vendor/sol-pi-0.1.0-rotom.5.tgz`
- 37 文件；压缩 53,846 bytes，解包 183,589 bytes。
- SHA-256：`7d5fd22000bcdf2aa2159cfc0207b7f5566ead846c5fce321116aea48222ffc6`。
- SRI 见同步后的 lock / product config / vendor README；最终归档经重新安装与实际 loader 验证，不以旧安装结果替代。额外逐文件比较，37 个归档文件均与当前组件源码逐字节一致。

## C. 重设压力与保留比例

- 两臂都固定 `T=64,000`，`keepRecentTokens=round(T×0.08)=5,120`，reserve 仍为实际模型窗口减 T。目的是接近生产保留比例，不是改变 0.6 目标以帮助 candidate。
- 三个任务各 80 份材料，固定种子生成代码片段、日志、JSON 混合文本，不再使用整行十六进制填充。单份 8,218–8,324 bytes，仍在 1.5–10 KiB 范围内。
- 保留先读、后给交付要求的两阶段结构，及 `deferred-exact` 在中段放置精确字符串、压缩后找回的检查。提示词仍不指导模型选择 offload 或 obs_recall。
- 两臂仍只差 `ROTOM_COMPACTION_OFFLOAD`；thinking、工具、settings、隔离配置相同；Reducer / online compact 仍关闭。
- 新增每轮 10 个独立 read 的 faux 脚本。检查确实依次读到 10、20、…、80，而不是只改轮数计数。

每个表格单元为一次零费用运行，不代表真实模型行为：

| 任务 | 材料总 bytes | 单读 baseline native / candidate defer | 10 读一轮 baseline native / candidate defer | 首次阈值 assistant 轮数：单读 / 批读 |
|---|---:|---:|---:|---:|
| config-aggregate | 661,079 | 2 / 3 | 3 / 3 | 30 / 4 |
| deferred-exact | 661,460 | 2 / 3 | 3 / 3 | 30 / 4 |
| multi-file-fix | 661,190 | 3 / 3 | 3 / 3 | 30 / 4 |

这些运行均判分正确。candidate 每次单读卸载 78 个结果、批读卸载 61 个结果，均成功从 offload 对象回取 1 次。数量含符合条件的 manifest。批读首次决定的候选数为 21，之后各 20；每次决定均记录前后估算、阈值及原文字节。

实际执行的 faux N=3 case 为 18/18 通过；逐行核验全部触发 threshold、usage 完整。合计 48 次 threshold（21 native、27 defer），702 个卸载结果。candidate 决定数组条数与事件数相等。

**限制与升级条件**：只证明上述固定脚本（单读或每轮 10 读）越过阈值，不保证真实模型遵循阅读顺序、不跳读、不合并为更大且被截断的输出。未来 live 若某行虽判分正确却没有 threshold，会保存 `failed / threshold-not-reached`，后续行 `not-run`，不继续花完预算或自动补采。进一步确认真实覆盖率与卸载收益须另获授权。

## D. 新的费用/额度预估（不是授权）

以下以未来仍用 `openai-codex/gpt-5.6-luna`、thinking=low、N=3（18 行）、SSE/maxRetries=0 为规划假设。当前没有执行许可，美元单价/实际费用仍 unknown。

### 校准依据

04b 已有真实数据：219 请求，input 1,091,987、cacheRead 2,756,352、cacheWrite 0、output 34,251。合计输入 3,848,339，cacheRead 占 **71.62%**；每行约 12 请求。仅重读本地指标，没有读取或提交模型输出正文。

新的零费用量级：

| 脚本按 N=3 计 | 请求 | input 代理 | cacheRead | cacheWrite | output 代理 |
|---|---:|---:|---:|---:|---:|
| 每轮 10 读 | 285 | 10,024,977 | 0 | 0 | 53,889 |
| 每轮 1 读 | 1,575 | 54,639,384 | 0 | 0 | 54,093 |

批读按六次运行乘 3；单读也与实际 18 行 faux 的 token 总和一致。faux 故意不缓存，**0 不是预测真实缓存为 0**。新的材料在本地 o200k 下总 token / chars/4 为 1.251–1.254，比旧十六进制样本更接近，但仍不是 Luna 的计数证明。

### 可复算的规划区间

- 请求中心交叉检查：`219×80/48 + (27−4) = 388`。后项用新批读 baseline 的摘要请求量替换 04b 的 4 次摘要；这是规模假设，不是对真实轮数的拟合。
- 以新批读每请求输入代理、388 请求及 1.25 分词代理系数估计，中心合计输入约 **17.06M**。沿用历史缓存比例时约 input **4.84M**、cacheRead **12.22M**、cacheWrite **0**。以历史每请求 output 校准，中心 output 约 **60.7K**。
- 合计输入宽情景：`10,024,977×0.75` 至 `54,639,384×1.5`，即约 **7.52M–81.96M**。0.75/1.5 是密度、额外上下文及轨迹变化的敏感性假设，不是统计置信区间。
- 请求范围从 285 到 `1,575×1.25≈1,969`，后者给逐文件路径留额外规划余量。真实模型可能超出，不能把 faux 当上界。

| 分项 | 规划情景区间 | 限定 |
|---|---:|---|
| input（未缓存输入） | 约 1.50M–81.96M | 允许冷缓存；与 cacheRead 共同分配同一合计输入 I |
| cacheRead | 0–约 65.57M | 敏感性比例 r=0–0.8，历史为 0.7162；不保证命中 |
| cacheWrite | 0（当前路由的历史观测） | 不是其他 provider 的保证；若报告非零仍计入共享输入预算 |
| output | 约 27K–320K | 下端约为 faux 输出的一半，考虑真实模型用 edit 而非整文件 write；上端按历史 output/请求及高请求情景取整 |

分项端点不可独立相加：同一情景中 `input=(1−r)×I`、`cacheRead=r×I`。冷缓存会改变分项和价格，不改变 I。没有可靠美元报价，因此不换算金额、不写 $0。

**建议下一次新授权上限**：最多 18 行、**2,000 请求**、**100,000,000 合计输入 tokens**（input+cacheRead+cacheWrite）。这与旧额度的数值相同，但推导来自新压力范围，**不是复活旧授权**。现有熔断器没有独立 output 上限；输出区间仅用于规划。输入 usage 在请求后返回，已准入/在途请求可能越过 token 线；请求上限仍在派发前守住 N+1。发生失败/熔断只保存已知指标，是否另开一次须 bob 再确认。

## 验收与自审

环境：Node `v24.18.0`；组件开发依赖 Pi `1.3.0`；产品测试实际选用 Pi `1.4.0-rotom.2`。以下结果均为 L1 / 本地 faux L2，不是 L3。

| 检查 | 结果 |
|---|---|
| SoL-Pi `npm ci` / `npm run typecheck` | 通过 |
| SoL-Pi `npm test` | exit 1：207 passed；仅 2 个已知 install-guide 失败，缺未导入的 AGENTS.md / CLAUDE.md；未新增 skip 或伪造文件 |
| `npm pack --dry-run` 与实际 pack / 安装 | 通过；最终归档摘要见 B |
| 第三方 `index.test.ts` | 18/18 |
| 归档、Pi identity、footprint、deferred register | 74/74；最终归档复验通过 |
| public loader / footprint | deferred=0/1 × offload=0/1 四组均 PASS；活跃工具 29/28，两种 offload 值不改变工具面 |
| `compaction-offload-eval.test.ts` | 18/18，含批读及拒绝原因采集 |
| live / entry 专项 | 23/23，全是 faux/桩；含旧授权关闭、未过阈值及缺 ledger 时停下 |
| 明确 LIVE=0 的 N=3 case | 18/18；逐行核对事件、usage 与决定覆盖 |
| eval `npm test` / `npm run typecheck` | 139 passed / 1 既有 sidecar 条件 skip（未设 ROTOM_TEST_SIDECAR）；typecheck 通过 |
| 负对照 | 旧减法的两个密度测试失败；只取最后 system 的测试失败；均已恢复 |
| diff / 大小门禁 | `git diff --check origin/main...HEAD`、当前暂存 diff、staged-file-size 均通过；未复用历史 README 临时豁免 |
| public tracked-tree audit | PASS：7,821 项，0 findings；含最终 tgz |
| public history audit | 仍 BLOCKED 于已接受的 12 项旧作者/提交者身份问题；逐项对照前次报告完全相同，无新增，不宣称全绿 |

验收命令按任务执行。第三方安装额外固定 `--registry=https://registry.npmjs.org`：未固定时本机 registry 策略把锁内公共 tarball 判为 remote，报 EALLOWREMOTE；没有关闭该安全策略、绕过 integrity 或改锁来消错。

```sh
# packages/rotom-sol-pi
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run typecheck
npm test
npm pack --dry-run

# rotom/extensions/third-party
npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never --registry=https://registry.npmjs.org
# PI 指本 worktree 产品 runtime/pi/.../dist/bundle/cli.js 的绝对路径
ROTOM_PI="$PI" ROTOM_TEST_PI="$PI" ROTOM_VERIFIED_PI_EXECUTABLE="$PI" \
  node --experimental-strip-types --test --test-concurrency=1 index.test.ts

# rotom/evals
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npx vitest run test/compaction-offload-eval.test.ts
npx vitest run --config vitest.test.config.ts test/compaction-offload-live.test.ts test/compaction-offload-entry.test.ts
ROTOM_EVAL_COMPACTION_OFFLOAD=1 ROTOM_EVAL_COMPACTION_OFFLOAD_LIVE=0 \
  ROTOM_EVAL_PROVIDER=rotom-offload-faux ROTOM_EVAL_MODEL=replay \
  npx vitest run cases/compaction-offload.eval.ts
PI="$(cd ../runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle && pwd -P)/cli.js"
ROTOM_PI="$PI" ROTOM_TEST_PI="$PI" npm test
npm run typecheck
```

identity/footprint/public loader 命令沿用任务 02 报告；使用隔离 HOME、清空 Subagent scope/temp-root，并去掉继承的 PI_CODING_AGENT_DIR。串接多项检查的一次外层 300s 调用中断于全量 eval；已检查前序日志及进程，前序专项和 N=3 均完成、没有残留评测进程，仅单独重跑未完成的全量 eval，最终通过。未放宽测试超时、未重跑真实 campaign。

提交前已审查最终代码/配置 diff；修正了系统 delta 不能只取最后一条的问题，并补负对照。候选边界、缓存验证及持久化测试保留，最后的 offload 专项 35/35。阶段 04a 的历史默认值不作为本次 05 配置依据。

证据保存在本机 `/tmp/rotom-offload-05.FiXtBc/`：验收日志、负对照、faux JSON、公开词表摘要、`A-tokenizer.json`、`planning.json` 及复算脚本。旧 04b JSONL/receipt 仍在原私有目录。它们不进入提交。

## 偏差、限制与交接

- 为防止“18 行全正确但没有压缩”的重复假阳性，增加 live 的 threshold 覆盖及决定覆盖停止条件；不改变任务正确性字段，不重试、不补采。
- 已消费授权置空；预算测试改用本地合成授权。没有新增许可或扩大现有费用范围。
- 本轮无法证明真实模型覆盖率、Luna tokenizer、真实等待/缓存/美元收益；04b 拒绝原因仍未知。新分母仍是整体密度近似，不保证所有文本部分具有相同密度。
- 规划者负责核验本报告及 diff。通过后由规划者准备新的授权记录，再由 bob 明确授权任务 06。执行者不会自行开启第二次真实回放。
