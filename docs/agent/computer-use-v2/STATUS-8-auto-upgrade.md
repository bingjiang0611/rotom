# Helper 随 rotom 自动同步（源码阶段记录）

> 后续已随 [npm 0.2.1](../npm-0.2.1.md) 发布并完成实际产物原生自动升级验收。下文保留当时的源码阶段结果和失败，不把后续成功反推为旧失败已定位。

2026-11-12，维护者明确要求升级 rotom 时自动升级 helper，不再要求额外命令、停止确认或手填签名变量。此记录对应组件 `0.5.1-rotom.5`；npm `0.2.0` 和其冻结 tgz 不变。

## 行为

- `rotom update` 安装成功后，从新安装的产品运行 helper 同步；即使产品已是最新版，也检查 helper。helper 未确认同步时返回非零，不宣称整体升级成功，不回滚已经完成的产品安装。
- npm 安装保留 `--ignore-scripts`。下一次正常启动 rotom、进入 Pi 前自动同步；版本、帮助、模型列表与包管理查询不触发。RPC 的 stdout 保持 JSON，升级日志走 stderr。
- 已有受管 macOS helper 的源二进制摘要标记与 Info.plist 都相同时不停止、不重签。摘要放在已有 `Contents/Resources/source.sha256` 位置并纳入签名；直接比较重签名后的 Mach-O 字节会误判版本，因此不用它判定是否需要升级。旧安装缺少标记时同步一次。没有安装过 helper 时仍走原有首次使用安装，自定义 app 路径不自动接管。
- 更新复用已验签 app 的 Authority 对应的唯一有效签名身份。不创建证书、不导出私钥、不把证书签名降级为 ad-hoc；原本 ad-hoc 的安装仍可使用 ad-hoc。身份不可用或歧义时明确报错，不任意选择账号。
- 候选准备、签名和验签完成后，才对 PID/可执行路径匹配的 socket 发送一次 shutdown，无额外询问；确认无占用再替换。其他会话的 Computer Use 连接会断开；下一次使用启动新 helper。
- unknown shutdown/替换保留锁，后续启动不能重放；不强杀、不自动回滚。签名失败不停止旧进程。锁只串行化 updater，不能阻止旧 launcher 或外部进程启动；最终占用检查仍会拒绝竞态。
- `rotom helper update` 保留为手动修复入口，维持原有默认否的停止确认。系统权限、钥匙串可用性与执行策略不是此机制能绕过的东西。

## 验证

| 检查 | 当前结果 |
| --- | --- |
| 组件 `npm test`（含完整 TypeScript pretest） | 332/332，0 fail/skip |
| 产品 updater、分发、归档与真实启动回归 | 56/56，0 fail/skip |
| 真正的 launcher / Pi RPC 启动 | 隔离 HOME 的旧标记被替换为实际源二进制摘要，系统验签通过；get_state 成功且 stdout 全为 JSON；第二次启动不更新；version/help 不更新 |
| 启动负对照 | 只临时移除启动同步调用，测试因旧摘要未变化失败；已恢复原调用 |
| 真实签名复用 | 正常 HOME 下对隔离副本执行自动同步，不传 identity；复用已有 Apple Development 身份，系统 strict/deep 验签与密封摘要核对通过，再次同步为 no-op；未启动此副本 |
| 停止与失败边界 | Unix socket fixture 覆盖无终端自动停止、签名失败保持旧进程、错目标拒绝、失去 ack/仍占用不替换且保留锁、后续调用不重发 shutdown；另有真实 lsof 占用检查 |
| 归档 | 源码成员匹配选定归档，8 个 native prebuilt 文件与 `.rotom.4` 完全相同；版本、lock、integrity、声明和 notices 同步 |

初次全组件检查有两个编译器测试因新 checkout 未提供本地 TypeScript 失败；使用已有锁定维护依赖后完整重跑通过，没有修改或跳过这些测试。真实启动回归曾揭示摘要标记缺失、空 identity 处理和 RPC 日志通道问题，均在当前版本修正。

## 未验证与交付边界

一次单独的隔离原生 helper 启动尝试没有形成 socket。launchd 日志确认创建过进程，随后记录 app 退出；精确 PID 的系统日志与近期诊断报告未给出退出原因。没有重新启动该副本或绕过系统策略。因此，本轮**没有新增真实原生进程自动停止→替换→启动的完整成功证据**；真实签名、真实 launcher/RPC 和 socket fixture 的结果不能冒充它。隔离副本退出后清理，日常 helper 的二进制与 PID 保持不变。

没有修改 Swift、协议、B1–B6 或 GUI 操作能力，也没有真实模型请求。既有 L2 / pid 投递等限制不变。尚未发布新的 npm 产品版本，也未覆盖本机已安装的 `0.2.0`；后续发布须另行确定精确 version/dist-tag，并围绕最终 tgz 验收。真实原生自动停启仍需在可启动隔离副本的环境补验，不以本地单元测试替代。
