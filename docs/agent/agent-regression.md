# 真实失败回归

维护入口：`/skill:agent-regression`。两个工作流：**新失败入集**与**修改后对比冻结基线**。复用 `rotom/evals` 的真实 Pi harness、manifest 和比较报告；不恢复已撤销的 session replay、标注服务或 dashboard。

## Git 中保存什么

- `rotom/evals/src/session-identity-regressions.ts`：三个明确标记为虚构的派生 fixture、任务和独立验收。
- `rotom/evals/cases/session-identity.eval.ts`：真实多步、原生只读工具、baseline/candidate 同输入对比。
- `rotom/evals/test/session-identity-regressions.test.ts`：判定器反例、路径与文件完整性检查。
- `.agents/skills/agent-regression/`：本仓库维护 skill，不进入产品包。

真实会话、截图、账号数据和运行产物不提交。原始探索记录继续放在私有 `~/.rotom/evals/reviews/`；它不是本套用例运行的依赖。默认模型运行产物在已忽略的 `rotom/evals/.eval/`，也可用 `ROTOM_EVAL_ARTIFACT_DIR` 指定仓库外私有目录。Git diff 和 privacy audit 不能证明不存在所有敏感信息，仍需人工审查脱敏边界。

## 新失败入集

1. 固定**用户目标、实际错误、证据、运行版本、允许的操作和预期结果**。缺证据标 unknown；余额不足、网络故障等与模型决策失败分开。
2. 找最近的现有 suite。将真实证据转成最小、明确标记的脱敏派生场景；替换人物、设备、项目、ID、路径，但保留失败机制。不能把改写后的输入称为原始会话重放。
3. 写模型不可见的验收。优先检查最终文件、环境和工具完成事件，不靠“我已经成功”的文本或 judge 信心。保留一个正确控制、一个已观察错误的反例，并证明后者不能通过。
4. 加入稳定 case ID、任务、fixture 和 judge；本套三个 case 在同一源文件集中定义，suite 自动发现。检查任务/工具能否表达新失败：只读身份查找以外的任务应扩展合适的现有 suite，不能强塞成本套 JSON 协议。需要真实设备或写操作时单列授权和外部验收，不自动重放。
5. 跑离线测试，审查新增内容后提交。付费运行、发送私人内容和外部写入分别确认授权；本次任务的授权不变成 skill 的永久权限。

没有可靠 oracle 时，保留私有待确认记录，不加入已通过/失败分母。LLM judge 只能辅助开放文本复核；本次观察到 Jev 对错误身份的高置信度误判，不能按 confidence 自动放行。

## 当前稳定套件的边界

| Case | 目标 | 验收 |
| --- | --- | --- |
| `local-exact` | 本地唯一首消息 | found + 对应 Pi 原生 ID，不是 canonical ref 或当前进程 ID |
| `remote-unavailable` | 本地快照没有所需远端目录 | unknown + null；不推断远端不存在 |
| `local-ambiguous` | 本地项目有多个候选 | ambiguous + null；不猜一个 ID |

每次运行创建临时工作区。模型只有 `read`，路径限定为三个不可变 fixture；拒绝越界、文件 symlink、内容漂移和局部读取。显式 `offset=1`、足以覆盖全文件的 `limit` 仍是完整读取。必须实际读完并引用 `session-refs.json` 与 `native-sessions.json`，工具结果正文须与冻结内容一致，正常终止且返回符合合同的答案。期望答案不写入工作区。

已知失败的只读调用可以纠正，失败调用本身不能充当证据。所有工具错误（包括门禁拒绝）由原生 session 独立计数，记入 judge metadata；正确性与工具错误数分开评估，不因最终答对而隐藏中途错误。

这检查的是受控文本查找，不是完整生产会话、视觉识别或真实远端目录查询。模型需遵守结构化答案协议；judge 不证明自然语言理由的全部语义正确。扩展代码仍以宿主权限运行，路径门禁不是 OS 沙箱。

每个样本最多六个模型 turn、120 秒；自动 retry/compaction 关闭。repetitions 允许 1–5，默认 2。完整默认运行有 **3 cases × 2 arms × 2 repetitions = 12 个样本**。这是调用/时间限制，不是美元硬预算；成本依赖实际 usage 与 provider。

## 修改后运行与比较

先读 [eval README](../../rotom/evals/README.md) 安装维护依赖和产品运行时。两个产品目录必须已准备好，通过各自 `runtime/resolve-installed-pi.mjs` 的 identity gate；不搜索全局 Pi，不覆盖存活安装。

在仓库根运行离线检查，不调用模型：

```sh
npm --prefix rotom/evals test -- test/session-identity-regressions.test.ts
npm --prefix rotom/evals run typecheck
```

取得模型、数据发送与预算授权后，固定两个产品目录，运行同一版本的 suite：

```sh
ROTOM_EVAL_SESSION_IDENTITY=1 \
ROTOM_EVAL_BASELINE_PRODUCT=/absolute/frozen-baseline/rotom \
ROTOM_EVAL_CANDIDATE_PRODUCT=/absolute/candidate/rotom \
ROTOM_EVAL_REPEATS=2 \
npm --prefix rotom/evals run eval -- \
  --provider YOUR_PROVIDER --model YOUR_MODEL cases/session-identity.eval.ts
```

可用 `ROTOM_EVAL_IDENTITY_CASE=local-exact` 只跑一个 case；未知 ID、缺模型或缺产品根会报错，不能静默当作成功。未设置 enable 时 suite 会跳过，**skip 不是通过**。同一目录填两次只适用于 A/A runner smoke，不证明修改收益。

比较报告是产物目录中的 `comparisons.json`，原始结果为 `vitest-results.json`，另有 harness manifest 和 session 证据。保持 case、judge、模型、thinking=high、工具、fixture、重复数一致；按重复轮次交替 arm 顺序。记录代码 commit、未提交 diff、两侧 manifest 和产物路径；不要拿历史不同条件的数字直接比。

验收步骤：

1. 核对实际样本数。candidate judge 必须为 1；baseline 允许暴露原有错误，不用其命令退出码代替得分。
2. 逐例比较 baseline/candidate，单列新退化、改善、原有失败。judge 变化时用同一新 judge 重测两侧，不改阈值迁就 candidate。
3. 单列 provider 错误、超时、取消等 unknown/基础设施失败；不能把它们算通过或直接归因于模型能力，也不重放不确定的外部写入。
4. 报告 token、耗时、请求/工具使用情况与 catalog 估算费用；没有账单不能称实际花费。小样本不能证明总体质量提升。
5. 评测通过只覆盖该套件。真实 App/设备能力仍按 [verification.md](verification.md) 单独验收。

## 当前实现的验证（2026-10-28）

- Node 24.18.0：新增 26 个离线测试通过；连同 harness、runtime、A/B table 检查共 58 passed、1 个既有可选 sidecar 检查 skipped；typecheck 通过。
- 真实模型 `openai-codex/gpt-5.6-luna / high`：三个 case、两侧各一次，最终答案与完成读取证据 **6/6 通过**。baseline 为 `0.1.27-local.5d0fcd56` 安装，candidate 为公开基线 `ef2b490` 的产品；两侧通过各自 runtime identity gate。
- 原生 session 独立核对：17 条 assistant 消息、27 次 read 调用，其中 18 次成功、9 次被路径门禁拒绝后纠正。`local-exact` 的 baseline/candidate 分别有 3/6 次错误读取，均已记录；不能将“答案合同通过”写成无工具错误或整体质量提升。
- 该最终轮 reported tokens 34,597，catalog 估算 $0.00672184，不是账单。此前门禁验证轮另存且不混算：47,909 tokens、估算 $0.00971452。
- skill 结构、链接、Pi 原生发现通过；8 个关键词路由样例通过，不代表已证明模型自动选用的准确率。启用 suite 但缺少模型/产品配置时，以失败状态退出且未运行样本。
- 当时的扩大检查因 `compaction-offload-live.ts` 裸包导入 Pi 而失败（3 个 suite 导入失败，另 2 个测试失败）。后续已修复：改用产品已校验的 runtime，授权检查通过后才捕获原始凭据目录，不重新引入独立 Pi 依赖。干净公开 checkout 全量重跑为 **259 passed / 1 个可选 sidecar skipped**，typecheck 通过；覆盖凭据路径隔离、未授权时不加载 runtime 及原有 `--bail` 行为，未调用付费模型。

## 本次探索保留的结论

这些是此前私有探索的汇总，**不是上述公开派生 fixture 的运行结果**：

- 12 个历史点初审：5 个可用 grounding 失败、2 个正常重试控制、1 个外部余额错误排除、4 个待确认。原始内容未发布。
- 单步重构的 baseline 和通用证据提示 intervention 各 10 次：主模型复核均为 6 pass / 3 fail / 1 unknown，没有净收益，不将该提示改动交付产品。
- 20 个生成结果的 Jev 盲审与主模型复核一致 15/20；不是人工 gold accuracy。出现高置信度错误放行，故保留事实验收。
- 真实本地快照上的三个只读任务各跑两次，6/6 达到构造任务合同；输入、工具和任务澄清均与单步实验不同，不是生产 bug 已修复的 A/B 证据。
- 本次 Git 用例重新虚构名称、ID、标题并去除截图，不包含私人源数据。需独立验证新 runner，不能拿旧 6/6 当作新代码的证据。
