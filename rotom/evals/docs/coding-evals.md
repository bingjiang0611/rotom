# 编码、交付与执行卫生评测

[返回评测入口](../README.md)。本页命令和反引号内的相对路径以 `rotom/evals/` 为工作目录，除非另有说明。

### 真实工具输出与执行卫生：`tool-efficiency.eval.ts`

仅经明确模型调用授权后启用。5 个实际工具任务、每臂 2 次、交替顺序，另有 3 个候选能力任务各 2 次（显式 compact 成功/失败与合成文件漂移恢复）。baseline/candidate 复用各自 launcher 的 installed/archive/source identity gate，不能仅凭相同版本号认定运行时相同；不注入假 bash/edit 返回。检查文件正确性、检查只执行一次、失败日志证据回读、逐字完整性、无关进程参数不进入输出，记录 raw tool-result bytes、调用数和 compact 使用次数。合成进程快照不是本机性能实测；bytes 不是 provider tokens。合同与边界见 [工具执行卫生与输出控制](../../../docs/agent/tool-efficiency.md)。

```sh
ROTOM_EVAL_TOOL_EFFICIENCY=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
npm run eval -- --provider=<provider> --model=<model> cases/tool-efficiency.eval.ts
```

### 规则级消融：`coding-hygiene-rule-ablation.eval.ts`

产品 A/B 只能回答“这个 build 是否合规”，不能回答“这 6 条规矩里哪几条真的改变了行为”——模型本来就会做的那几条，有没有 policy 分数都一样。该评测集因此每次撤掉一条规则并做配对比较，三臂共用 `src/coding-hygiene-cases.ts` 的题目与判分：

| 臂 | 规则 | 角色 |
|---|---|---|
| `rule-withheld` | 6 条里去掉本题对应那 1 条 | baseline |
| `policy-full` | 完整 6 条，由 eval 侧重建注入 | 重建有效性对照 |
| `product` | 完整 6 条，产品原生注入 | 真实基准 |

每题通过 `ruleAnchor` 按文本子串绑定唯一一条规则（不按下标，避免重排后静默指错对象），`resolveHygieneRule` 在匹配数不等于 1 时直接报错。撤 1 留 5 使 prompt 体积基本不变，排除“prompt 变短所以变差”的混淆。报告器现成的 `meanDelta` / `lift` 即为该条规则在该题上的贡献。

重建臂用 `inlineExtensions` 复制产品自己的 `before_agent_start` 追加路径（含 `CODING_TOOLS` 门），而不是改基础 system prompt，因此 policy 落在相同位置。`test/coding-hygiene-rule-ablation.test.ts` 用 faux provider 断言 `policy-full` 与 `product` 实际发出的 prompt **逐字节相同**（仅归一化临时 workspace 路径），并断言撤掉的那臂恰好少 1 条、其余 5 条在位；这条等式是整个消融的有效性闸门，零模型花费。

显式启用，避免普通 eval 增加费用：

```sh
ROTOM_EVAL_HYGIENE_RULE_ABLATION=1 \
ROTOM_EVAL_HYGIENE_RULE_ABLATION_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/coding-hygiene-rule-ablation.eval.ts
```

只 `product` 臂按 threshold 1 门禁；`rule-withheld` 分数更低是预期信号，不作为失败。

#### 首轮实测结论（`cc-switch / claude-opus-5`，thinking=low，每臂 2 次）

| 题（对应规则） | withheld | policy-full | product | Δ(product − withheld) |
|---|---|---|---|---|
| ambiguous edit context | 1.00 | 1.00 | 1.00 | +0.000 |
| package script preflight | 1.00 | 1.00 | 1.00 | +0.000 |
| renamed validation path | 1.00 | 1.00 | 1.00 | +0.000 |
| ripgrep no match | 1.00 | 1.00 | 1.00 | +0.000 |
| target repository root | 0.80 | 1.00 | 1.00 | +0.200 |
| timeout diagnosis | 1.00 | 1.00 | 1.00 | +0.000 |

`policy-full` 与 `product` 在全部 6 题上完全一致，重建路径有效。唯一非零差值是判分锚点产物而非行为差异：撤掉规则后模型仍然给出 `targetRoot=/workspace/app-alpha`、`assumesAggregateRoot=false`，只是首条命令用 `git -C /workspace/app-alpha status --short --branch` 而不是判分要求的 `rev-parse`。与 `ownership-handoff` 的 literal-anchor 局限同类，保留原分数另作人工解释。

因此在该模型、该 6 道计划题上，**这 6 条规则没有可测的行为效应**，与上面已归档的 `CONTEXT_EFFICIENT_TOOL_USE_POLICY` 结论同向（模型本来就在做）。**不得**据此删除任何规则：n=2、单模型，且题目全是“不执行工具、只输出计划 JSON”，按本文件既有要求，计划题不能冒充行为改变；弱模型与真实长会话未测量。要据此收窄 policy，必须先在目标模型上重建行为级证据（真实执行、天真路径真正昂贵、含反向约束题），并在多模型上一致复现。

附带发现（**未修复**）：`transformSystemPrompt` 走 loader 的 `systemPromptOverride`，它替换的是*基础* system prompt，Pi 随后仍会追加 skill 目录与 cwd 页脚。把已合成的 prompt 传进去会让页脚出现两次——首轮消融即因此使重建臂多约 700 tokens（约 1776 字符）。`computer-use-contract`、`ownership-handoff`、`lane-stale-recovery` 仍在用该选项，其历史数字都带这一重复页脚。需要追加内容时应改用 `inlineExtensions` 或 loader 的 `appendSystemPromptOverride`。

### 最终汇报结构：`final-report.eval.ts`

比较 coding-policy 的 `FINAL_REPORT_POLICY` 段。两臂都排除产品 `coding-policy`，用同一重建路径注入：`hygiene-only` 只带执行卫生规则，`with-final-report` 再追加汇报段，差异仅为该段。三道真实工具题在临时 Git 工作区运行：`fix-with-gaps`（真修复 + 无关失败测试 + 本地无法验证的网关）、`diagnose-only`（只诊断不改文件）、`simple-question`（对照题，汇报段不得把一句话答案撑长）。判分是文本锚点，只证明提到了某项，不证明清晰；结论须人工阅读 `vitest-results.json` 中保存的完整回复。

```sh
ROTOM_EVAL_FINAL_REPORT=1 \
ROTOM_EVAL_FINAL_REPORT_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/final-report.eval.ts
```

可选 `ROTOM_EVAL_FINAL_REPORT_TASK=<task-id>` 只跑一题；high thinking 下建议追加 `--testTimeout=600000`。`ROTOM_EVAL_THINKING` 默认 `medium`。`ROTOM_EVAL_FINAL_REPORT_AGENTS=/absolute/AGENTS.md` 会把该文件复制进隔离 agent 目录作为全局 context file，用于贴近真实用户配置；若系统提示中未出现其内容，该 run 直接报错。

2026-10-12 首轮（thinking=medium）平均锚点分 hygiene-only → with-final-report：

| 模型（每臂次数） | fix-with-gaps | diagnose-only | simple-question | fix 回复长度（字符） |
|---|---|---|---|---|
| `openai-codex/gpt-6.1-sol`（2） | 0.83 → 0.94 | 0.58 → 0.83 | 1.00 → 1.00 | ~150 → ~420 |
| `openai-codex/gpt-6-astra`（2） | 0.89 → 1.00 | 0.58 → 0.83 | 1.00 → 1.00 | ~155 → ~460 |
| `cc-switch/claude-opus-5-5`（1） | 0.89 → 1.00 | 0.67 → 1.00 | 1.00 → 1.00 | 690 → 981 |

人工阅读：两臂都已写出“无关失败 / 网关未验证 / 未提交”，这来自既有执行卫生规则；汇报段新增的是分段结构、改动文件清单（含新增测试）、验证命令与计数表、修复前复现失败的反向对照，以及诊断题的下一步。对照题两臂都约 56 字符，未被撑长；opus 对照题反而由 253 缩到 83。`diagnose-only` 的 `statesCiUnverified` 锚点在 GPT 两臂都未命中：回复写了“未运行安装”和“再用 `npm ci` 验证”，属锚点过严，保留原分数。首轮局限：n≤2、不加载用户 `AGENTS.md`、未覆盖长会话、未测 qoder。

第二轮（harness 支持扩展注册 provider 后补测 qoder；“真实配置”= thinking=high + 维护者全局 `AGENTS.md`，每臂 2 次）：

| 模型 / 配置 | fix-with-gaps | diagnose-only | simple-question | fix 回复长度（字符） |
|---|---|---|---|---|
| `qoder/ultimate`，medium，无 AGENTS | 0.78 → 1.00 | 0.58 → 0.67 | 1.00 → 1.00 | ~150 → ~380 |
| `qoder/ultimate`，真实配置 | 0.78 → 1.00 | 0.50 → 0.92 | 1.00 → 1.00 | ~165 → ~415 |
| `openai-codex/gpt-6.1-sol`，真实配置 | 0.78 → 1.00 | 0.58 → 0.83 | 1.00 → 1.00 | ~155 → ~390 |
| `openai-codex/gpt-6-astra`，真实配置 | 0.83 → 1.00 | 0.67 → 0.92 | 1.00 → 1.00 | ~175 → ~395 |

用户 `AGENTS.md`（含“输出清晰简洁”与“如实交付”要求）没有让 baseline 自行写出分段汇报：真实配置下 baseline 的 fix 回复仍约 150–175 字符、常缺验证计数。汇报段在四组中方向一致，对照题不变长。high thinking 下 fix 题耗时可超过默认 120s：gpt-6.1-sol 有 3 次、qoder 有 1 次超时（基础设施失败，不计分），两模型的 fix 题以 `--testTimeout=600000` 整题重跑、仅用重跑数据。仍未覆盖：长会话、真实复杂任务、opus 真实配置、判分之外的清晰度量化。

### 排查推进：`follow-through.eval.ts`

比较 coding-policy 的推进改动：新增 `FOLLOW_THROUGH_POLICY` 段，并把汇报段的“下一步”从“可选”改为“仍有未决项时必填、放最后”。改动跨两段，所以 baseline 臂注入 `ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF` 处提交的完整 policy，candidate 臂注入工作区 policy；两臂都排除产品 `coding-policy`，走同一重建路径。三道题：`archive-mismatch`（原因要跨三跳：查询键 → 无 import 指向的写入任务 → 数据，且不许改代码）、`plan-gaps`（四个缺口中三个可本地查清，其中一个只在超过 read 50KB 分页的 SQL 末尾；第四个确实受阻）、`simple-question`（对照题，不得变长或多跑工具）。`onlyPlanChanged`/`noEdits` 按相对 fixture 提交的改动判定，因为用户 `AGENTS.md` 可能让 agent 自动提交。

```sh
ROTOM_EVAL_FOLLOW_THROUGH=1 \
ROTOM_EVAL_FOLLOW_THROUGH_BASELINE_REF=<commit> \
ROTOM_EVAL_FOLLOW_THROUGH_REPEATS=2 \
npm run eval -- --provider=<provider> --model=<model> cases/follow-through.eval.ts --testTimeout=900000
```

可选 `ROTOM_EVAL_FOLLOW_THROUGH_TASK`、`ROTOM_EVAL_FOLLOW_THROUGH_AGENTS`、`ROTOM_EVAL_THINKING`，含义同上节。

2026-10-15 首轮（baseline=`2d1a250`，thinking=high，维护者全局 `AGENTS.md`）。表中为“以下一步收尾”的命中次数，即结尾 500 字符内出现提问或带审批的提议动作：

| 模型 / 题目 | baseline | candidate |
|---|---|---|
| `qoder/ultimate` archive-mismatch | 0/2 | 2/2 |
| `cc-switch/claude-opus-5-5` archive-mismatch | 0/1 | 1/1 |
| `qoder/ultimate` plan-gaps | 0/2 | 1/2 |
| `qoder/ultimate` simple-question（对照） | 回复 20–58 字符，2 次工具 | 20–72 字符，2–3 次工具 |

人工阅读：candidate 在诊断题末尾写“统一读写两端日期键并补跨午夜测试，你确认后我再修改”，且未改代码；baseline 停在“修复方向是……”或“未修改任何文件”。迭代中发现，只在新段里写“有未决项要给下一步”无效（同模型 0/2 → 1/4）：汇报段原来写的是“only when a decision or follow-up remains”，模型据此判定诊断题已完成。把规则落到汇报段本身、并点名“只要求诊断时也算未决”后才生效。plan-gaps 的 candidate 仍有 1/2 只把未决项列成“待确认”，未给负责人和动作。

未复现的部分：在这些短 fixture 上，两臂都追到了根因、读完了 50KB 之后的分区字段 `stat_day_p`。用户反馈的“浅看即停”在这里不出现，可能只在长会话或大仓库中出现。因此 `FOLLOW_THROUGH_POLICY` 中“查完再停”的规则目前没有正向证据，只有“未损害对照题”的证据。要验证需要长上下文 fixture 或真实会话回放。样本 n≤2，结论只代表方向。

2026-10-24 第二轮新增 `standing-directive`：用户说“按 PLAN 完成 M1–M5，期间不要停，做完一起交付”，随后问“目前什么进度了？”。真实 Scry 会话在这种指令下多次以“下一步由我……”结束回合。判定：五个里程碑的验收测试全部通过，且两个回合结尾都没有“接下来我会……”这类自报下一步（`SELF_OWNED_NEXT`）。

候选改动是在“继续推进”条目中加入常驻指令句：“不要停”覆盖跨回合与压缩后的全部步骤，进度询问或里程碑完成不撤销它。baseline=`3d0aa26`，`openai-codex/gpt-6-astra` 与 `gpt-6.1-sol`，thinking=high，真实 `AGENTS.md`。

最终候选每臂每题 5 次：

| 题目（两模型合计） | baseline | candidate |
|---|---|---|
| standing-directive：验收全过且两回合都不自报下一步 | 10/10 | 10/10 |
| archive-mismatch：全部检查 | 10/10 | 10/10 |
| simple-question：全部检查，回复约 57 字符、2 次工具 | 10/10 | 10/10 |
| plan-gaps：方案内容与改动范围检查 | 10/10 | 10/10 |
| plan-gaps：最后一节是未决项（脚本按最后一个粗体标题统计），astra | 5/5 | 5/5 |
| plan-gaps：同上，sol | 4/5 | 2/5 |

结论：短 fixture 上 baseline 也不停，所以该句没有正向证据。真实停顿出现在约 150k token、经过压缩的长会话中，需要长上下文回放才能验证。sol 的 candidate 仍点名了 `nick-platform` 受阻项，但 3/5 把它放在“限制”节而不是最后一节；这与跨轮 baseline 波动（3/5–4/5）部分重叠，n=5 不足以定论。

同轮还试过两种更强的写法，sol 在 plan-gaps 中“最后一节为未决项”的次数都明显下降，且没有可测收益，已撤回，汇报段保持 baseline 原文：

- 汇报段加入“最终汇报会结束回合；下一步属于自己且已授权时直接做”（即已推送的 `89cbfea`）：candidate 0/3，同轮 baseline 2/3；改为同时要求“未决项仍放最后一节”后为 1/5 对 5/5。
- 推进段再加“已授权时不要以‘我接下来会做’的汇报结束回合”：candidate 0/5，同轮 baseline 3/5。

### 历史纠正回归：`quality-regressions.eval.ts`

八个纯合成任务复现历史纠正的机制，不携带真实会话文本、ID、地址、配置或凭据。复用现有 Pi harness，模型实际读写隔离工作目录；不是只回答 JSON 选择题。

| case ID | 要检验的行为 |
|---|---|
| `finish-all-stages` | 两个阶段全部完成，不在第一阶段结束后停跑 |
| `check-real-connection-path` | 检查实际配置，不能把直连失败当成所有连接不可用 |
| `add-without-replacing` | 新增模型，保留旧配置与默认值 |
| `structured-write-evidence` | 按版本化 details 判断写入，不看成功文案 |
| `version-not-a-historical-mention` | 验证唯一当前字段，不接受历史版本命中 |
| `optional-schema-isolation` | schema 漂移仅禁用可选增强，不破坏后续注册或吞未知异常 |
| `warning-channel-boundary` | 交互通知与 Node warning 分流，不全局吞告警 |
| `authenticated-cli-success-path` | 启动和未登录检查不能替代登录后任务交付；空 diagnostics 不能冒充工具调用 |

**确定性检查（零模型）**：`npm run check:quality`。每个任务验证旧错误失败、真实修复通过、清空测试伪造绿色仍失败；另外验证只完成第一个阶段不能通过，以及 CLI 启动/未登录路径正常但登录后任务失败时仍不能通过。CLI 使用本地离线身份文件与合成协议输入，不是某个真实服务的登录验收。验收器使用评测端保存的原始断言，不信任模型修改后的 `test.mjs` 或最终回复。所有任务须同时满足行为验收与文件修改范围，不能靠部分分数获判通过。

**模型运行（需另行授权 provider、模型和预算）**：默认不开启；显式开启但缺必要配置或 case ID 错误时报错。示例从 `rotom/evals/` 执行，模型和 provider 使用已授权值：

```bash
ROTOM_EVAL_QUALITY_REGRESSIONS=1 \
ROTOM_EVAL_CANDIDATE_PRODUCT="$(cd .. && pwd)" \
ROTOM_PI="$(node ../runtime/resolve-installed-pi.mjs "$(cd .. && pwd)")" \
ROTOM_EVAL_PROVIDER="<authorized-provider>" \
ROTOM_EVAL_MODEL="<authorized-model>" \
./bin/eval cases/quality-regressions.eval.ts
```

可用 `ROTOM_EVAL_QUALITY_CASE` 选择单个 case。每个任务会产生模型和工具续轮调用，不提供费用硬上限；确定性测试另用离线脚本 provider 驱动真实 Pi 写入工具，证明文件产物确实进入验收器，并同时检查 `then_run` 成功/失败时原始 `isError`、已写入证据和文件回读保持分离；这不是模型能力评测。本轮未调用真实模型，不声称改善率或 A/B 收益。工具仍按本机权限执行，隔离目录不是 OS 沙箱。对恶意生成代码的防篡改不在验收器保证范围。

机械规则和真实 runtime 边界测试统一见 [质量规则与 Review](../../../docs/agent/verification.md#质量规则与-review)。本套任务不替代真实服务、设备、Goal/RPC 长会话及所有 TUI 告警路径的验证。
