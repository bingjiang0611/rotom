# Maka 2/3/4：ownership 与 evidence handoff 实验

## 冻结方案

- Baseline：`63dfc3c442e851b2f27db427b6cb0fc625b8bfa7`，已安装 `pi-subagents@0.52.1-dev-agent-followthrough.2`，不是官方 0.52.1。
- Candidate：本次 product-owned Browser/第三方组合改动；不修改 installed source，不新增工具、runtime、scheduler、checkpoint store 或 compactor。
- Advisor：第一次实际 high 的意见不算指定配置验收；第二次 `openai-codex/gpt-6-astra:xhigh` 给出 GO。它纠正了 same-instance session reset 的假设：实际 Pi 0.85.1 在 new/resume/fork/reload 中销毁旧 runtime，A→B→A 是三个实例。只承诺实例退休后的发布拒绝，不承诺取消 child 或任意包内部磁盘写隔离。
- Browser：退休时先捕获并清空资源；迟到 connect/store-open 自行关闭；store-close 等待已接纳的 I/O；旧操作不能追加 terminal/cursor。Chrome scoped dispatch 在调用前及 Promise 完成后校验 operation guard，覆盖后续操作、恢复与 rollback；已发出的效果仍可能迟到，不因失去 owner 就重放。
- Subagent：每 factory instance 一个不可复活 publication lease；同步拒绝 sendMessage/sendUserMessage/appendEntry、迟到 onUpdate/result；包仍自行管理 notifier/watchers。直接 steer 无论调用者传什么都归一化为 `steeringRecovery:false`。
- Handoff：单条 runtime guideline 保留 lane/run/session/cwd、执行与工作状态、证据路径/命令/结果/scope、revision 与 relevant dirty-file freshness、unknown 和下一步。语义完整性是指导，不是 verifier。

## 验证与 A/B

1. 无模型回归：真实 public Pi runtime 切换；受控 Promise 握手复现迟到 Browser work；exact .2 notifier debounce/max-wait、steer ack timeout；Browser guard/relay/native-host fixtures。
2. 产品 gate：check-personal、resource/package identity、full/deferred public-loader smoke 与 footprint；eval typecheck/test。代码测试不能替代真实 Chrome reload。
3. 固定八题：`rotom/evals/src/ownership-handoff-cases.ts`；前两题为 canary，仍在八题集合内。先每题一组 paired，共 16 runs，交替 baseline/candidate 顺序。
4. 两臂同为 `openai-codex/gpt-6-astra`、medium，同题、无工具、同一真实 Pi executable、独立 workspace 与冻结 product snapshot。投影各 product 自己的 Subagent/handoff guideline；这是决策微评测，不是 Chrome/worker 执行评测，不能把结果归因于 fence。
5. 授权 A/B 上限 $10 / 90 分钟；从首个模型 eval 起计时，逐组记录 supplied usage、catalog 估算成本和耗时；缺失 usage 不记为 0。先看两个 canary，有明显回归不扩容，不更换模型，不按结果修改题目/判分。不得自动重试丢失/未知的外部结果。
6. 报告每题 full-pass 与各项检查、实际 elapsed/input/output/cache/total tokens、估算成本；保留所有失败和尝试。计费目录不等于实际账单；静态 bytes 不换算成 provider 精确 token。

## 已识别的验证漂移

旧 full footprint 合同为 39,655 schema / 11,847 guideline bytes；对 exact baseline 的实测已经是 40,411 / 12,983，本次新增 136 / 868 到 40,547 / 13,851。默认 deferred surface 不变。更新 full 合同是把已存在的 .2 漂移与本次增量分别记账，未改不可变 reference。

最终数据与限制见本目录的 `maka-234-report.md`（实验完成后生成）。原始 session/eval/trace 留在本机私有目录，不提交。
