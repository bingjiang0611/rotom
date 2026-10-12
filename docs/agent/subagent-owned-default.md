# 默认 scoped 执行合同

本页描述新会话的产品默认行为，不记录某批实验的安装路径、测试计数或性能结果。产品和组件版本分别以 [`rotom/package.json`](../../rotom/package.json)、[`packages/rotom-subagents/package.json`](../../packages/rotom-subagents/package.json) 及发行 identity 为准；它们不证明当前 PATH 安装已更新。

## 默认与显式开关

[`launch-runtime.mjs`](../../rotom/runtime/launch-runtime.mjs) 在启动 Pi 前为未指定 scope 的新会话选择 `PI_SUBAGENTS_EXECUTION_SCOPE=owned-process-groups-v2`，并在 `~/.local/state/rotom/subagent-store` 锚定持久 store。已存在的锚点只复用，不替换。`--version` 探测不创建 store。

```sh
PI_SUBAGENTS_EXECUTION_SCOPE= rotom         # 显式空值：旧 scope，不创建/触碰 owned store
PI_SUBAGENTS_TEMP_ROOT=/absolute/path rotom # 自定 owned store 位置，必须是绝对路径
```

非法 scope、相对或空 store 路径、缺少 HOME、不可读 store、身份或拓扑漂移会在启动 writer 前失败，不回退、重建锚点或自动修复。删除整个 base 只会围栏旧记录，不授权恢复、重放或解除旧容量。

- store 锚点定义 `storeId`，因此直接改写该值不等同于可检测的身份漂移。校验包含路径、inode、owner/permission、解析和 device topology。
- Darwin 重启可能重编号 mount device；v3 仅允许受控目录的 device 一致双射，不改 marker。Linux 保持精确 device 匹配。旧 store 版本不能通过重复 init 自动升级。
- 默认切换不迁移、升级或回放既有会话。存活进程保持原路径、原语义；安装或 capacity 释放不授权热替换未知工作。

完整状态机、资源类型和 schema 以维护组件的 [owned-execution.md](../../packages/rotom-subagents/docs/owned-execution.md) 为准。启动与资源合同在 [`product-config.mjs`](../../rotom/runtime/product-config.mjs)；维护流程见 [subagent-source-maintenance.md](subagent-source-maintenance.md)。

## Agent 与监督

内置 `worker`、`scout`、`reviewer` 显式声明 extensions 和 fresh context。用户/项目 overrides 的配置优先级不绕过当前 scope 的启动限制；不支持的 fork、worktree、嵌套、gate/review 或独立 foreground 形式仍在 writer 前拒绝。自定义 Agent 必须满足当前声明和工具合同，不能依赖隐式 ambient extensions 扩大能力。

子 Agent 通过 `contact_supervisor` 提问；父侧 `subagent_supervisor` 使用 list/reply/pending/status 回应。监督消息不替代冻结的任务权限或验收合同。任务结果、进程关闭和业务效果必须分别判断。

## 安全与恢复边界

- scoped 执行管理归属和已登记资源的关闭，不是文件系统或工具沙箱；工具仍以本机用户权限执行，显式 extensions 是可信本地代码。
- 启动范围和允许字段以当前维护组件的 schema 为准，不用旧实验命令扩张能力。旧任务、schedule/mission 历史数据不迁移或自动重放。
- 关闭证明只覆盖已登记的受控资源；`descendantCoverage` 与 `effectVerification` 仍为 `unverified`。关闭、初始化、preflight 和 capacity 释放都不是业务成功或恢复授权。
- unknown、身份失配、closure 缺口或失效 canonical lease 不因普通重试、监督回复或删除文件而变为可恢复。恢复须满足当前任务、资源关闭和独占 writer 合同。
- 旧模型对照和 metadata 字节变化不构成性能等效、提速、费用节省或真实业务效果证明。

## 验证入口

[verification.md](verification.md) 是产品验证入口；launcher/store 合同回归在 [`verify-pi-runtime.test.mjs`](../../rotom/runtime/verify-pi-runtime.test.mjs)，发行面回归在 [`distribution.test.mjs`](../../rotom/runtime/distribution.test.mjs)。维护组件提供 unit、SDK、typecheck 和 product 门禁，具体脚本以其 `package.json` 为准。

运行前核对当前脚本及所需输入；缺少旧 preimage 的历史兼容 harness 只能在匹配的隔离历史 checkout 调查，不能重建兼容壳或重放 unknown 工作。真实模型、桌面、跨平台及安装/升级必须记录实际版本和本次验证，不沿用历史 PASS。本页不授权付费请求或活跃会话升级。
