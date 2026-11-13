# Computer Use v2.1 当前状态

本页保留 HANDOFF-6 与阶段 2 审核 REVIEW-25（`f06cbb6`）的证据分级，发布进度已更新至 0.2.1 实际产物、原生自动升级与 registry 核验完成。它替代旧版协议 8 的笼统结论；历史记录保留在各 STATUS / evidence 文档和 Git history 中，不据此扩大本候选的真机证据。

## 合入与发布边界

- main 源码组件：`@injaneity/pi-computer-use@0.5.1-rotom.5`；helper 协议 **11**，broker 协议 **2**。已接入 [helper 随产品自动同步](STATUS-8-auto-upgrade.md)，不再需要独立 helper 命令或签名变量；已随 npm 0.2.1 发布，不属于 npm 0.2.0。
- 用户已授权发布 **0.2.0 / latest**；[REVIEW-27](https://github.com/bingjiang0611/rotom/blob/4936306eaee2e6bcf8d1abf530a3c7309f5871b0/docs/agent/computer-use-v2/REVIEW-27.md) 接受的功能提交 `4c7f7bb3f81843532b4d3b9adb4483cbc0056b43` 已快进到 main。
- **0.2.1 / latest 已发布并核验**，见 [发布记录](../npm-0.2.1.md)。维护者前台发布，另行授权 Agent 全局安装；19,049 个文件与固定 tgz 匹配。日常 helper 在本次 npm 安装中未修改，下次正常启动自动同步；旧会话不热升级。
- 0.2.0 记录见 [历史发布记录](../npm-0.2.0.md)；旧版本的手动步骤见下文和[历史升级说明](../../releases/computer-use-v2-draft.md)，不再作为 0.2.1 的常规操作要求。

## 保留的证据等级

| 能力 | 证据层级 |
| --- | --- |
| Finder 后台读取、AXOpen 打开文件夹、Ask 授权弹层、授权等待不再提前放弃 | 真机，用户报告不打扰（REVIEW-18、20、22） |
| 打开文件或 App 的确认（O1） | 真机通过（用户报告，细节未留存） |
| L2 定向投递 | 真机 0 次成功、5 次失败；IntelliJ 后台点击默认走 L2（用户决定保持开启），可能不生效 |
| pid 投递 | 真机没有成功记录 |
| 后台打字、输入法分流（H2）、剪贴板恢复、前台接管暂停与恢复、租约强制校验 | 只有离线测试和原生自测（L1） |
| B 阶段 B1–B6 | 未通过；本机端点安全会终止每次换新 bundle id 的 fixture 副本 |

表中 GUI 能力证据未因发布而扩大。0.2.1 的实际 tgz 原生门禁新增了自动签名复用、停止/替换/再启动、协议 11 与隔离 PID/可执行路径验证，不证明 GUI 任务或 B1–B6 通过。旧文档的测试行数、截图相似、源码构建成功和 isolated fixture 结果不能替代对应真机验收。

仲裁仍按**协作式**描述：helper 已有 token/HMAC、过期和撤销校验实现，但 B4 未通过真机验收，角色自报也没有变成本机同一用户下的身份隔离。Computer Use 是同意层，不是 OS 沙箱。

## 已完成的代码与离线工作

- 完整 TypeScript 检查已恢复为 `pretest`；类型问题与运行时问题分开处理。
- O1 的目标核验和 wire 参数修复已进入组件；Ask UI 保留原生问卷/弹层，不把权限选择变成模型的普通问答续跑。
- 两个 macOS 构建入口共用完整 Swift 列表；显式更新命令能对安装副本使用已有签名身份。
- main 的协议确认/错误提示、permission readiness 修复和 broker 并发测试收尾修复保留，不用旧分支覆盖它们。
- 历史阶段 2 结果见 [类型检查](STATUS-3-typecheck.md)、[只读签名调查](STATUS-3-signing.md)、[阶段 2 归档](STATUS-3-archive.md)。其中归档摘要属于审核分支当时的产物；main 候选合并后重新打包的摘要以 [vendor 清单](../../../rotom/extensions/third-party/vendor/README.md) 为准。
- clean-main replay 的原始检查见 [main 候选报告](STATUS-4-main-candidate.md)；REVIEW-26 M1 升级修复和审计范围澄清见 [后续修复报告](STATUS-5-upgrade-m1.md)。

## npm 0.2.1 自动同步

更新后正常启动 rotom 即可；不需要独立 helper 命令、停止确认或签名变量。实际安装的 launcher/RPC 自动同步与 updater API 的真实原生停替启分别通过；后者使用正常 HOME 的 keychain 和独立 fixture，日常 helper 在该测试期间未变。签名身份不可用或系统策略拒绝时仍报错，不绕过权限。完整范围见 [0.2.1 验证记录](../npm-0.2.1.md)。

## npm 0.2.0 的手动更新方式（历史发布版本）

1. 退出所有所属 rotom 会话，在整个更新期间保持会话关闭；无需另找 helper 的退出入口。
2. 受管 Mac 先把 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 设置为已有、获准的签名身份；没有身份或策略不允许时停止。
3. 运行 `rotom helper update`（它会询问是否停止旧 helper），安装到 `~/Applications/pi-computer-use.app`。运行中的 helper 只在交互终端明确同意后通过 socket 关闭，默认否；其他使用它的会话会失去 Computer Use。拒绝或非交互环境不停止、不替换。命令不启动 helper、不强杀进程、不创建/导出证书。无身份时保留归档签名和 ad-hoc 覆盖保护。
4. 命令明确成功后，再开新会话检查协议和权限。自定义 app 路径/socket 不自动迁移。

会话协议不匹配时只询问是否停止旧 helper，以便显式更新；不会重启旧二进制，且同一实例后续调用不重新启动它。更新器收到关闭确认后仍须读回无占用；结果未知或仍被占用时拒绝替换。它的目录锁不是 OS 启动锁。签名校验也不是企业策略批准或实际启动证明。macOS 的 ScreenCaptureKit 可能按系统策略每月显示屏幕录制确认弹窗，需要用户自行处理。

0.2.0 发布安装当时只更新了日常 CLI 的全局入口，没有更新日常 helper。该次最终 tgz 的受管 Mac 启动与 diagnostics 已按用户批准的“两步安装、签名”路径通过，隔离进程确认退出后已清理；不宣称 updater 内建签名在隔离 HOME 下通过。未来验收若被端点安全终止仍须停止，不绕过安全软件。

## 历史证据入口

- [真实机器会话记录](evidence/real-machine-session.md)
- [早期并行验收记录](evidence/acceptance-run.md)（历史 scope，不外推为当前 B1–B6 通过）
- [逐项行为变化](behaviour-changes.md)
- [O1 wire 修复](STATUS-2-open-request-wire.md)
- [原生 Ask 授权适配](STATUS-2-ask-approval.md)
