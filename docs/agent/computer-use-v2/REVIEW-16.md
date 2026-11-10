# Computer Use v2.1 第 16 轮审核：第一次手动测试、`observe_ui` 修复与公开审计阻碍

## 结论

- 用产品原本身份构建的测试 helper 在用户的 Mac 上跑起来了，用户第一次在测试版里手动调用，就暴露了一个严重缺陷：
  **v2.1 上 `observe_ui` 渲染大纲时一定报错**。手动测试的价值得到证明。
- 执行方的修复方向接受（导出 `displayName` 并在 `render.ts` 导入，补测试）；补丁还没推送，审核者要看到 diff 才能给结论。
- 公开审计的阻碍来自分支上**已经公开**的历史，不是这次修复引入的；修复提交可以推送，条件见下。
- 这个包从未做过类型检查，是这类缺陷反复出现的根因（T1）。

## 缺陷确认

审核者独立核对 `origin/claude/computer-use-v2.1`（`c5376b7`）：

- `packages/rotom-computer-use/src/outline/render.ts` 第 62 行调用 `displayName(node)`，但文件只从 `lookup.ts` 导入了 `nodeByRef`；
  `displayName` 是 `lookup.ts` 第 17 行的**未导出**函数。运行到这里就抛 `displayName is not defined`。
- 缺陷由 `df2f126`（2026-11-04，Q3 按职责拆分 `outline.ts`）引入。审核者在 REVIEW-4 复核中接受了这次拆分，没有发现，是审核者的遗漏。
- B0 脚本走 `backend.observe` 的解析路径，不经过渲染，所以从未暴露。

## T1（高，下一个冻结之前完成）：恢复类型检查

`package.json` 有 `"typecheck": "tsc -p tsconfig.json"`，但包里**没有 `tsconfig.json`**，类型检查从来没跑过。用 `--experimental-strip-types` 运行只会去掉类型，
不检查未定义的名字。`alive is not defined`（第 7 轮）和这次的 `displayName is not defined` 都是 `tsc` 一跑就会报的错误（TS2304 “Cannot find name”）。

要做的（在依赖已安装的 Mac 测试 checkout 里做）：

1. 补上 `tsconfig.json`（`noEmit`、`allowImportingTsExtensions`、与运行时一致的 module 和 target；peer 依赖从产品安装目录解析）。
2. 跑一次，先把所有“找不到名字”“找不到模块”“导出不存在”这类会在运行时直接报错的错误清零；其余类型错误列清单，单独分轮处理，不在本轮扩大范围。
3. 把 `npm run typecheck` 加进 dry run 或测试闸门，以后每次冻结前都跑。

## 公开审计

审核者在 `c5376b7` 上独立跑了一遍：当前文件树 1 项命中（`docs/agent/computer-use-v2/STATUS-2-testmachine.md` 第 76 行写了本机家目录路径）；
带历史 195 项命中（提交作者非 noreply 72 项、家目录路径 69 项、提交者非 noreply 54 项）。这些都已经在 GitHub 上公开。

- 其中 19 个提交的作者是 `@anthropic.com`，就是审核者的审核提交被 cherry-pick 进 v2.1；其中 3 个当时直接推到 v2.1，提交者也不是 noreply。
  这是审核者的问题：本仓库要求 GitHub noreply 身份。审核者从本轮起改用 GitHub noreply 身份提交。
- **推送规则**：分支已经公开，再推一个**自身不引入新命中**的提交（diff 审计 0 项、作者和提交者都是 noreply）不会扩大暴露面。执行方可以推送修复提交。
  另起一个提交把 `STATUS-2-testmachine.md` 第 76 行的路径改成 `~`，让当前文件树审计归零。
- **不要改写分支历史。** 历史里的身份和路径命中，在合入 `main` 时按根 `CLAUDE.md` 的规则处理：从最新公开基线建干净副本、以 GitHub noreply 身份重放 diff、
  跑完整审计后快进推送。分支历史不进 `main`。

## 给执行方的顺序

1. 推送 `observe_ui` 修复提交（确认 diff 审计 0 项、身份为 noreply），再推送路径修正提交。
2. T1：补 `tsconfig.json`，清零运行时会直接报错的类型错误，把 typecheck 加进闸门；其余类型错误列清单。
3. 推送后报告 SHA，审核者审过再冻结，然后重建测试版（仍用产品原本身份，不覆盖现有安装）。
