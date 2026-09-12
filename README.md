# rotom

基于 [Pi](https://github.com/earendil-works/pi) 的个人 coding agent 能力包：组合编码工具、Browser / Computer Use、按需 Subagent 和本地执行观测，不重写 Pi 的运行时。

**产品公开名称与计划仓库名均为 rotom（全小写）。** 当前处于发布准备阶段，尚未创建远端或正式发布，也没有可对外宣称的完整 benchmark 成绩。

## 当前能力与边界

- 原生编码工具与执行规范：保留业务项目 cwd、用户参数和项目上下文。
- Browser relay 与 Computer Use：按目标、观测和结果证据操作；未知写入结果不自动重放。
- 按需 Subagent：通过 `search_tools` 加载，默认工具面保持精简。
- 本地 observability：记录必要 metadata，不把 trace 当成 prompt 或正文审计系统。
- Qoder 原生直连（显式 opt-in）：保留只读 CLI 登录态，支持显式独立浏览器登录（隔离登录/串行真实刷新已实测，非自然到期验证）、账号目录发现，以及当前 Default 目录的 17 条已验证路由（含 Sonus）；13 条 reasoning 路由支持原生推理与工具往返，其中八条按实测白名单与当前目录交集开放 thinking 档位，未通过的目录项或档位不冒充可用；仅 Ultimate、Kimi-K3、DeepSeek-V4-Flash 开放 PNG/JPEG/WebP 与 272K 管理窗口（与 Codex 声明一致；实测上游可吃超过 272K 输入，产品窗口内输出仍≤4096）；支持服务端 Credit 观察和只读额度快照，缺失计量保持 unknown；仍属 experimental，上游许可/长期支持与美元费用未知，见[产品用法](rotom/README.md#qoder原生-provider显式启用)。

本机执行**不是安全沙箱**，当前没有统一权限确认层。新 Browser 按键的真实 Chrome 验收、完整发布评测及跨平台支持仍有待验证，详见发布准备记录（详见维护仓库）。

## 名称与现有入口

已提供本地 npm 发行包：安装时自动安装固定 Pi，并携带锁定的扩展依赖。不迁移维护者现有全局安装或本地仓库目录：

| 项目 | 当前值 |
|---|---|
| 产品名 / 计划仓库名 | `rotom` |
| 仓库目录 | 以实际 Git checkout 根为准，不依赖维护者路径 |
| 运行时产品目录 | `rotom/` |
| npm 公开命令 | `rotom`（`rotom/bin/rotom`） |
| 内部启动入口 | `rotom/bin/rotom-launcher` |
| 内部 ID 与环境变量 | 保持现状，包括 `dev-agent`、`ROTOM_*` |

当前未发布到 npm，不能直接运行 `npm install -g rotom`。本地 tgz 的安装方式见[产品说明](rotom/README.md)。要求 Node.js 24+；macOS 与隔离 Linux VM 已通过本地安装、CLI 和 runtime smoke；Windows 原生入口不受支持。

## 文档

- [产品说明与安装](rotom/README.md)
- [评测入口](rotom/evals/README.md)

## 名称与许可说明

rotom 名称取自宝可梦洛托姆。这是独立项目，不是 Pi 或宝可梦官方产品，不暗示官方授权或关联。本仓库未采用官方角色素材；名称重名、商标/IP 使用、根项目许可证及第三方分发通知仍需在公开发布前完成审查。
