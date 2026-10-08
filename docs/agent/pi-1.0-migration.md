# Pi 1.0 非 MCP 能力迁移

## 范围

- 上游 tag `v1.0.4` / commit `7c10bd4337495ee613f2224843ecdf349b80d1df`，fork `1.0.4-rotom.0`；模型目录取自官方 `@earendil-works/pi-ai@1.0.4`，逐文件摘要在 `FORK.json`。
- 保留 rotom 模型选择器/思考档位、品牌与启动页、session ID、Qoder Credit/动态目录、产品更新和压缩来源/取消修复。
- 同步 Codemode、分类/图片模型、虚拟模型路由 API、全屏与上下文管理；内置 MCP 不注册、不自动连接，源码及依赖保留。Jev 路由示例不是默认策略，没有自动增加真实分类请求。
- 普通文件工具可由 Codemode 编排；Goal/Ask/Subagent/Browser/Computer Use 使用上游 `model-only`。显式工具选择优先，Subagent 保留 additive 加载及恢复合同。
- Goal `0.54.4-rotom.6` 累计 assistant、tool-result、独立 usage、compaction/branch-summary 的已报告 tokens，不重复计入工具明细。旧 Goal baseline 一次迁移，不追收旧辅助用量。虚拟模型 reviewer 使用最近实际执行模型，不额外路由；缺少该模型时 unknown。
- Qoder 请求在 adapter 边界通过 Pi 原生 transcript helper 重放 prompt sections 和 tool additions/removals；不丢失工具，也不恢复已经移除的工具。
- runtime 从六包扩展至八包，新增 `pi-codemode` / `pi-mcp` 同样使用自建归档和 identity gate。传递依赖允许位于 fork 包内，但仍拒绝隐藏的上游 Pi 副本。`ROTOM_PI` 覆盖须支持 `createCodemodeExtension`。

## 本地验证（macOS arm64，Node 24.18.0）

- 隔离 `npm run build:pi`：workspace offline build 与 22 个 focused 文件通过，255 passed、2 个真实模型测试 skipped；`check:pi` 绑定来源和构建器摘要。
- Goal source typecheck 与 70 tests 通过，包含真实 SDK 的 continuation/reviewer、mixed batch 拒绝、新用量及 legacy baseline、虚拟 reviewer。
- Provider 九组离线 gate 通过，网络/凭据隔离：Qoder 单测、Pi AI 定向单测、浏览器 OAuth fixture、direct/COSY 工具续轮、会话恢复/压缩/取消、错误尾帧和 output budget。没有真实 Qoder/Jev/图片请求。
- `check-personal`：311 项产品测试、70 项 Goal 测试、九组 Provider gate 与 default footprint PASS；独立 runtime identity 39 项、隐私审计器 13 项通过。
- default/full SDK smoke 通过：真实 Codemode worker 读取文件、控制工具不可被嵌套调用、显式工具列表不被扩展、无 MCP 命令，lifecycleErrors=0。

所有结论仅覆盖被执行的版本、平台和 fixture。真实 Chrome、外部模型、计费、存活会话升级与 Linux/Windows 不在本轮授权验证范围。未发布 npm、未替换本机活跃安装。

## 保留的问题与修复证据

- 初次源码依赖安装超时，确认原进程已退出后改用明确 registry，安装成功；未放宽构建器 timeout。
- 上游模型目录布局变化导致 offline build 缺 `azure.json`；改用正式包的固定数据，而非临时联网刷新目录。
- Qoder 原生会话最初因 transcript 中的工具声明未重放而返回 `invalid_tool_call`；修复 adapter 后原场景与新增 additions/removals 回归通过。
- CLI/PTY 启动发现 Codemode 原生与产品 wrapper 重复注册警告；产品启动不再加载原生副本，独立 Pi 保留原生入口，新增两种启动身份回归。PTY 的完整交互未完成：离线 guard 阻断可选 Computer Use setup，后续尝试超时，已终止本次临时 HOME 下的 native bridge；不据此声称视觉或设备验证通过。
- 本机高负载造成两次隔离重建超时、一次清理竞态及定向测试超时；未增加 timeout。负载降低后隔离构建与 focused 回归通过。
- 一次直接运行上游测试继承产品品牌环境，standalone Pi 断言失败；清理环境后 22 文件通过，未改断言掩盖污染。
- 原检查继承了存活旧安装的 `ROTOM_VERIFIED_PI_EXECUTABLE`，导致 loader 测到旧 API；检查入口现明确绑定本次解析的 executable。
- 公开前仅从干净公开 clone 重放 diff，不携带本地维护分支。新增隐私例外涵盖逐字节核对上游 tag 的 bug-report/crash-log 合成测试，以及与锁定官方归档核对的 Node 类型文档完整行；未放宽敏感数据规则。Codemode 文档路径只在 footprint 门禁比较时规范化，原始字节数仍完整报告，不冒充 provider token。
