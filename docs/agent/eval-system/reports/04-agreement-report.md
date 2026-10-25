# 任务 04 执行报告 · 规则与人工标注的一致性

已实现通用统计、Markdown 报告和 `agreement` 子命令。定向 L1 通过；全量仍为允许的 10 项既有失败，没有新增失败。真实数据未运行，等任务 02。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/evals/scripts/agreement.mjs` | 纯函数计算四格、unknown、precision/recall/specificity、类别命中计数和未命中类别；渲染两张表及逐信号 FP/FN ID 列表。不依赖规则注册表，不读写文件。 |
| `rotom/evals/scripts/agreement.d.mts` | 声明通用输入、计数结果和两个纯函数。 |
| `rotom/evals/scripts/session-cards.mjs` | 新增 `agreement [--out <cards dir>]`，读取上一级 `labels.jsonl`，将 findings 映射为 signals；复用有界读取、Git 工作树检查和 0600 原子写入。stdout 显式只选聚合字段，不输出 ID、note 或 cardPath。 |
| `rotom/evals/test/agreement.test.ts` | 新增 18 项合成测试，覆盖计算、报告及 CLI 的隐私和路径边界。 |
| `rotom/evals/README.md` | session-cards 小节增加 7 行用法（含标题和空行）。 |
| `docs/agent/eval-system/README.md` | 仅将任务 04 改为 `in-review`。 |
| `docs/agent/eval-system/reports/04-agreement-report.md` | 本报告。 |

没有改 observability、规则条件、阈值、CI 或依赖版本；没有模型调用。

## 验收命令及结果

先执行 `git pull origin eval/system`，从 `43cddb08` 快进至 `1fd804ae`。按 README → 任务 04 的顺序读取说明，并核对根目录合同。环境：Node `v24.18.0`、npm `12.2.0`、Vitest `4.1.9`。

以下 npm 命令均在 `rotom/evals` 执行；Git 和审计命令在仓库根执行。

| 命令 | 结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | PASS，exit 0；安装 180 个包。npm 报 8 项既有依赖漏洞（3 moderate、5 high）；未执行 audit fix，未改锁文件。 |
| `npm test -- test/agreement.test.ts test/session-cards.test.ts` | PASS，2 个文件、58 项测试通过。 |
| `npm test` | exit 1；190 项：179 passed、10 failed、1 skipped。失败仍在原有 4 个文件，详见下表。 |
| `npm run typecheck` | PASS，exit 0。 |
| `git diff --check origin/main...HEAD` | PASS；提交前后分别核对，另检查工作区及暂存 diff。 |
| `python3 scripts/audit-public.py --root .` | PASS，tracked-tree findingCount=0；包含新增文件及最终报告。 |

全量测试的既有失败与任务 03 核验结果一致：

| 文件 | 失败数 | 证据 |
|---|---:|---|
| `test/pi-harness.test.ts` | 3 | 第三方 package identity/version 校验失败；其中投影失败用例期望的错误被此先行错误替代。 |
| `test/coding-hygiene-rule-ablation.test.ts` | 3 | 同一第三方 identity/version 校验失败。 |
| `test/product-runtime.test.ts` | 2 | 同一第三方 identity/version 校验失败。 |
| `test/tool-surface-ablation.test.ts` | 2 | 同一第三方 identity/version 校验失败。 |

实读 installed package 为 `@injaneity/pi-computer-use@0.5.1-rotom.0`，当前 manifest 要求 `0.5.1-rotom.2`。本任务没有覆盖存活运行时、降低 identity gate 或跳过测试。

附加检查：两个改动的 `.mjs` 均通过 `node --check`；README 用法实数为 7 行。新增测试包含不对称 TP/FP/FN/TN=`2/1/3/4` 的独立期望值（precision=`2/3`、recall=`0.4`、specificity=`0.8`），能区分三个分母，而不只是检查对称数据。另覆盖零分母、9/10 边界、unknown/缺失信号、忽略 verdict、重复类别不重复计数、规则表外信号、输入不被修改、Markdown 转义、stdout 无 ID、0600、Git 目录/工作树文件及别名路径、坏输入不覆盖原报告、symlink 拒绝和 labels 字节不变。

公开同步使用独立的 `origin/eval/system` 干净副本及 GitHub noreply 身份，仅重放本任务 diff。额外执行 `python3 scripts/audit-public.py --root . --history`：公开基线及最终提交均为 BLOCKED，仍只有 `fc539150e67d` 的既有 author/committer 非 noreply 2 项；新增 finding 为 0。这是任务 03 核验已记录的公开历史基线，不把全历史审计写成 PASS，也不改写该历史。

## 真实数据冒烟

检查默认 `~/.rotom/evals/labels.jsonl`：不存在。

**未运行，等任务 02。** 没有创建或填写 bob 的标注，没有把合成测试当成真实数据结果，也没有会话内容或真实 ID 进入提交。

## 与任务说明不一致的地方

无功能范围偏离。以下边界作明确记录：

- 仅从 pass/fail 行发现信号及类别；其它 verdict 只计入 ignoredVerdicts。某有效行缺少已发现的信号时计 unknown，不计 clear。没有发现任何名称时不虚构规则名。
- 类别保留有效标注中的所有名称，包括只出现在 pass 行的类别；其 fail 数为 0。没有任何 hit 的类别按要求列出，但零失败样本不证明存在规则缺陷，程序不据此自动改规则。
- 输入按行统计，不额外去重会话。单行重复 category 只计一次。
- 零分母只显示 n/a；有定义且分母不足 10 的比例才附 `(n<10)`。stdout 的 uncoveredCategories 是数量，具体类别可见类别计数表及私有 Markdown。
- 复用现有文件 256 MiB、行 64 MiB 上限。labels 超限或有坏 JSON 时拒绝生成报告，不跳过坏行后输出有偏统计；不修改原 labels 或原报告。

## 未验证项与遗留问题

- 真实人工标签的一致性结果尚无证据。bob 完成任务 02 并导出 labels 后，运行 `node rotom/evals/scripts/session-cards.mjs agreement`；报告仍只公开行数及各信号四格计数，不公开复核 ID。
- L1 通过不表示规则与人类判断已一致；本任务没有验证 LLM judge，也没有计算 F1、总分或自动调阈值。
- 10 项运行时环境基线失败及 8 项依赖漏洞未修复，留给维护者的独立环境/依赖任务，不扩大任务 04。
- 历史审计的 2 项既有身份发现保持原样；本次提交使用 noreply，不 force push。隐私扫描是启发式文本检查，不证明不存在任意秘密。
- 下一步由规划者核验任务 04；状态为 `in-review`，不是自行宣告 accepted。

## 核验结论（规划者，2026-10-25）

结论：**accepted**。规划者在 Linux / Node v22 上重跑 `agreement`、`session-cards`、`trace-assertions` 三组测试，3 个文件共 91 项全过，typecheck 退出 0。`computeAgreement` 的四格、三个比例、unknown 处理和类别统计已逐行核对。不对称 2/1/3/4 的测试用例很好，能把三个分母区分开。真实数据等任务 02。
