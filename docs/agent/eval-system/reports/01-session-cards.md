# 任务 01 执行报告：会话卡片 + 标注汇总

实现完成，提交核验（`in-review`）。新增 L1 单测 17 项通过，类型检查通过；已做仓库外真实数据冒烟。全量测试未全绿：10 项被本机既有运行时依赖版本不匹配阻断，详见下文。

## 改动文件

| 文件 | 改动及作用 |
|---|---|
| `rotom/evals/scripts/session-cards.mjs` | Node ESM CLI；只读扫描 session，回溯末 entry 所在分支，关联 trace，生成私有卡片并导出人工标注。无模型调用、无新增 npm 依赖。 |
| `rotom/evals/scripts/session-cards.d.mts` | `buildCards`、`collectLabels` 的导出类型。 |
| `rotom/evals/test/session-cards.test.ts` | 17 项合成数据测试；测试目录自动清理，不读取真实 session。 |
| `rotom/evals/README.md` | 新增 20 行使用说明、命令、标注格式和隐私边界。 |
| `docs/agent/eval-system/README.md` | 任务 01 状态由 `ready` 改为 `in-review`。 |
| `docs/agent/eval-system/reports/01-session-cards.md` | 本报告。 |

未改 observability、产品运行时、CI、依赖清单或锁文件；未增加失败规则、judge 或 UI。

## 验收命令及结果

环境：macOS，Node `v24.18.0`，npm `12.2.0`，Vitest `4.1.9`。以下为最终代码的结果。

| 命令 | 结果 |
|---|---|
| `cd rotom/evals` | 成功，以下四条 npm 命令在此目录运行。 |
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0；安装 180 个包。npm 提示既有依赖存在 8 项漏洞（3 moderate、5 high）；未运行 audit fix，也未改锁文件。 |
| `npm test -- test/session-cards.test.ts` | 退出 0；1 个测试文件、17 项通过。 |
| `npm test` | 退出 1；15 个测试文件中 11 个通过、4 个失败；116 项中 105 通过、10 失败、1 跳过。 |
| `npm run typecheck` | 退出 0。全量测试失败后单独执行，未被前一命令短路。 |
| `cd ../..` | 返回仓库根；后续 Git / audit 命令在仓库根运行。 |
| `git diff --check origin/main...HEAD` | 退出 0；提交后再次核验提交范围。另对最终暂存区运行 `git diff --cached --check`。 |
| `python3 scripts/audit-public.py --root .` | PASS；最终新增文件加入暂存区后复查，零 finding。 |

额外执行 `node --check rotom/evals/scripts/session-cards.mjs`，通过。公开前另运行带 `--history` 的隐私审计，结果见提交前检查。

### 提交前检查

- 原维护仓 tracked-tree 审计 PASS，新增文件已暂存；全 refs 的 `--history` 审计 BLOCKED（1391 项），包含旧维护历史。因此不从该仓直接推送。
- 从远端 `eval/system` 建立独立干净 clone，仅重放本次 6 个文件的 diff，使用 GitHub noreply 身份提交。实现与已测试文件逐字核对，不复制 node_modules、会话或凭据。
- 干净 clone 的 `python3 scripts/audit-public.py --root .` 为 PASS。额外 `--history` 审计仍为 BLOCKED，仅 2 项：远端既有 `fc539150e67d` 的 author / committer 非 noreply 身份。已用 `git merge-base --is-ancestor fc539150e67d origin/eval/system` 确认其属于任务下发基线；不回显邮箱，不改写远端历史。此结果不能表述成全历史审计通过。
- 推送范围仅本次任务提交，目标 `origin/eval/system`；不推 main、不 force push。真实数据产物不在 diff 中。

### 全量测试失败的证据

10 项失败均为 `verifyThirdPartyPackageContract` 抛出的 `@injaneity/pi-computer-use identity/version 不匹配`，涉及：

- `test/product-runtime.test.ts`：2 项。
- `test/coding-hygiene-rule-ablation.test.ts`：3 项。
- `test/pi-harness.test.ts`：3 项。
- `test/tool-surface-ablation.test.ts`：2 项。

分支的 `rotom/extensions/third-party/package.json` 要求 `0.5.1-rotom.2`；本机对应 `node_modules` 的 `package.json` 实际是 `0.5.1-rotom.0`。这两处及运行时验证器均未被本任务修改，失败栈未进入 session-cards 模块。未覆盖可能供存活会话使用的安装，也未放松 identity gate 或跳过失败用例。

首次新增测试有 1 项因 macOS 临时目录的 `/var` 与 canonical `/private/var` 别名断言不一致而失败；已将测试临时根解析为 realpath，保留对实际 canonical `cardPath` 的严格比较，最终 17 项全部通过。

### L1 覆盖

- 分支选择、当前分支模型/usage/stopReason/工具计数、未知 entry 计数、compaction 和 model_change。
- 跨 trace 的相同 spanId、乱序工具结果、start/end 属性合并、SHA-256 调用 ID 关联；不统计其它分支的工具错误。
- trace 缺失、末行截断、未结束工具 span、trace 文件超限；保留有效证据，不伪造成功。
- 重建时更新正文并逐字保留非空 verdict 标注；损坏标注拒绝覆盖；两张已标注加一张未标注导出恰两行，类别去重计数正确。
- Git 目录和 worktree `.git` 文件、canonical 路径别名、symlink 根/输出/目标文件、输入目录重叠；权限 0700/0600，session/trace 字节保持不变。
- 文件 32 MiB 与单行 1 MiB 上限、坏 JSON、空会话、mtime/since/limit、拒绝 limit > 500、排除 observability 和 symlink 子目录。
- 各字段截断、Unicode 字符不拆代理对、thinking 不输出正文、图片仅占位、stdout 计数、来源文本不能伪造标注块。

## 真实数据冒烟

存在默认 session 根目录，已运行：

```sh
node rotom/evals/scripts/session-cards.mjs build --limit 5 --out <仓库外私有临时目录>/final-cards
```

最终代码在新的输出目录得到：生成 **2**、跳过 **3**、trace missing **0**、trace partial **2**、解析错误 **2**、未知 entry **319**；输出卡片 **2** 张。完整人工阅读 **1** 张；检查目录及卡片权限分别为 0700、0600。

格式观察：元数据、请求、过程、最终回复及标注块可读；自审已去掉无 text 的空 assistant 行。末条 assistant 只有工具调用时，“最终回复”保持空白，不拿更早文本冒充最终回复。未人工填写真实标注，真实标签导出未验证；标注往返仅由合成测试验证。

报告不含真实会话正文、ID、来源文件名或本机路径。冒烟产物仅保留在仓库外私有临时目录，未加入 Git。

## 与任务说明的差异及保守解释

没有有意省略的交付物或必需行为。以下是任务允许的实现选择及明确边界：

1. 选择自写有界 JSONL 解析器，不复用 dashboard；session 超过 32 MiB 跳过，trace 超过同一上限不读取正文并标 partial，超过 1 MiB 的行跳过计错。按打开文件时的大小读取，避免存活会话持续增长导致无界读取。
2. start/end 先按 `(traceId, spanId)` 合并，再按 `sha256(toolCallId)` 关联；outcome/fault 缺失显示 unknown，不根据工具顺序或 `isError` 猜 trace 结果。未结束工具 span 也标 partial。
3. `duration` 用带 `ms` 的字符串；内容用 Markdown 引用块而非固定行内排版；截断按 Unicode 字符计数。所需字段均保留。
4. 标注类别用逗号分隔，note 支持多行；`labeledAt` 为导出时间。非空 verdict 都导出，pass/fail 分别计数；格式损坏直接报错，防止误清标注。
5. limit 超过 500 拒绝而非静默裁剪；同批重复 session ID 只保留修改时间最新者，其余计跳过。Git 工作树内输出、symlink 目标和 session 根内输出均拒绝；写入采用同目录私有临时文件加 rename。
6. 未增加任务外的运行时依赖修复；因此全量测试结果不能写成通过。

## 未验证项、遗留问题及交接

| 项目 | 当前边界 | 责任人与下一步 |
|---|---|---|
| 全量 eval 测试 | 10 项受本机旧 Computer Use 安装阻断；1 项保持既有跳过。 | 维护者在确认无存活会话依赖该安装后，按仓库流程同步锁定运行时依赖，再由规划者重跑 `npm test`；本任务不覆盖安装。 |
| npm 漏洞提示 | 本次仅记录安装器的计数，未做漏洞可达性分析或升级。 | 维护者另立依赖维护任务评估；不混入任务 01。 |
| 公开基线历史审计 | 任务下发 commit 已含非 noreply 身份，干净 clone 的全历史审计仍有 2 项；本次提交不新增此问题。 | 规划者后续提交使用 GitHub noreply 身份；维护者另行决定是否处理既有公开身份元数据，本任务不改写历史。 |
| 人工真实标签工作流 | 未代 bob 填写或推断真实 verdict；L1 已覆盖标注保留与导出。 | bob 在任务 02 填写真实卡片并运行 labels，规划者核验任务 01 后推进。 |

仅请求规划者审阅任务 01，不宣称 accepted。后续有超过本次上限的使用需求时，先明确分块读取/分页合同和对应验收，再调整上限；当前不预留新接口。

## 核验意见（规划者，2026-10-25）

结论：**changes-requested**，只需一轮小修。实现质量和报告都好，核心行为（分支回溯、`sha256(toolCallId)` 关联、标注保留、隐私边界、有界读取）已核对源码并重跑通过。阻塞点只有一个：真实冒烟 5 个会话里 3 个被跳过，原因不明。Phase 1 要靠这些卡片归纳失败类别，如果被跳过的恰好是长会话，分类会系统性漏掉最难的失败。

规划者重跑结果（Linux，Node v22.22.0，干净 clone，HEAD `d365f43`）：

| 命令 | 结果 |
|---|---|
| `npm test -- test/session-cards.test.ts` | 17/17 通过 |
| `npm test` | 4 个文件 10 项失败，与报告同一批测试；本环境没有安装产品第三方运行时，判定为既有问题、与本任务无关 |
| `npm run typecheck` | 退出 0 |
| `git diff --check origin/main...HEAD` | 退出 0 |
| `python3 scripts/audit-public.py --root .` | PASS，0 finding |

### 必须修改

1. **跳过原因拆开计数**。`summary.skipped` 拆成 `skippedOversized`、`skippedInvalidHeader`、`skippedEmpty`、`skippedDuplicate`（保留总数 `skipped`）。`parseErrors` 同样拆成 session 侧与 trace 侧。单测覆盖每个原因。
2. **超大会话不能整份丢弃**。改为按行流式读取（不再一次性 `Buffer.alloc(size)`），单文件上限提高到 256 MiB，单行 1 MiB 上限不变；超过 256 MiB 仍跳过并计入 `skippedOversized`。trace 同样处理。
3. **`unknownEntries` 只统计真正未知的类型**。`custom`、`context_edit`、`label`、`session_info`、`thinking_level_change`、`usage` 属于已知类型：静默跳过，不计数。
4. **渲染两类会进入模型上下文的条目**：`custom_message` 输出一行 `custom_message[<customType>]：<content 截断 300>`；`branch_summary` 输出一行 `branch_summary：<summary 截断 300>`。Goal 续跑和 Context Layers 的注入都走这里，标注时需要看到。
5. **最终回复为空时要说明原因**：最后一条 assistant 没有文本时，「最终回复」写 `(最后一条 assistant 无文本，stopReason=<值>)`，仍不拿更早的文本代替。
6. **重做真实数据冒烟**：用 `--limit 20`，报告里写出拆分后的全部计数。如果 `skippedOversized` 仍大于 0，写出被跳过文件的大小区间（只写大小，不写文件名）。

### 不需要改

- 全量 `npm test` 的 10 项既有失败、npm 漏洞提示：不在本任务范围，保持记录即可。
- `fc53915` 作者身份不是 GitHub noreply：规划者确认这是规划者的提交，之后的规划提交改用 noreply 身份，不改写已推送的历史。

完成后把状态改回 `in-review`，在本报告末尾追加「修订记录」小节，然后推送。

## 修订记录（执行者，2026-10-25）

按上述 6 项必须修改完成修订，状态恢复为 `in-review`。以下结果覆盖修订后的代码；此前报告的 32 MiB 上限、旧计数和空最终回复描述仅作为首轮历史记录保留。

### 逐项修改

| 核验项 | 修改及验证 |
|---|---|
| 1. 拆分跳过和解析错误 | 保留 `skipped`、`parseErrors` 总数；新增 `skippedOversized`、`skippedInvalidHeader`、`skippedEmpty`、`skippedDuplicate` 和 `sessionParseErrors`、`traceParseErrors`。总数由分项求和。合成测试逐一触发 4 种跳过及两侧解析错误，严格比较所有计数；声明文件同步更新。 |
| 2. 流式读取及 256 MiB 上限 | session / trace 共用 64 KiB 分块的按行读取器，不再按文件大小分配 Buffer；保留打开文件时的读取终点。单行缓冲最多 1 MiB，超长行丢弃至换行后恢复；文件超过 256 MiB 才跳过，超限 trace 仍标 partial。新增大于 32 MiB 的 session 和 trace 合成回归，核验首尾条目、跨文件首尾的工具关联、无末尾换行；原超限测试改为 256 MiB + 1 字节。 |
| 3. 已知类型不计 unknown | `custom`、`context_edit`、`label`、`session_info`、`thinking_level_change`、`usage` 静默跳过。合成测试同时放入这 6 类和 1 个未知类型，断言 unknown 恰为 1；已知 message 类型的无效结构归 session 解析错误，不归未知 entry。 |
| 4. 渲染上下文条目 | 增加 `custom_message[<customType>]` 和 `branch_summary` 过程行，正文截断到 300 字符，换行折为空格。测试覆盖字符串/数组 content、图片占位及两类条目的截断。仍只渲染当前分支。 |
| 5. 空最终回复说明 | 最后一条 assistant 无文本时输出 `(最后一条 assistant 无文本，stopReason=<值>)`；缺失 stopReason 显示 unknown。4 个参数化用例验证 toolUse/error/aborted/缺失值，且不复制此前 assistant 的文本。 |
| 6. 真实冒烟 | 使用 `--limit 20` 和新的仓库外私有目录；全部拆分计数见下表。未填写真实 verdict 或导出真实标签。 |

改动仅涉及 `rotom/evals/scripts/session-cards.mjs`、对应 `.d.mts`、`rotom/evals/test/session-cards.test.ts`、`rotom/evals/README.md`（同步上限及计数说明）、协作 README 状态及本报告追加记录；未修改 observability、运行时安装、依赖或锁文件。

### 验收命令

环境仍为 macOS / Node `v24.18.0` / npm `12.2.0` / Vitest `4.1.9`。

| 命令 | 修订后结果 |
|---|---|
| `cd rotom/evals` | 成功，以下 npm 命令在该目录执行。 |
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，安装 180 个包；仍提示 8 项既有漏洞（3 moderate、5 high），未做额外修复。 |
| `npm test -- test/session-cards.test.ts` | 退出 0；23/23 通过。 |
| `npm test` | 退出 1；15 个测试文件中 11 通过、4 失败；122 项中 111 通过、10 失败、1 跳过。失败仍全部为先前记录的 Computer Use identity/version 不匹配，涉及相同 4 个测试文件；没有新增失败。 |
| `npm run typecheck` | 退出 0；独立执行，不受全量测试失败短路影响。 |
| `cd ../..` | 返回仓库根，后续 Git / audit 命令在根目录执行。 |
| `git diff --check origin/main...HEAD` | 退出 0，提交后复查；另检查工作区和暂存区 whitespace。 |
| `python3 scripts/audit-public.py --root .` | PASS，0 finding；新增改动全部暂存后复查。 |

额外运行 `node --check rotom/evals/scripts/session-cards.mjs`，通过。L1 只使用合成数据，23 项中含本轮新增的 6 项测试；没有用真实会话内容充当 fixture。

### 真实数据冒烟计数

命令：`node rotom/evals/scripts/session-cards.mjs build --limit 20 --out <仓库外私有临时目录>/cards`。

| 字段 | 计数 |
|---|---:|
| generated | 11 |
| skipped | 9 |
| skippedOversized | 0 |
| skippedInvalidHeader | 9 |
| skippedEmpty | 0 |
| skippedDuplicate | 0 |
| traceMissing | 0 |
| tracePartial | 2 |
| parseErrors | 66 |
| sessionParseErrors | 66 |
| traceParseErrors | 0 |
| unknownEntries | 0 |
| 输出卡片 | 11 |
| 完整人工阅读卡片 | 1 |

`skippedOversized=0`，无需报告被跳过文件的大小区间。本轮跳过均归于无效 header，不再把跳过原因混成一个数字。真实数据产物只保留在仓库外私有临时目录；本节不记录任何会话正文、ID、文件名或本机路径。

### 提交边界及交接

沿用首轮隔离公开历史的方式：从远端 `eval/system` 建干净 clone，只重放本次修订 diff，以 GitHub noreply 身份提交，目标仅为 `origin/eval/system`。不推 main，不 force push，不更改已公开历史。干净副本额外运行 `--history` 审计：仍只有核验意见已确认的 `fc53915` author / committer 两项既有发现，本次不新增；不将其表述为全历史 PASS。

全量测试的 10 项既有失败及 npm 漏洞提示按核验意见留在原范围，不处理。真实人工标签流程仍由 bob 在任务 02 执行；本轮请规划者复核这 6 项修订和新冒烟计数，不宣称 accepted。

## 第二轮核验意见（规划者，2026-10-25）

结论：**changes-requested**，最后一小轮。上一轮 6 项都按要求完成了，流式读取和计数拆分已核对源码，规划者重跑 23/23 通过。新冒烟数字暴露了两个新问题：20 个会话里 9 个因 header 无效被跳过，另有 66 个 session 解析错误。第二个问题有一部分是规划者任务说明的遗漏，不是执行者的错。

### 原因分析（规划者已查 Pi 源码）

- `packages/rotom-pi/packages/coding-agent/src/core/messages.ts` 里，`message` entry 的 role 除了 `user` / `assistant` / `toolResult`，还有 `bashExecution`（用户用 `!cmd` 直接跑的命令，会持久化）和 `custom`（v2→v3 迁移后的旧 hookMessage）。另外 `system` 也可能出现。现在这些都计成 `sessionParseErrors`，内容也没有渲染。
- `session-manager.ts` 的 `migrateV1ToV2`：v1 会话没有 `id` / `parentId`，Pi 加载时按文件顺序生成线性链。当前实现会把这类 entry 全部判为解析错误。
- 9 个 invalid header 的原因还不知道，可能是 sessions 目录里混了非会话的 `.jsonl` 文件，也可能是 header 合法但没通过 `/^[\w-]+$/` 检查。

### 必须修改

1. **补齐 message role**：`bashExecution` 渲染一行 `$ <command 截断 200> → exit=<exitCode|unknown><cancelled 时加 " cancelled"> · 输出：<output 截断 300>`；`custom` 按 `custom_message[<customType>]` 同样渲染；`system` 静默跳过。其它未知 role 计入 `unknownEntries`，**不计**解析错误。
2. **兼容旧版本会话**：header 没有 `version` 或 `version < 2` 时，按 Pi `migrateV1ToV2` 的做法，按文件顺序给 entry 生成线性 `id` / `parentId` 再回溯分支。不需要处理 compaction 的 `firstKeptEntryIndex`。
3. **诊断无效 header**：summary 增加 `invalidHeaderKinds` 计数表，key 取第一条记录的 `type` 字段（只接受 `^[a-z_]{1,32}$`，否则记 `other`），首行无法解析时记 `unparseable`。header 是 `session`、但 id 没通过正则的记 `session-bad-id`。另外增加 `sessionVersions` 计数表（`1` / `2` / `3` / `missing`），只统计生成的卡片。
4. **单测**：上面每条至少一个合成用例；断言 bashExecution 和 custom 能渲染、不计错误，v1 会话能正常生成卡片。
5. **重做冒烟**：`--limit 20`，报告写出全部计数，包括两个新计数表。如果 `session-bad-id` 大于 0，就放宽 id 校验（id 只用作文件名，改成拒绝 `/`、`\`、`..` 和控制字符即可），然后再跑一次。

验收命令和提交方式同前。完成后状态改回 `in-review`，追加「第二轮修订记录」。
