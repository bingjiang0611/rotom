# 任务 10 报告 · 给 edit 失败补上原因码

执行者按 [tasks/10-edit-error-codes.md](../tasks/10-edit-error-codes.md) 实现。trace 只新增固定枚举码；错误文本只在本机内存里用于分类，既不写进 trace，也不写进任何报告或产物。

## 先核实的实现与错误文本

默认会话的 `edit` 不是 Pi fork 裸工具，而是 SoL-Pi Action Fusion 重新注册的同一个工具：

- `rotom/extensions/third-party/sol-pi.ts` 在无用户配置文件时把 `actionFusion` 置为 `true`（`ROTOM_SOL_PI_DEFAULT_CONFIG`）。
- `sol-pi/src/sol-pi/extensions/action-fusion/index.ts` 用 `createEditToolDefinition(cwd)` 建基工具，只加 `then_run`，注册名仍是 `edit`（同文件 `name: "edit"` 来自 Pi fork）。所以 Action Fusion 不是另一个 edit 变体，`toolName === "edit"` 就覆盖两条路径。
- 因此错误文本来自 Pi fork `packages/rotom-pi/packages/coding-agent/src/core/tools/edit.ts` 与 `edit-diff.ts`，全部由 `applyEditsToNormalizedContent` 与 `validateEditInput` 抛出。

核实到的真实错误文本与对应码：

| 码 | 文本模式（产品源码） |
|---|---|
| `old_text_not_found` | `Could not find the exact text in <path>…` / `Could not find edits[i] in <path>…` |
| `old_text_ambiguous` | `Found N occurrences of …` |
| `no_change` | `No changes made to <path>. …` |
| `overlapping_edits` | `edits[i] and edits[j] overlap in <path>…` |
| `invalid_edit_input` | `Edit tool input is invalid. edits must contain at least one replacement.` / `oldText must not be empty in <path>.` / `edits[i].oldText must not be empty in <path>.` |
| `enoent` 等已有码 | `Could not edit file: <path>. Error code: ENOENT.`（沿用文件工具既有码，不新增 edit 专属码） |

任务说明列的 `file_changed`（“文件在读取后被改过”）在产品 edit 路径里没有对应文本，核实后**不加**这个码，也不加任何兜底码。`no_change` 文本存在但 28 天内未观测到，保留并在下面标注。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/extensions/coding-policy/edit-error-code.mjs` | 新增纯函数 `classifyEditError(errorText)`；枚举与文件系统码集合，无兜底码 |
| `rotom/extensions/coding-policy/index.ts` | 新增 `editFailureCode(event)`；`tool_result` 钩子在 edit 失败且 `details.code` 为空时写 `details.code`，同时保留原有 repair hint 行为 |
| `rotom/extensions/coding-policy/edit-error-code.test.mjs` | 新增 4 个分类单测（真实产品文本、追加后缀、文件系统码、无码情况） |
| `rotom/extensions/coding-policy/index.test.ts` | 新增 1 个钩子测试：只加枚举码、不改文本、不覆盖来源码、不碰 then_run 证据 |
| `rotom/extensions/coding-policy/repair-hints.test.ts` | 调整 1 处断言：重复传入已附加提示的结果时，提示仍不重复，但原因码可幂等补写 |
| `rotom/extensions/observability/index.ts` | 5 个新码进 `RECORDED_TOOL_ERROR_CODES`；`classifyFaultSide` 把 edit 匹配类失败归 `model` |
| `rotom/extensions/observability/index.test.ts` | 新增 1 个测试：码进 trace、错误文本与路径参数都不进 trace；非白名单码不记录 |
| `rotom/evals/scripts/error-breakdown.mjs` | 新增纯函数 `toolCallInfo(traceRecords, toolName)`、`editFailureRows(entries)`；`aggregateBreakdown` 合并 `editFailures` |
| `rotom/evals/scripts/error-breakdown.d.mts` | 对应类型声明 |
| `rotom/evals/scripts/session-cards.mjs` | 新增 `editFailuresOf(branch, traceRecords)`（按 `pi.tool.call_id_digest` 关联，文本只在内存里分类）；`breakdown` 输出新增 `editFailures`，私有 `breakdown.md` 新增「edit 失败原因」表 |
| `rotom/evals/test/error-breakdown.test.ts` | 新增 3 个单测（按 digest 关联、trace/回推/then_run 分列、跨会话合并） |
| `rotom/evals/test/session-cards.test.ts` | 集成测试扩展 1 例：stdout 有 `editFailures` 且不含错误文本，私有文件有新表 |
| `rotom/package.json`、`rotom/runtime/product-config.mjs` | 新文件进发行清单与 `requiredFiles`，否则装机后 `index.ts` 会 import 失败 |
| `docs/agent/eval-system/README.md` | 状态表 10 → `in-review` |

接入点按任务建议放在 coding-policy 的 `tool_result` 钩子，没有改 `sol-pi` 第三方包，也没有改依赖 identity。

## 验收命令与结果

| 命令 | 结果 |
|---|---|
| `cd rotom/evals && npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 通过（8 个既有 npm audit 告警未处理，与本次无关） |
| `node --experimental-strip-types --test rotom/extensions/coding-policy/index.test.ts rotom/extensions/coding-policy/repair-hints.test.ts rotom/extensions/observability/index.test.ts` | 42 用例全通过 |
| `node --test rotom/extensions/coding-policy/edit-error-code.test.mjs` | 4 用例全通过 |
| `node --test rotom/runtime/distribution.test.mjs` | 27 用例全通过（改发行清单后从 26 通过 1 失败转为全通过，失败项原本就是新文件未登记） |
| `cd rotom/evals && npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown`（CI 过滤词） | 6 文件 / 153 用例全通过 |
| `cd rotom/evals && npm test`（全量） | 241 passed / 10 failed / 1 skipped（252）；失败仍是既有 10 个（`pi-harness` 3、`coding-hygiene-rule-ablation` 3、`product-runtime` 2、`tool-surface-ablation` 2），原因同前：装机 `@injaneity/pi-computer-use` 为 `0.5.1-rotom.0`，分支 manifest 要求 `0.5.1-rotom.2`，失败在 package identity gate |
| `cd rotom/evals && npm run typecheck` | 通过 |
| `git diff --check` | 通过 |
| `python3 scripts/audit-public.py --root .` | 树审计 PASS，0 处命中（7,825 个文件） |
| `node rotom/runtime/smoke-runtime.mjs <pi> rotom` | **跑不起来**：在 `verifyThirdPartyPackageContract` 处报 `已安装 … identity/version 不匹配`，是既有装机状态，与本次改动无关。用 `git worktree` 在 `origin/eval/system` 干净树上对照跑 `rotom/runtime/verify-pi-runtime.test.mjs`：基线 6 passed / 34 failed，本次 7 passed / 33 failed，同一环境门槛，未引入新失败 |

## 真实数据冒烟

命令：`node scripts/session-cards.mjs breakdown --since 28d --out <仓库外临时目录>/cards`，退出码 0，stderr 空，stdout 只有聚合 JSON，私有 `breakdown.md` 权限 `0600`，位于 Git 工作树外。

一次运行（窗口滚动，数字会小幅变化）：会话 175，工具 span 54,703 / 出错 4,131，provider 请求 41,557 / 出错 1,220。

edit 失败原因（只列枚举码计数）：

| 原因码 | trace 码 | 从会话回推 |
|---|---|---|
| `old_text_not_found` | 0 | 90 |
| `old_text_ambiguous` | 0 | 55 |
| `overlapping_edits` | 0 | 2 |
| `invalid_edit_input` | 0 | 1 |
| `validation_error`（agent loop 产生，非本任务码） | 1 | 0 |
| `(none)` | 0 | 20 |

合计 675 次 edit 调用失败，其中 506 次是 **Action Fusion 的 then_run 失败**（edit 本身已写盘，下面的完整命令失败），另有 20 次旧 trace 缺 `pi.tool.followup_status` 而无法用 metadata 区分、文本显示 edit 已写盘，这 526 次都不属于 edit 失败原因，因此不计入任何 edit 码。真正的 edit 失败 149 次：`old_text_not_found` 90（60.4%）、`old_text_ambiguous` 55（36.9%）、`overlapping_edits` 2、`invalid_edit_input` 1、`validation_error` 1。

`trace 码` 列基本为 0 是预期的：新码只有跑过新版本的会话才会产生，本机还没有这样的会话。

## 和任务说明不一致的地方

1. **`file_changed` 未实现**：产品 edit 路径没有“文件在读取后被改过”这类错误文本，核实后不设该码（任务说明允许按真实文本增删）。
2. **文件系统错误的码由分类器补**：`Could not edit file: … Error code: ENOENT.` 之前既没有 `details.code` 也没有 trace 码（Pi 把 Node 错误包成新 Error，丢了 `code`），所以由 `classifyEditError` 从该**机器生成**的码位还原成既有白名单码，不新增 edit 专属码。28 天真实数据里这条路径出现 0 次。
3. **新增 `then_run_failed` 桶**：任务只要求 trace 码 / 会话回推 / `(none)` 三列。实测发现 Action Fusion 的 then_run 失败会被记成 `edit` 失败，如果不单独区分，`(none)` 会把 506 次非 edit 失败算进去。该桶只用 trace metadata（`pi.tool.followup_status`），不读文本，不写码。
4. **测试断言调整**：`repair-hints.test.ts` 原来断言“重复传入已附加提示的结果返回 `undefined`”。新合同下该调用仍不重复附加提示，但会幂等补写原因码，因此断言改为分别校验 `details` 与 `content`。这是行为收紧而非放宽：提示行为不变。

## 未验证项

- **L3 未验证**：没有用新版本跑真实会话，所以 5 个新码还没有一次真实产生-记录闭环；`trace 码` 列全 0 就是证据。需要 bob 用新版本跑几次失败 edit 才能验证。
- **装机路径未验证**：`smoke-runtime.mjs` 被既有 identity gate 挡住，没有验证打包后的产品能加载新文件；`distribution.test.mjs` 全通过只证明发行清单与 `requiredFiles` 一致。
- **`no_change`** 无真实样本，只有合成文本单测。
- `verify-pi-runtime.test.mjs` 仍有 33 个既有失败（基线 34），未逐条归因，只对照确认未新增失败。

## 遗留问题

- 任务 09 报告里的「edit 出错 724 次（17.7%）」把 then_run 失败也算作 edit 失败。按本次核实，其中约三分之二并非 edit 本身失败。任务 09 的措辞是否修订，留给规划者决定，本任务未改。
- 旧会话缺 `pi.tool.followup_status` 的 20 次无法用 metadata 区分 then_run 失败，保持 `(none)`；不打算用文本去猜。
- 本任务只补码，不减少 edit 失败；bob 标注里 3/4 的 fail 指向「出错太多」，真正的改进要靠后续按码分布的修复。
