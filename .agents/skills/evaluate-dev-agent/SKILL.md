---
name: evaluate-dev-agent
description: 为 dev-agent 维护改动选择并汇报风险相称的验证；模型 A/B 仅在明确授权时执行。不作为业务会话的运行时技能，也不因普通提交自动触发 canary。
---

# Evaluate dev-agent

根 `CLAUDE.md` 是维护与风险选择的单源，其按需入口 [验证与交付](../../../docs/agent/verification.md) 提供具体模块门禁；本技能不复制另一份门禁矩阵。

1. 确认 dev-agent Git 根、目标 diff 和已有 WIP；维护面 `.agents/skills/evaluate-dev-agent` 不进入 launcher、product-config 或产品 bundle。
2. 纯维护文档/Agent 指令：`git diff --check`、路径/命令/边界和适用的静态路由检查；不运行 `check-personal`、runtime 全量 gate 或真实模型 canary。
3. 代码：先受影响确定性测试，按根验证参考选择必要 smoke/扩大检查。常规产品组合才选择日常 `check-personal`；先核对实际 package.json scripts，不运行不存在的脚本。
4. 测试失败先区分本次回归、既有缺陷、环境阻塞，不直接扩大 benchmark。允许修复本次安全本地问题并重跑，不清理无关 WIP 或活跃 runtime 状态。
5. 用户明确要求比较模型行为/付费评测，且目标、成本/时长和外部权限已确定后，才读 [模型评测](references/model-evals.md)。canary/nightly/full 是已授权评测中的扩容档位，不是提交前默认动作。
6. 未授权或能力缺失时报告未执行，不改 provider/model、不上传凭证来绕过阻塞。

## 输出

给出 `PASS / REGRESSION / INCONCLUSIVE / BLOCKED`、本次范围、实际命令及结果、未验证项与必要的下一步。静态路由检查只证明文本合同，不证明模型触发率；L1/L2 不冒充真实模型或外部服务 L3。不报告未经测量的性能/token 收益。
