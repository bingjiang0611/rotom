# Agent 内部环境边界

这些变量仍在宿主 Pi 的环境中，供模块初始化与显式创建的 Subagent Pi 读取；内置 bash/PowerShell 的本机 spawn 会复制环境并逐项删除它们，包括 spawn hook 提供的环境。不会修改宿主环境，也不是权限或秘密隔离：用户仍可读取本机文件、自定义工具仍可自行 spawn。

| 变量 | 保留在宿主/显式子 Pi 的理由 |
|---|---|
| `PI_SUBAGENTS_EXECUTION_SCOPE` | Subagent execution-store 选择 owned scope；子 Pi 必须保持同一执行所有权合同。 |
| `PI_SUBAGENTS_TEMP_ROOT` | Subagent types/execution-store 定位同一私有运行目录。 |
| `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` | Subagent 配置的环境覆盖；新子 Pi 初始化同样需要预算设置。 |
| `ROTOM_VERIFIED_PI_EXECUTABLE` | Qoder provider 从身份验证后的 Pi 定位 SDK；子 Pi 可复用该已固定路径。 |
| `ROTOM_VERIFIED_PI_VERSION` | 观测层归属版本的元数据；非子进程执行能力，任意 shell 不需要。 |
| `ROTOM_DEFERRED_DEFAULT_SURFACE` | launcher 与本进程 deferred loader 的握手；不是任意 shell 或独立新会话的授权。 |
| `ROTOM_SUBAGENT_QODER_EXTENSION` | Subagent 的 pi-args 为 Qoder 子模型显式加入已验证 provider 路径，不继承任意环境扩展。 |

选择 dispatch 边界剔除，而不是新增跨包全局注册表，保留直接子 Pi 的现有兼容合同。`check-personal` 的主动清空仍保留：检查脚本也可能从普通终端或旧版本宿主启动，不能只依赖新工具的过滤。

测试：`packages/rotom-pi/packages/coding-agent/test/bash-internal-env.test.ts` 实际运行 shell，覆盖默认环境、显式环境、普通用户环境保留及宿主环境不变。远程自定义 BashOperations 不在本机 spawn 合同内。
