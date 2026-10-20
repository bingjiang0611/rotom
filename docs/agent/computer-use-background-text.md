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

最初只在隔离目录重新签署测试副本；后续按用户选择完成独立产品目录、helper 身份和 socket 的旁路安装，权限由用户手动授予。没有替换全局 helper、默认命令或活跃会话，没有降低系统保护。产品代码同步到 Git 不等于默认本机安装已升级。

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

### 完整产品旁路安装与真实新会话验收

以下是后续新增证据，构建源为公开提交 `7098292`，产品版本仍为 `0.1.26`，Computer Use 为 `0.5.1-rotom.1`、helper 协议 7。完整产品 tgz 由 `pack:release` 构建并通过产物隐私审计，再安装到独立目录；没有发布新的 npm 版本。原始公开归档未重新签名，真实交互使用本机另行签署的 helper 副本，不能据此证明公开 ad-hoc 包的安装与权限行为。

| 检查 | 结果与范围 |
|---|---|
| 已安装产品 default/full smoke | 两种模式均绑定真实 AgentSession，生命周期错误均为 0；使用离线 faux provider，不是真实模型推理 |
| 已安装工具定义 → TS → 独立 helper → IDEA LightEdit | 六项文本检查通过，包括替换、追加、清空、中文拒绝后原值不变及拒绝后不执行批次第二步；没有前台升级 |
| 最终安装版本的前台哨兵 | IDEA 主编辑器四次后台写入均精确。约 29.45 秒内前台离开 0、哨兵失焦 0、剪贴板计数不变；287 个本窗口 keyDown 对应新增 287 字符，其中 284 个 `a`，另 3 个字符由用户确认亲自输入；每个测试秒均有本窗口输入事件 |
| 前台哨兵的失败准备对照 | 第一轮因原测试窗口已关闭而在预检停止，后台写入 0；用户确认期间切换了应用，不计为并发通过，也没有重放该轮写入 |
| 真实 CLI/RPC 模型驱动的编辑器验收 | 从旁路入口创建新会话，使用 `openai-codex/gpt-6-astra`。全文读取初始标记，只调用一次 `setText`，返回 `worked`、`background_text`、前台升级 false；模型全文回读及 CLI 退出后的独立 native AX 回读均精确 |
| 原插件名称输入框回归 | 用户打开空白查找对话框后，同一真实测试会话先核验唯一字段为空，只执行一次测试文本写入；模型全文回读和独立 native AX 回读均精确。未按 Enter、未点 OK、未改其他选项，没有业务提交 |
| 会话与安装收尾 | 测试 CLI 正常退出，独立 helper 保留运行；默认命令、默认模型及思考级别未改变，没有热替换原会话 |

真实模型测试只启用六个 Computer Use 工具，并关闭 context files/skills 自动加载；它验证这一条完整模型工具链，不代表完整交互 TUI 或所有工具流程均已验收。第一次测试白名单漏配 `read_text`，模型因无法确认全文而停在只读阶段，写入 0；补齐该工具后恢复测试，锁屏期间也暂停。没有降低初始值验证要求或重放已成功/未知的写入。

上述三次 RPC 请求的 Pi 目录价累计估算约为 USD 0.446，不是实际账单核验，也没有成本或性能 A/B 收益结论。原始会话、测试工具输出、本机路径和个人签名产物仅保留在本机，不进入公开仓库。前台哨兵只记录其自身窗口的输入计数与应用激活计数，不记录系统全局按键或哨兵原始输入文本。

旁路 helper 使用独立 bundle 身份，避免覆盖旧 helper 的权限。现有权限来源诊断按 app 文件名识别，自定义命名会被标为 `caller`；该启发式标签不是 OS 身份证明。本次另行核对精确执行路径、LaunchServices/launchd 父进程、权限状态与真实输入结果，没有把诊断标签当作隔离保证。

### 未通过或未验证的检查

Swift deterministic regression 可编译，但最近一次执行被此机的 AppleSystemPolicy 拒绝启动，后续未重跑该回归，其断言不能记为通过。前台哨兵计数自检和真实交互通过不替代该回归。真实 helper 最初也被拒绝，后在用户要求的一次诊断重试中正常启动并取得权限状态；原因未确定，未绕过系统策略。

源码中的 Swift 检查覆盖 UTF-16 选区、不可支持文本、ASCII 键映射、延迟回读、timeout 不重发、完整值比较、焦点丢失、发送失败、无改动请求和清空。运行命令（在组件目录）：

```sh
swiftc native/macos/background_text.swift test/background-text.swift -o /absolute/private/test-output
```

此命令仅编译；执行仍须符合设备策略。不要关闭 Gatekeeper、清除安全属性或修改系统信任来绕过拒绝。

早期 P0 前台哨兵使用临时探针；后续最终安装版本已完成上表约 29 秒的 IDEA 主编辑器并发测试。原插件字段另行完成单次后台输入回归，没有在该插件对话框同时重复前台持续打字，不能把两项验证合并为同一场景。长时间并发、完整鼠标轨迹、中文输入法、跨 Space/最小化窗口或任意应用仍未验证或不在当前支持范围；没有 x64 真机证据。有限观察不证明 OS 级绝对隔离。

## 后续责任

- 默认切换：旁路版本已安装并验收，但默认命令和旧会话未切换。若用户选择替换默认安装，先结束拥有旧 helper 的会话，再验证产品/helper 的一致身份；不原地覆盖活跃安装。
- 补充验证：在允许执行测试程序的环境运行 Swift 回归；有长期并发、完整鼠标轨迹或插件字段同时持续打字的需求时，另设对应验收，不用现有短时测试替代。
- 扩展范围：有真实的非 ASCII、长文本或其他应用需求时，先验证其输入与回读合同，再扩展；不用更长 sleep、包含关系判断或前台回退掩盖失败。
