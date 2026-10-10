# npm 0.1.18 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.18`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：准备并冻结发布元数据；尚未证明 npm 发布成功。
- 基于公开 `main`，独立干净 clone 构建；最终 source commit 由 Git 读取并记录在验证报告中，不手填或重建旧包。

## 相对 0.1.17 的变化

- 内置 Subagent 更新至 `0.52.1-rotom.5`：精简模型可见合同，明确 scoped 模式仅支持的执行路径，移除旧 mission Goal driver 和定时调度器。不影响独立 `/goal`。
- 状态展示使用真实恢复 preflight；终态投影失败保存 unknown 与已有资源关闭证据，不授权自动恢复、替换 writer 或重放业务操作。
- 同步组件归档、integrity、lock、文档与回归测试，避免已修源码未进入选定归档。
- Pi fork 保持 `1.0.4-rotom.2`，Goal 保持 `0.54.4-rotom.8`。不迁移活跃会话或改变本机安装。

## 验证与限制

最终 tgz 必须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、当前 `check-personal`、从 0.1.17 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果与摘要在验证后记录，不将此前源码测试冒充本次安装包验证。

组件历史 `test:compat` 因缺失/归档测试路径无法运行；不删除或跳过断言来声称通过。现行组件单测、真实进程/SDK、typecheck 和当前产品回归是独立证据，不替代旧矩阵。真实付费模型、网络长跑、完整终端交互、Chrome/设备与跨平台尚未验收。

npm 登录和最终 publish 由维护者在前台终端执行一次。仅精确 version、tag、摘要及下载字节全部一致才记为 verified；submitted/reviewing/unknown 不重复 publish，也不自动升级本机。
