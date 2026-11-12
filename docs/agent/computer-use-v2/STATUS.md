# Computer Use v2.1 当前状态

本页按 HANDOFF-6 与阶段 2 审核 REVIEW-25（`f06cbb6`）收敛。它替代旧版协议 8 的笼统结论；历史记录保留在各 STATUS / evidence 文档和 Git history 中，不据此扩大本候选的真机证据。

## 候选与发布边界

- main 候选组件：`@injaneity/pi-computer-use@0.5.1-rotom.4`；helper 协议 **11**，broker 协议 **2**。
- 用户已授权将来发布 **0.2.0 / latest**（HANDOFF-6 的 `d6c17a6` 补充）。产品版本目前仍为 **0.1.27**；等功能合入 main 后，再用独立提交冻结发布元数据。
- 本轮只交付 `claude/computer-use-v2.1-main-candidate`，不推 main、不发布、不登录 npm，不改变日常安装或 helper。
- [发布说明草稿](../../releases/computer-use-v2-draft.md) 最前面列出必要升级步骤。**旧 helper 未更新时会报协议不匹配；仅升级 rotom 不够。**

## 保留的证据等级

| 能力 | 证据层级 |
| --- | --- |
| Finder 后台读取、AXOpen 打开文件夹、Ask 授权弹层、授权等待不再提前放弃 | 真机，用户报告不打扰（REVIEW-18、20、22） |
| 打开文件或 App 的确认（O1） | 真机通过（用户报告，细节未留存） |
| L2 定向投递 | 真机 0 次成功、5 次失败；IntelliJ 后台点击默认走 L2（用户决定保持开启），可能不生效 |
| pid 投递 | 真机没有成功记录 |
| 后台打字、输入法分流（H2）、剪贴板恢复、前台接管暂停与恢复、租约强制校验 | 只有离线测试和原生自测（L1） |
| B 阶段 B1–B6 | 未通过；本机端点安全会终止每次换新 bundle id 的 fixture 副本 |

以上不是本候选或未来 npm tgz 的新真机验收。旧文档里的测试行数、截图相似、源码构建成功和 isolated fixture 的通过，都不能替代此表或最终 artifact 验证。

仲裁仍按**协作式**描述：helper 已有 token/HMAC、过期和撤销校验实现，但 B4 未通过真机验收，角色自报也没有变成本机同一用户下的身份隔离。Computer Use 是同意层，不是 OS 沙箱。

## 已完成的代码与离线工作

- 完整 TypeScript 检查已恢复为 `pretest`；类型问题与运行时问题分开处理。
- O1 的目标核验和 wire 参数修复已进入组件；Ask UI 保留原生问卷/弹层，不把权限选择变成模型的普通问答续跑。
- 两个 macOS 构建入口共用完整 Swift 列表；显式更新命令能对安装副本使用已有签名身份。
- main 的协议确认/错误提示、permission readiness 修复和 broker 并发测试收尾修复保留，不用旧分支覆盖它们。
- 历史阶段 2 结果见 [类型检查](STATUS-3-typecheck.md)、[只读签名调查](STATUS-3-signing.md)、[阶段 2 归档](STATUS-3-archive.md)。其中归档摘要属于审核分支当时的产物；main 候选合并后重新打包的摘要以 [vendor 清单](../../../rotom/extensions/third-party/vendor/README.md) 为准。
- 本轮 clean-main replay、冲突处置和最终检查记录见 [main 候选报告](STATUS-4-main-candidate.md)。

## 更新 helper

1. 退出所有所属 rotom 会话，并退出旧 helper；在整个更新期间保持关闭。
2. 受管 Mac 先把 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 设置为已有、获准的签名身份；没有身份或策略不允许时停止。
3. 用户运行 `rotom helper update`，安装到 `~/Applications/pi-computer-use.app`。命令不启动 helper，不杀进程，不创建/导出证书。无身份时保留归档签名和 ad-hoc 覆盖保护。
4. 命令明确成功后，再开新会话检查协议和权限。自定义 app 路径/socket 不自动迁移。

更新器对占用或未知占用状态拒绝写入，但它的目录锁不是 OS 启动锁。签名校验也不是企业策略批准或实际启动证明。macOS 的 ScreenCaptureKit 可能按系统策略每月显示屏幕录制确认弹窗，需要用户自行处理。

本候选没有执行日常更新。最终产品 tgz 的受管 Mac helper 启动与 diagnostics 仍是发布前单独的验收门；被终止就停止，不绕过安全软件。

## 历史证据入口

- [真实机器会话记录](evidence/real-machine-session.md)
- [早期并行验收记录](evidence/acceptance-run.md)（历史 scope，不外推为当前 B1–B6 通过）
- [逐项行为变化](behaviour-changes.md)
- [O1 wire 修复](STATUS-2-open-request-wire.md)
- [原生 Ask 授权适配](STATUS-2-ask-approval.md)
