# rotom 0.1.17

状态：发布准备；用户已明确授权 `@bingjiang0611/rotom@0.1.17` / `latest`，尚未执行 npm publish。access 为 `public`，许可证保持 `UNLICENSED`。产品改动已同步公开 main，源码起点由 Git 读取：`3b679f37e3457d2e16e2c8ec2ca9ae1a5dfb8a23`。最终构建源为本次发布元数据冻结提交，后续验证结果不能预先视为通过。

## 发行说明

- 内置 Goal 更新为 `0.54.4-rotom.8`。复用 Pi 的有界 provider 重试，明确显示恢复中；恢复耗尽后暂停并保存原因，不再停留在没有唤醒事件的 active 等待。
- 修复错误后的阈值压缩清除恢复状态、留下假运行 Goal 的路径。
- 非 waiting 的活跃 Goal 在恢复会话后明确暂停；支持空闲 active Goal 的显式 resume，但拒绝抢占运行、恢复或已排队工作。
- 继续保留取消、预算、完成审阅及成功/unknown 操作不重放的边界。managed-run 状态事件新增可选 activity/recovery/wait/stopReason 字段，不改变原有终止状态语义；独立 dashboard 仍需采用这些字段。

## 验证与发行边界

功能阶段已通过 87 项 Goal 测试、46 项运行时/归档测试、类型检查及默认/完整工具面离线 SDK smoke；这些不是最终发行包的安装证据，也不证明真实网络长期可靠性或 Scry 展示。

仅从公开独立干净 clone 冻结后的提交构建一个最终 tgz。计划对实际 tgz 完成摘要/文件清单、隐私扫描、隔离 HOME/prefix 且 PATH 无全局 Pi 的安装、版本、default/full smoke、check-personal、0.1.16→0.1.17 升级及卸载检查。沿用上次确认兼容的隔离 npm 11.13.0，不修改维护者全局 npm 或存活会话安装。

认证与最终发布命令交由用户自己的前台终端执行。仅在 registry version、latest、integrity、shasum、可信 tarball URL 和下载字节全部匹配后记录发布完成；审核或 unknown 时不重复 publish。此授权不包含本机全局安装切换或存活会话热替换。
