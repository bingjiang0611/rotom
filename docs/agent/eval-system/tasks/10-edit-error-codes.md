# 任务 10 · 给 edit 失败补上原因码

阶段：Phase 2。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/10-edit-error-codes.md`。

## 背景

任务 09：28 天内 edit 出错 724 次（占全部工具出错的 17.7%），其中 706 次 trace 里没有 `pi.tool.error_code`，看不出为什么失败。bob 标注的 fail 里有 3/4 是「出错太多」。bob 选择的方向（2026-10-25）：**给 edit 失败补上原因码**。这是一次**明确授权的 trace 合同小改动**：只新增固定枚举码，不记录任何文本。

## 已知线索（执行者先核实再动手）

- `rotom/extensions/coding-policy/repair-hints.ts` 的 `editErrorHint` 已经按错误文本识别两类失败：`^Found \d+ occurrences of`（不唯一）和 `^Could not find `（找不到）。
- `rotom/extensions/coding-policy/index.ts` 的 `tool_result` 钩子已经往 `details` 里写 `codingPhases`，而 observability 的 `classifyToolOutcome` 能读到它。所以 coding-policy 的这个钩子是**首选接入点**：在 edit 失败且 `details` 里还没有 `code` 时，写一个枚举码。
- observability 只记录 `RECORDED_TOOL_ERROR_CODES` 里的码（`rotom/extensions/observability/index.ts`），新码要加进这个 allowlist。
- 默认 edit 可能是 SoL-Pi Action Fusion 版本，而不是 Pi fork 的 `core/tools/edit.ts`。先确认默认会话实际走的是哪个实现，把它真实的错误文本全部列出来，再定枚举。**不要**为此修改 `sol-pi` 第三方包，除非 coding-policy 接入点确实拿不到；真要改，必须同步 `package.json` / `package-lock.json` / `product-config.mjs` 的 identity 合同，并在报告里说明原因。

## 交付物

1. **分类器**：纯函数 `classifyEditError(errorText) → code | undefined`，放在 coding-policy 内（文件名自定，配单测）。枚举初稿如下，按核实到的真实错误文本增删，并在报告里列出每个码对应的文本模式：
   - `old_text_not_found` · `old_text_ambiguous` · `no_change`（新旧相同）· `overlapping_edits` · `invalid_edit_input` · `file_changed`（文件在读取后被改过，若存在此类错误）
   - 识别不了的不写码（保持 `(none)`），**不要**设一个兜底码冒充分类。文件系统错误继续走已有的 `enoent` 等码。
2. **接入**：coding-policy 的 `tool_result` 钩子在 `toolName` 为 edit（以及 Action Fusion 的 edit 变体，以核实为准）、`isError === true`、且 `details.code` 为空时写 `details.code`。不改错误文本，不改 repair hint 的行为。
3. **allowlist**：把这些码加进 observability 的 `RECORDED_TOOL_ERROR_CODES`；`classifyFaultSide` 中把它们归为 `model`（模型给出的 oldText 与文件不符），`file_changed` 例外，归 `unknown`。在 observability 的测试里补用例，证明码会进 trace、而错误文本不会。
4. **回看历史**：给任务 09 的 `breakdown` 增加一张「edit 失败原因」表：
   - trace 里有 `pi.tool.error_code` 的，直接用；
   - 旧会话没有码的，从**本机会话文件**中对应 edit 的 `toolResult` 文本，用同一个 `classifyEditError` 分类（只在本机内存里读，输出只有枚举计数，不输出、不保存任何文本）；
   - 分两列显示来源：trace 码 / 从会话回推，另列 `(none)` 计数。
   - 关联方式沿用现有逻辑（`pi.tool.call_id_digest` = sha256(toolCallId)）。

## 验证

- coding-policy、observability 两个扩展受影响的测试，加上 eval 定向测试（与 CI 过滤词一致）和 `npm run typecheck`。
- `git diff --check`；`python3 scripts/audit-public.py --root .`。
- 推送后 Actions 要绿，报告附运行链接。CI 只覆盖 eval，所以报告要单独写出本地跑过的 extension 测试命令和结果。
- **真实数据**：运行 `breakdown --since 28d`，报告写 edit 失败原因表的聚合数字。只写枚举码和计数。
- 不要求真实会话的 L3 验证（需要 bob 用新版本跑会话才会产生新码），报告里写为「未验证」。

## 不在本任务范围

修复 edit 失败本身、改 repair hint 或提示词、改 bash 的错误码、改 provider 重试、发布 npm、推 `main`。
