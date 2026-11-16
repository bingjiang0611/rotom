# rotom 0.2.3 发布与安装记录

`@bingjiang0611/rotom@0.2.3` 已发布到 npm `latest`。维护者在前台终端发布；Agent 独立核对精确 version、tag、integrity、shasum、tarball URL，并确认下载字节与冻结 tgz 完全一致。随后按维护者明确要求完成本机全局安装。

- 变化与冻结合同：[0.2.3 发布说明](../releases/0.2.3.md)。全部 Computer Use 操作默认免授权；显式 deny/tier、系统权限、并发仲裁、活动检查和用户停止仍有效。
- 精确构建源、摘要、检查结果与限制：[机器可读验证记录](npm-0.2.3-verification.json)。唯一最终 tgz 压缩 34,947,692 bytes，解包 150,150,878 bytes，共 19,435 个文件。
- Pi fork `1.5.2-rotom.1`；Computer Use `0.5.1-rotom.10`；helper/broker 协议 `11/2`。`.rotom.10` 相比锁定的 `.rotom.9` 仅改包版本、README 和 provenance；运行时代码与全部 8 个原生预构建文件逐字节相同。

## 验证

| 范围 | 结果 |
| --- | --- |
| 最终 tgz 完整维护门 | 指向实际安装的 Pi executable；主测试 598/598、Goal 99/99，零失败/跳过；离线 Provider 检查通过，退出码 0 |
| Computer Use 免授权行为 | 实际最终产物安装及正式安装位置分别通过 12 项检查：无审批事件、无策略持久化写入；没有真实桌面写入 |
| 实际 tgz | 隐私审计零发现；隔离安装全部 19,435 个文件与 tgz 逐字节一致 |
| 正式位置 smoke | default/full 分别 26/33 个 active tools；生命周期错误均为零 |
| 升级与卸载 | 核对 registry 0.2.2 tgz 后，在隔离 prefix 实际升级到最终 0.2.3 tgz；19,435 文件匹配，卸载移除 package/bin，用户哨兵文件保留 |
| 日常全局入口 | npm 完整安装的独立 prefix 迁移到正式版本目录；在正式位置再次逐字节比对 19,435 文件且无额外文件、执行免授权检查与双 smoke，再原子切换全局入口；回读 `rotom 0.2.3` / Pi `1.5.2-rotom.1` |

全局安装保留 `--ignore-scripts`。旧安装目录、共享 broker、原生 helper 和存活会话没有覆盖或重启。旧会话不会热加载新代码，新启动使用 0.2.3。标准 npm prefix 中较早的包目录没有删除，也不作为当前 PATH 入口版本的证据。

## 失败历史与边界

冻结前的发行检查发现 Computer Use README/声明仍写 `.rotom.7`；单独提交 `.rotom.10` 元数据修正并验证后才冻结产品版本，没有覆盖已锁定的 `.rotom.9` 归档。

干净 clone 最初缺锁定维护依赖，验证命令额外设置的 `ROTOM_OBSERVABILITY=0` 又与 trace 测试冲突。补齐依赖并恢复测试默认环境后，聚焦检查及最终完整维护门在原断言和原 deadline 下通过。一次 SDK cascade readiness 超时保留在失败记录中，不因后来 PASS 消失。

日常安装首次在用户目录解包时超时，只产生未完成的独立目录，未切换全局入口，且无安装进程遗留。将该半成品移到发布工作区保留诊断；随后同文件系统原子迁移此前已完成 npm 安装和完整验证的独立 prefix，再在正式位置重新核验。没有盲目重跑安装或用半成品宣称完成。

本次没有真实桌面 GUI 任务、真实 Provider、浏览器/手机或跨平台验收，没有强制日常原生 helper 同步或重新验收原生签名身份复用。发布及安装验证不能代替这些路径。

0.2.3 的注解 release tag 指向发布记录提交；构建源仍以验证 JSON 和 tgz 的 `build-info.json` 为准。旧版本产物、tag 和存活安装不重写。发布工作区与日志保留到维护者完成临时 npm 认证撤销交接后再清理。
