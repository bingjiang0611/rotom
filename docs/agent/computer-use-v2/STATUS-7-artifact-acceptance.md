# Computer Use v2.1 · 0.2.0 验收通过，待发布审核

日期：2026-11-12。实际环境：macOS 27.3 / arm64、Node 24.18.0、npm 12.2.0。

**同一个最终 tgz 已完成本次验收，包括用户明确批准的“两步安装、签名”原生启动门禁。尚未发布。** [前次 blocked 记录](STATUS-6-artifact-acceptance.md)保留，不用后来的成功覆盖此前失败。

## 冻结源与产物不变

唯一构建源仍为 `8e1fe0c50273f50926709324c38d1c7dadbdfd25`，`ab7d49a` 作废。本轮没有修改产品源码、测试、归档或锁文件，没有再运行 `pack:release`。维护开发依赖仅按现有锁文件安装；冻结 clone 的 tracked tree 干净。

审核记录只提交到 `claude/rotom-0.2.0-artifact-review`，不推 main，不成为新的构建源。保留 `claude/computer-use-v2.1-main-candidate`。

| 产物字段 | 值 |
|---|---|
| 文件名 | `bingjiang0611-rotom-0.2.0.tgz` |
| 普通文件数 | 19,049 |
| 压缩 / 解包大小 | 34,088,284 / 147,162,933 bytes |
| SHA-256 | `636dc80bd2466d6823d5efdd7ac0a34897adebf9b31c61bb9bdbdbedac980d9e` |
| SRI | `sha512-BgoZK+ITxR2C3hwxTS512udGddvfWdYQzI1JTR1i1ehQb6Icqp5fJkXFnx26TZkzC+L9A/wXYTkjEnF+e6hGMg==` |

## 测试与安装证据

| 检查 | 结果 | 范围 |
|---|---|---|
| 实际 tgz 审计 | 0 findings | 前次实际包审计；本轮回读摘要未变 |
| 隔离升级 | 0.1.27 → 0.2.0 | 前次真实 npm prefix 升级、两端版本回读，针对同一 tgz |
| default/full smoke | 通过 | 前次实际安装：26/33 active tools、0 lifecycle errors；不是源码目录替代产品安装 |
| 再次安装字节核对 | 19,049 个文件全部匹配 | 本轮新隔离 prefix 安装同一 tgz；签名和启动后再次逐文件比对安装包与 tgz |
| Context Layers 定向 | 6/6 | 维护 Pi 与最终 tgz 的已安装 Pi 分别运行，均通过 |
| Browser ownership 定向 | 29/29 | 原测试、原 timeout，未放宽或跳过 |
| 完整 check-personal | exit 0，约 734.82 秒 | 新隔离 HOME；`ROTOM_PI` 指向本轮真实 tgz 安装，未注入原生验收专用 socket/app 覆盖 |
| 上述 gate 的主测试阶段 | 597/597，0 fail/skip | 包括此前失败的 Context Layers、Browser ownership 和 Provider guard |
| 上述 gate 的 Provider 阶段 | 9 组 PASS | Qoder 282/282、Pi AI 98/98，及 7 组离线 fixture/smoke；报告明确不是 live 或完整 installed-product Provider 验收 |
| 上述 gate 的 Goal 阶段 | 99/99，0 fail/skip | 原生 SDK 的确定性测试 |
| 上述 gate 的 footprint 阶段 | deterministicGate PASS | 完整脚本正常结束，不以中间 PASS 冒充全套成功 |
| 卸载与清理 | 通过 | 真实隔离 npm uninstall；签名 helper 已先退出，再删除 HOME/cache |

### 前次失败的处理，不改验收标准

新隔离环境的第一轮完整 gate 获得了真实终态：597 项中 594 pass / 3 fail，不再仅有超时日志。证据包括维护面 Pi 的 `vitest` 开发依赖缺失、Subagent loader 的依赖加载失败，以及 Provider offline guard 子进程未返回预期退出码。

按锁文件补齐 `packages/rotom-pi`、`packages/rotom-subagents` 开发依赖后，先跑受影响的定向 gate，再运行完整 `check-personal`，结果如上。没有修改测试断言、跳过测试、增加产品兜底或重新打包。Provider 源码测试依赖不属于最终产品安装内容。

早先全部超时的唯一根因仍未被证明，不能把它们全归因于依赖、路径覆盖、主机负载或端点安全。当前判断以同一冻结版本本轮完整 gate 的终态成功为准；旧失败、诊断和本轮日志都保留。

## 签名边界：用户批准了两步验收

只读诊断证明：正常 HOME 的用户钥匙串列表有一项，能发现一个与日常 helper 一致的 Apple Development 身份；隔离 HOME 的列表为空，发现 0 个有效身份。没有创建、导出或复制身份，也没有修改钥匙串搜索列表。

执行方曾提出两个不可行方案，并在实际失败后明确纠正：

1. **整个 updater 使用正常 HOME**：现有 `helper update` 强制写 `HOME/Applications/pi-computer-use.app`，忽略运行时 app-path 覆盖。因此触及日常 helper 的占用检查，被非交互保护拒绝；没有 shutdown、签名、复制或替换日常 helper。
2. **PATH codesign wrapper**：updater 固定调用绝对路径 `/usr/bin/codesign`，wrapper 未被使用；隔离 HOME 下真实 codesign 返回 `no identity found`，暂存候选由 updater 清理，没有完成 app 安装。

这不是“换一个身份”或绕过保护的理由。执行方停止并说明限制，用户随后明确选择以下两步验收，且接受它**不证明 updater 内建签名分支在隔离 HOME 下可用**：

1. `rotom helper update` 在隔离 HOME 安装来自实际 tgz 的新 helper 副本，不传签名身份，不启动 ad-hoc 副本。目标此前不存在，不替换已有 helper，不开启 ad-hoc replacement 例外。
2. 正常 HOME 下直接调用真实 `/usr/bin/codesign`，用同一个已有 Apple Development 身份，仅签名这个隔离副本。参数与 updater 的签名参数一致；不修改产品安装包、钥匙串或证书配置。
3. 恢复隔离 HOME，直接运行系统 `/usr/bin/codesign --verify --deep --strict`，独立确认非 ad-hoc 签名、bundle identifier 和批准身份。临时 wrapper 删除，不参与验签或启动。

## 受管 Mac 原生门禁

只对签名后的隔离 app 执行一次 `open -n -g <isolated-app> --args serve --socket <isolated-socket>`，没有使用 bundle-id 解析，也没有启动未签名副本或重复启动。

| 项目 | 结果 | 证据 |
|---|---|---|
| 真实 helper 启动 | 通过 | 隔离 socket 的 diagnostics 返回成功 |
| 协议 | 11 | 实际响应的 `protocolVersion` |
| 进程 | PID 11972 | 实际响应，并与 OS 进程映射核对 |
| 可执行文件 | 隔离副本 | diagnostics 的 executablePath 与 `lsof -p <pid> -d txt` 均指向本次 HOME 内 `Applications/pi-computer-use.app/Contents/MacOS/bridge` |
| 实例停止 | 通过 | 只发送一次 shutdown，随后确认该 PID 退出；没有强杀或重放 |
| 日常 helper | 未改变 | 二进制 SHA-256、PID、启动时间与本轮前一致 |

本次没有观测到新 helper 被端点安全终止。诊断中的 Accessibility/Screen Recording 为 preflight 布尔值，不是实际截图或 GUI 任务成功证据。现有 L2 0 成功 / 5 失败、pid 定向派发无真实成功、B1–B6 未通过的边界不变；这里验证 PID 只是确认实例身份。

## 清理、发布状态与交接

- 已保存日志，再完成隔离 npm 卸载。所有本轮 HOME/temp 目录经打开文件检查后删除；签名 helper 仅在确认退出后删除。产物与证据保留在 HOME 外。
- 证据包括完整 gate 的 `output.log` / `result.json`、签名验证、native diagnostics、OS executable 映射、一次 shutdown 与退出回读、安装字节核对和 `cleanup.json`。原始本机路径、签名身份元数据与日志不上传 Git。
- Git 账号只读认证正确；同一 SSH 目标的 dry-run、正常推送、远端回读成功，前次审核报告 `4910b32d` 已上传。没有确定前次失败的根因，不称为权限不足或安全客户端拦截。
- `npm-release-handoff.mjs preflight <final-tgz> latest` 只读检查通过：0.2.0 尚不存在，latest 为 0.1.27。这是当时状态；真正发布前仍须复核。
- 已用 `npm-release-handoff.mjs commands <final-tgz> latest` 生成命令，仅作为本机审核交接材料。**没有执行 npm login、whoami、publish，没有切换日常安装，没有创建 release tag。**
- 等本次报告审核通过，再按[正式发布合同](../contracts/npm-release.md)逐段交给用户在前台终端执行。只有 registry version/tag/digest 与实际下载字节全部一致，才可称为发布完成。
