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
| `ROTOM_PRODUCT_VERSION` | 宿主 TUI 品牌和 trace 版本元数据；普通 shell 不需要，从 bash 启动的 rotom 会重新确定自己的产品版本。 |

`PI_COMPUTER_USE_HEADLESS` **保留给 shell**：这是公开的跨进程行为配置，不是内部身份标记。Computer Use 的 `src/config.ts` 读取它覆盖配置，原生默认 `headless:false`；剔除后，从 bash 启动的 Pi/Computer Use 可能意外恢复前台行为。launcher 只在未设置时给默认值 `1`，用户显式 `0`/`1` 均应继续传递；测试覆盖两值及默认/显式 spawn-hook 环境。它不代表任意 GUI 已有后台执行能力。

本次不增加 `PI_INTERNAL_ENV_KEYS`：宿主提供剔除名单在技术上可行，但所有直接 SDK、新旧 launcher、显式子 Pi 和自定义 hook 都必须正确传播；名单缺失时可能重新泄露已清理变量，保留旧名单又形成两套合同。当前八项稳定名称不值得新增一个可被 hook 覆盖的环境协议。将来有多个宿主确实需要不同名单或频繁增项时，优先评估 Pi 的显式 tool-construction 参数；那时再定义缺失/旧宿主兼容与传递测试，不把名单当权限边界。

选择 dispatch 边界剔除，而不是新增跨包全局注册表，保留直接子 Pi 的现有兼容合同。`check-personal` 的主动清空仍保留：检查脚本也可能从普通终端或旧版本宿主启动，不能只依赖新工具的过滤。

测试：`packages/rotom-pi/packages/coding-agent/test/bash-internal-env.test.ts` 实际运行 shell，覆盖默认环境、显式环境、普通用户环境保留及宿主环境不变。远程自定义 BashOperations 不在本机 spawn 合同内。
