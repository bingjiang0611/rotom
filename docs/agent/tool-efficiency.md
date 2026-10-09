# 工具执行卫生与输出控制

本次只落实执行卫生和源头输出控制，不改变 compaction、子任务收尾或自动重试策略。

## 产品合同

- `coding-policy` 复用已观察的 Git root/cwd、路径和 package scripts；移动、删除、切分支或生成失败使相关证据失效时再检查。不是每次调用前机械重复 preflight。
- edit 错误继续使用已有 `repair-hints` 的块编号和候选行号。Pi 原生 edit 在纯匹配阶段拒绝时明确返回 `No edits were written by this call`；写入、取消及未知错误不附加该结论。调用方须读取当前目标并重新构造匹配，不能用旧参数盲重放。
- `then_run` 的已应用 mutation 和失败验证继续分开处理。退出码及工具派发不冒充业务完成。
- 大 diff 先文件/stat 概览再按文件读；进程诊断限定相关进程与资源聚合，不倾倒全机 command arguments；过滤输出必须保留原检查的退出状态。

## bash 紧凑输出

`bash({ command, compact: true })` 将 direct 和 Codemode 的返回正文都限制为最后 **80 行或 8 KiB**，先到为准；未指定时完全保留原有 2000 行/50 KiB 的 direct 和 1 MiB 的 programmatic 合同。共用 shell 实现的 PowerShell 也接受同一参数。

- 复用现有 `OutputAccumulator`，超过界限时完整输出保留在私有权限的本地日志；没有另一个执行器、日志存储或自动总结模型。
- 非零退出仍为失败并保留精确 exit code；超时/取消仍为中断，不补成功。
- 这是有界摘录，**不是语义摘要**；日志中部的错误可能不在末尾。遇到失败或缺少所需证据时，先定向搜索/读取返回路径中的日志，不为获取输出而重复执行命令。
- 成功检查只需状态与必要汇总；失败检查必须读到实际错误位置。逐字/全文任务不因为紧凑模式而降低验收标准。
- 80 行/8 KiB 是可解释的展示上限，不是 token 估算或 provider 精确用量。升级触发条件是摘录缺证据；升级路径是回读完整日志，不是自动扩大常驻上下文。

## 验证

离线回归：Pi 的 `test/tool-efficiency.test.ts` 与既有 tools、PowerShell、legacy edit 测试；产品 `coding-policy/*.test.ts`。

真实模型：`rotom/evals/cases/tool-efficiency.eval.ts` 使用两个实际产品及其各自 Pi runtime，在合成 Git 工作区中运行真实工具。5 个自然任务（目标定位/唯一编辑/真实验证、失败日志回读、完整源码、大 diff 定向检查、进程快照聚合），每臂两次并交替顺序，共 20 轮。另有候选定向验收 6 轮：显式使用 compact 的成功/失败检查，以及首次 edit 派发前注入文件变化后的真实原生拒绝与恢复，各两次。后者是合成竞态，不是真实多人协作故障复现；模型与工具返回没有 mock。验证文件内容、检查执行次数、回答与证据，同时记录工具错误、结果 UTF-8 bytes 和 compact 使用次数。结果 bytes 不是 provider token；成本、缓存和延迟由 eval usage 单列。

已有 `tool-error-repair.eval.ts` 可补充缺失路径和歧义编辑的模型恢复检查；模型未触发错误时不能声称证明了恢复能力。固定 fixture 不证明生产任务全局收益，不以较少调用换取遗漏证据。正式 A/B 的正确性两臂均通过，但候选没有减少整体输出或模型 token，不能将此功能宣传为普遍省 token；结果见 [验收报告](../../experiments/tool-efficiency-2026-10-09/RESULTS.md)。
