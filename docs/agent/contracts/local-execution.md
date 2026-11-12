# 本机执行与安全隔离合同

> 本文最初原样搬自根 `CLAUDE.md` 第 4 节（2026-11-12 拆分；本次同步 Computer Use 候选合同），与 CLAUDE.md 具有同等约束力；改动本领域之前必须读完本文。文中出现的“本文件”指根 CLAUDE.md 连同本文。文中的具体版本号可能落后，以 `rotom/runtime/product-config.mjs` 与 `rotom/runtime/pi/fork-build.json` 为准。

Pi 原生工具、Browser 和 Computer Use 都以启动 Pi 的本机用户权限运行。产品没有 Safety、Containment、QEMU 或权限 preset/profile；Computer Use v2 新增的确认面只是一层**同意层**（App 分级、授权卡片、敏感动作确认、用户停止），它不是隔离层，也不覆盖 Pi 原生工具与 Browser 的写操作。

- 外部写执行一次，随后按同坐标 readback；失败、超时或无法证明时返回 `unknown`，不盲目重试或自动回滚。
- Computer Use 仍是本机用户权限，不是安全沙箱。v2 增加的是**同意层**而不是隔离层：跨进程 Broker 仲裁 + App 分级/授权卡片 + 敏感动作确认 + 用户停止（菜单栏项与 `Ctrl+Option+Cmd+.`）。仲裁仍按**协作式**描述：helper 的租约 token/HMAC 与撤销校验已有离线测试和原生自测，但 B4 真机未通过；helper 角色自报，同一用户下的其他进程仍在同一信任边界，不能把它写成对任意本机进程的强制隔离，也不能阻止其他程序直接使用 AX/HID。
- Computer Use 候选组件为 `0.5.1-rotom.4`，helper 协议 **11**、broker 协议 **2**。新 macOS 归档为 ad-hoc 签名，不附带维护者个人证书。旧 helper 必须由用户显式更新；不覆盖存活会话的 helper，不因协议错误静默重启。协议不匹配时询问是否停止旧 helper 以便更新；同意后只 shutdown，不重启旧二进制，同实例后续调用不重新启动它。运行 `rotom helper update`（它会询问是否停止旧 helper）：交互终端默认否，明确同意后通过已核验目标身份的 socket 关闭，确认无占用才替换；其他使用该 helper 的会话会失去 Computer Use。拒绝或非交互环境不停止、不替换，unknown 不重发 shutdown，不强杀进程。更新器只签安装副本，不创建/导出证书，不启动 helper；无身份时保留原签名与 ad-hoc 覆盖保护。目录锁仅串行化 updater，不拦截旧 launcher/外部进程启动，因此整个更新期间须保持所属会话关闭。
- 以下证据按 HANDOFF-6 保留，不表示本候选归档已经重新通过真机验收；历史版本的测试不外推到新版本。详见 [v2 状态](../computer-use-v2/STATUS.md) 与 [0.2.0 发布说明草稿](../../releases/computer-use-v2-draft.md)。

| 能力 | 证据层级 |
| --- | --- |
| Finder 后台读取、AXOpen 打开文件夹、Ask 授权弹层、授权等待不再提前放弃 | 真机，用户报告不打扰（REVIEW-18、20、22） |
| 打开文件或 App 的确认（O1） | 真机通过（用户报告，细节未留存） |
| L2 定向投递 | 真机 0 次成功、5 次失败；IntelliJ 后台点击默认走 L2（用户决定保持开启），可能不生效 |
| pid 投递 | 真机没有成功记录 |
| 后台打字、输入法分流（H2）、剪贴板恢复、前台接管暂停与恢复、租约强制校验 | 只有离线测试和原生自测（L1） |
| B 阶段 B1–B6 | 未通过；本机端点安全会终止每次换新 bundle id 的 fixture 副本 |

- 环境、发布阶段和 scope 必须来自当前请求或权威 preflight；不把预发扩大到生产、单机扩大到全量。
- `.pi/tasks/`、`.pi/delegate/`、`.pi/fusion/` 可能属于存活会话，不能当临时垃圾删除。
