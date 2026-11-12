# 本机执行与安全隔离合同

> 本文原样搬自根 `CLAUDE.md` 第 4 节（2026-11-12 拆分，未改写语义），与 CLAUDE.md 具有同等约束力；改动本领域之前必须读完本文。文中出现的“本文件”指根 CLAUDE.md 连同本文。文中的具体版本号可能落后，以 `rotom/runtime/product-config.mjs` 与 `rotom/runtime/pi/fork-build.json` 为准。

Pi 原生工具、Browser 和 Computer Use 都以启动 Pi 的本机用户权限运行。产品没有 Safety、Containment、QEMU 或权限 preset/profile；Computer Use v2 新增的确认面只是一层**同意层**（App 分级、授权卡片、敏感动作确认、用户停止），它不是隔离层，也不覆盖 Pi 原生工具与 Browser 的写操作。

- 外部写执行一次，随后按同坐标 readback；失败、超时或无法证明时返回 `unknown`，不盲目重试或自动回滚。
- Computer Use 仍是本机用户权限，不是安全沙箱。v2 增加的是**同意层**而不是隔离层：跨进程 Broker 仲裁 + App 分级/授权卡片 + 敏感动作确认 + 用户停止（菜单栏项与 `Ctrl+Option+Cmd+.`）。仲裁目前是**协作式**的：helper 侧尚未校验 lease token 的 HMAC 与撤销列表，所以它约束我们自己的客户端，不阻止别的进程直接调用 AX/HID。这些只保证“通常不会有两个 agent 同时写同一个 App”“用户能被问道并随时停掉”，不限制 agent 在本机还能做什么。
- Computer Use `0.5.1-rotom.3` 的 macOS headless 文本路径仅对 IDEA 提供精确窗口绑定、内部合成焦点和逐字符完整回读；限可打印 ASCII、256 字符及有界等待，未知即停批次，不代表任意 GUI 或绝对无干扰。helper 协议已升到 8（用户活动、剪贴板、App/窗口管理、系统表面、语义 AX 动作、L2 定向投递）；协议不匹配仍不自动重启已有 daemon，禁止覆盖存活会话的 helper。新 macOS 归档为 ad-hoc 签名，覆盖已有 helper 需显式授权。L2（`SLEventPostToPid`）按运行时解析、白名单（仅 IntelliJ）与 `ROTOM_CU_L2=0` 开关；该路径**至今未在真机执行**（只有编译级证据）。真机跑通的是语义 AX 路径：3 个 fixture 实例后台并行时前台 App 与光标不变；pid 投递（`CGEvent.postToPid`）在真机上也还没有正例（见 v2 状态与 `docs/agent/computer-use-v2/evidence/real-machine-session.md`）。真实插件检查、Swift 测试执行受限和未验证范围见 [后台文本输入](../computer-use-background-text.md) 与 [v2 状态](../computer-use-v2/STATUS.md)。
- 环境、发布阶段和 scope 必须来自当前请求或权威 preflight；不把预发扩大到生产、单机扩大到全量。
- `.pi/tasks/`、`.pi/delegate/`、`.pi/fusion/` 可能属于存活会话，不能当临时垃圾删除。
