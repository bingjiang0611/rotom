# IDEA 后台文本输入：合同与验证

## 产品接入

Computer Use fork `0.5.1-rotom.1`、macOS helper 协议 7。源码、vendor tgz、第三方 manifest/lock、product config 和分发文件清单已同步；不改变 rotom npm 产品版本，也不等于安装或发布。

macOS headless 单步与批量请求统一采用 `background_text`。只对 `com.jetbrains.intellij` 的 ref-bound `setText` / `typeText` 选择新路径，且在任何 AXValue 写入之前决定；不是一次 AX 写入结果未知后的自动兜底。其他应用保留现有路径，非文本操作不新增菜单、点击、拖放或任意快捷键能力。

## 输入合同

- 精确验证 AX 窗口原生编号、owner PID、字段所属窗口、可读完整值和选区。窗口须在当前桌面可见，应用未隐藏。普通 outline 的启发式 AX/CG 配对不足以授权键盘输入。
- 合成目标内部 key-window，不调用 `activate()`、窗口抬升、全局 HID、剪贴板或 Cmd+A。选区用 AX 设置并回验。
- 仅支持可打印 ASCII，单次 replacement 最多 256 个字符。拒绝换行、Tab、中文/IME 等文本。空 setText 用一次 Delete 清除已回验的全选范围。
- 输入等待总预算 8 秒，每字符回读预算 2 秒；预算不是硬实时保证，AX 调用和前后观察本身也有耗时。256 是允许请求的上限，不保证能在预算内输入完 256 个字符。
- 每字符前验证前台 PID、目标焦点、窗口归属、完整旧值和选区；每字符后验证完整新值与插入点，而非字符串包含关系。已派发后的超时、焦点变化或不匹配返回 `unknown`；未发字符的不支持状态返回 `background_unsupported`。
- 不重发字符、不重放批次、不切前台、不自动回滚。native batch 与 TS 顺序批处理均在 `didnt` 或 `unknown` 后停止。
- AXValue 接受但回读不符返回 `unknown`，不能借 `foreground_required` 自动再次写入。

这不是 OS 输入隔离：应用自行激活只能在检查发现后停止，不能承诺绝对阻止。英文短文本输入成功不等于所有 GUI 操作受支持。

## 构建、签名与升级边界

`node scripts/build-native.mjs --arch all --sign-identity -` 同时构建 arm64、x64 和安装器优先选择的 universal app，避免旧 universal bundle 遮蔽新二进制。归档内 macOS helper 为 **ad-hoc 签名**，不是 Developer ID 签名或公证产物；不包含维护者个人证书签名。Windows/Linux 原生文件保留上游字节。

原 npm 包漏发了构建器所需的两个 cursor Swift 文件；本次从 upstream `v0.5.1` 的固定 commit 恢复，来源见组件 `UPSTREAM.md`。

安装器拒绝静默用 ad-hoc bundle 覆盖已有 helper。升级前须关闭拥有旧 helper 的会话，再由用户明确选择 `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`，或使用单独签名、单独 app 路径和 socket 的 helper。环境变量不覆盖系统执行策略，签名变化也可能要求重新检查 macOS 权限。协议/路径不匹配不再自动重启别的会话的 daemon。

本次只在隔离目录重新签署测试副本；没有替换全局 helper、授权系统权限或降低系统保护。当前用户会话仍是旧版本；产品代码同步到 Git 不等于本机升级。

## 当前源码/产物的验证

环境：本机 macOS 27.2、arm64、Node 24.18.0。具体业务数据和本机路径不进入公开记录。

| 检查 | 结果与范围 |
|---|---|
| `cd packages/rotom-computer-use && npm test` | 8 项通过：无隐式重放、unknown 不因 legacy opt-in 重放、helper 协议/路径不匹配不重启 daemon、ad-hoc 安装保护保留原 fixture 字节 |
| 原生构建 | arm64、x64 与 universal 构建通过；universal 签名与架构检查通过。没有 x64 真机执行证据 |
| `node --test rotom/runtime/third-party-archive.test.mjs rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/distribution.test.mjs` | 74 项通过，包括当前源码与选中 tgz 的字节一致性、双架构签名/无个人证书及产品身份合同 |
| 隔离依赖安装 | 按仓库既定 `--ignore-scripts --omit=optional --legacy-peer-deps` 合同完成，未执行 helper 安装脚本；最初漏加 legacy-peer-deps 的安装命令失败，未修改锁以迁就该错误 |
| 第三方真实 loader 总测试 | 15/16 通过；Subagent actionless workflow 断言失败，在未修改的公开基线 `0e9228e` 独立 worktree、全新依赖安装中同样复现。本次不修 Subagent |
| 真实 MaxCompute 输入框 | 使用最终 tgz 安装出的 arm64 helper 的隔离重新签名副本，替换、追加、中文拒绝且原值不变、清空、最终全文回读通过；未按 Enter/OK |
| 批处理拒绝 | 首步中文输入返回 `didnt`，仅执行 1 步、`stoppedAt=0`，第二步未发生，字段不变 |
| 真实预算耗尽对照 | 256 字符请求约 8.839 秒后返回 `background_input_unknown`，回读为 109 字符的部分输入；仅执行 1 步、`stoppedAt=0`，第二步标记没有出现。未补发、重放或自动清空 |

真实输入检查使用独立 helper 的 stdin 请求通道，不是对当前运行 session 热替换后的工具调用。重新签名只改变本地测试副本的签名；公开归档仍为 ad-hoc，安装/授权行为不能由该测试替代。最终留下的查找框内容只是临时测试文本，用户可用 Cancel 丢弃，没有业务提交。

### 未通过或未验证的检查

Swift deterministic regression 可编译，但该测试可执行文件仍被此机的 AppleSystemPolicy 拒绝启动，其断言不能记为通过。真实 helper 最初也被拒绝，后在用户要求的一次诊断重试中正常启动并取得权限状态；原因未确定，未绕过系统策略。

源码中的 Swift 检查覆盖 UTF-16 选区、不可支持文本、ASCII 键映射、延迟回读、timeout 不重发、完整值比较、焦点丢失、发送失败、无改动请求和清空。运行命令（在组件目录）：

```sh
swiftc native/macos/background_text.swift test/background-text.swift -o /absolute/private/test-output
```

此命令仅编译；执行仍须符合设备策略。不要关闭 Gatekeeper、清除安全属性或修改系统信任来绕过拒绝。

早期 P0 前台哨兵测试使用临时探针，不是最终产物。最终版本尚未重新验证用户持续输入时的无干扰性、长时间并发、完整鼠标轨迹、中文输入法、跨 Space/最小化窗口或任意应用。仅有状态采样和前后比较时，不宣称绝无瞬时焦点变化。

## 后续责任

- 本机生效：用户选择产品与 helper 的一致升级方式，并先结束旧会话；Agent 在得到安装授权后验证实际安装版本和真实工具调用，不原地覆盖活跃安装。
- 补充验证：在允许执行测试程序的环境运行 Swift 回归，并对安装后的最终版本做前台哨兵与并发测试；这不是扩大当前支持范围的授权。
- 扩展范围：有真实的非 ASCII、长文本或其他应用需求时，先验证其输入与回读合同，再扩展；不用更长 sleep、包含关系判断或前台回退掩盖失败。
