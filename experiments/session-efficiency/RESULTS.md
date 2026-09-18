# 会话效率优化验证（2026-09-18）

## 决策

按 Goal → 工具恢复 → 上下文顺序执行。**采用 Goal 改动；不采用未证明净收益的两项运行时候选。** 不为满足“优化”而把负面结果写成提升。

- Goal：默认自动额度从 25 调至 100 次模型响应，显式保存的用户值仍优先；保留 token、无进展、取消、显式续跑和 reviewer 边界。Footer 展示剩余额度，状态/暂停页展示最后接受的续跑计划（不是进展证明，不触发重放），不增加模型总结请求。私有组件为 `0.54.4-rotom.5`，未发布 npm，也未更新活跃安装。
- 编辑恢复：曾实现最多 3 个匹配位置、每位置最多 4 行、每行 160 字符的原始源码预览；测试和付费对照后撤回。原有路径建议、匹配行号、差异提示及原子编辑约束保留。
- 上下文：仅在评测 inline extension 中试验限定目录、按窗口读取、避免重复大 diff、保留全文证据等提示。未恢复产品中曾移除的通用效率 policy，未改变 50KB 输出上限、缓存或压缩机制。

## Goal 验证

- 组件 `npm test`：67/67；`npm run check`：PASS。
- 新的真实 Pi SDK + faux provider 长任务：初始用户响应后继续 100 次自动响应，在 100 处准确暂停；明确恢复后不重放已经成功的写入，累计 tokens/time 不减少，自动 epoch 重置。此项不消耗真实模型，也不证明长业务任务整体完成率。
- 旧状态缺少新字段仍可读取；显式 25 / Unlimited 保留；下一步计划仅展示、不能自动调度。
- 隔离产品的 default/full runtime smoke 与 archive identity gate：PASS。
- `goal-pty.py` 从实际产品 launcher 启动隔离 HOME、合成保存会话，真实终端内容验证：`25/100 · 75 left`；100 次暂停后的 Review and continue 页面显示原先计划；没有 assistant 模型响应。不是桌面截图或视觉布局验证。
- 早期 PTY 脚本在 shutdown 不继续读取终端而等待退出，产生超时；改为退出期间继续 drain 并取消无界 wait。早期单元测试 fixture 未提供 usage entries，以及 SDK fixture 未区分初始用户响应/自动响应，已修正并重跑；未放宽产品门禁。

## 模型验证

同一原生认证、`openai-codex/gpt-6-astra`、`thinking=low`、macOS host 隔离临时 Git fixture；不复制凭据，无真实业务写入。每题两臂各 2 次，第二次交换臂顺序；上下文题追加同配置一组，以检查方差。模型输出不是唯一 verifier：检查真实目标文件、其他代码/填充不变、完整函数逐字包含，以及工具轨迹。

基线源码 commit 和逐运行 metadata/digest 见 [results.json](results.json)。不公开原始会话、trace、路径或凭据。artifact 中的定价估算不代表订阅账号实际扣费；**实际 USD unknown**。

### 4：工具恢复

| 场景 | 结果 | 解释 |
|---|---|---|
| 普通路径/编辑任务 | 8/8 | 路径提示有效恢复；编辑题没有出现歧义失败，不能把其调用数变化归功于新预览 |
| 要求模型先制造失败 | 4/4，但未触发所需故障 | 模型仍先读取；该阶段不用于判断提示效果，费用仍计入总量 |
| 测试端真实执行原子失败，再附实际 error/hint | 4/4 | 两边均拒绝同一歧义编辑、文件未改；随后才由模型恢复 |

最后一组平均：基线 9,344 tokens / 3 calls / 3,674 tool-result bytes；候选 9,442 tokens / 3.5 calls / 1,772 bytes。返回文本变短，但总 tokens 和往返未下降，**候选不采用**。这不证明对所有模型无用；重新引入需在目标模型的真实失败恢复中证明净收益，不能用普通题未触发 hint 的成功作证据。

`tool-error-repair.eval.ts` 新增 host-seeded 原子失败 case，默认仍需显式开启付费评测。原始普通题保留为控制组。

### 5：上下文

大 fixture 包含 24 个各超过 1,200 行的模块、有效模块清单和 legacy 干扰文件；朴素全读明显昂贵。两题分别验证限定范围求和与大文件中完整函数的逐字提取。两组共 16/16 通过。

| 题目/组 | 基线 tokens / calls | 候选 tokens / calls |
|---|---:|---:|
| 范围求和，首组 | 68,421.5 / 6.5 | 10,269.5 / 4 |
| 范围求和，确认组 | 69,499 / 7 | 67,418.5 / 6 |
| 精确源码，首组 | 8,536 / 3 | 9,176.5 / 3 |
| 精确源码，确认组 | 8,531 / 3 | 9,224 / 3 |

首组收益受一次基线大范围读取影响；确认组候选也出现大范围读取，未稳定消除高输出行为。精确源码两组均付出额外上下文开销。样本支持“该任务有时减少无关输出”，**不支持将此提示恢复为全局默认**；故不采用，而非宣称全局效率提升。升级条件：增加来自长会话、重复 diff/日志的新独立场景后，仍有稳定净收益且全文/文件变动后的读取保持正确，才讨论产品化；不增加基于命令字符串的缓存。

### 用量

全部 32 个合成任务运行（含无效故障触发阶段）共 142 条 assistant 响应，服务报告 811,156 tokens，其中 cache-read 448,000。不是新增独立正文量，也不是实际费用；不含主维护会话及最终 completion reviewer 用量。

## 最终门禁与既有失败

- `check-personal` 的产品测试 539/539、Goal 测试 67/67 通过；最后的静态 footprint gate 返回 REGRESSION，因此**整体命令不是 PASS**。公开基线独立 clone 复现相同结果：23 工具，schema 20,632 bytes、guidelines 8,963 bytes，而旧断言为 20,522 / 8,732。本次工具 schema/guidelines 没有变化。
- eval typecheck PASS；离线 suite 为 91 passed / 3 failed / 1 skipped。三项为 Qoder 已加入但资源列表断言未更新、managed-CDP 静态字节 917 与实际 946 不符、trace artifact fixture 的 metadata 形状过期。全新公开基线复现相同三项失败，未顺手修改。
- 上述基线来自公开 `main` 的同一构建基线；不是拿候选自身当旧基线。没有将这些既有失败隐藏为通过，也没有用它们证明本次模型优化有效。

## 复验

从仓库根，先按产品 lock 安装隔离 Pi/third-party 依赖；不要覆盖活跃安装。

```sh
(cd packages/rotom-goal && npm test && npm run check)
node --test rotom/runtime/third-party-archive.test.mjs
python3 experiments/session-efficiency/goal-pty.py /absolute/product /absolute/private/evidence
```

付费模型复验（需显式授权，当前归档结论不是未来调用授权）：

```sh
cd rotom/evals
ROTOM_EVAL_TOOL_ERROR_REPAIR=1 ROTOM_EVAL_TOOL_ERROR_REPAIR_REPEATS=2 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
npm run eval -- tool-error-repair.eval.ts --pi=/absolute/locked/pi \
  --provider=openai-codex --model=gpt-6-astra

ROTOM_EVAL_CONTEXT_EFFICIENCY=1 \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/product/rotom \
npm run eval -- context-efficiency.eval.ts --pi=/absolute/locked/pi \
  --provider=openai-codex --model=gpt-6-astra
```

第一条比较的是所给的两份产品；本次源码预览候选已撤回，当前产品彼此相同不能重现其候选差异。第二条只在评测侧注入实验提示，产品没有该提示。保留实验用于在新模型/新证据下复核，不承诺小样本总体收益。
