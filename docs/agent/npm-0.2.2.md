# rotom 0.2.2 发布与安装记录

`@bingjiang0611/rotom@0.2.2` 已发布到 npm `latest`。维护者在前台终端发布；Agent 独立核对 registry 的 version、tag、integrity、shasum、tarball URL，并确认下载字节与冻结 tgz 完全一致。随后按维护者明确要求完成本机全局安装。

- 变化与冻结合同：[0.2.2 发布说明](../releases/0.2.2.md)。包含 Pi 1.5.2 对齐和 Computer Use broker 冷启动目录修复。
- 精确构建源、摘要、检查结果与限制：[机器可读验证记录](npm-0.2.2-verification.json)。最终 tgz 压缩 34,948,384 bytes，解包 150,155,144 bytes，共 19,436 个文件。
- Pi fork `1.5.2-rotom.1`；Computer Use `0.5.1-rotom.7`；helper/broker 协议 `11/2`。

## 验证

| 范围 | 结果 |
| --- | --- |
| 最终 tgz 完整维护门 | 指向实际安装的 Pi executable；主测试 598/598、Goal 99/99，零失败/跳过；离线 Provider 检查通过，退出码 0 |
| Computer Use | 严格类型检查、334/334 测试通过，退出码 0 |
| 实际 tgz | 隐私审计零发现；维护门结束后全部 19,436 个安装文件仍与 tgz 逐一匹配，无额外文件 |
| 实际安装 smoke | default/full 分别 26/33 个 active tools；生命周期错误均为零 |
| 实际安装启动/RPC | 冻结源码的 automatic-helper-startup 测试驱动指向实际安装；自动同步、重复 no-op、version/help 不触发同步，通过且未跳过 |
| 升级与卸载 | 核对 registry 0.2.1 tgz 后，在隔离 prefix 实际升级到最终 0.2.2 tgz；版本回读与卸载通过 |
| 日常全局入口 | 独立版本 prefix 安装同一 tgz，19,436 个文件逐一匹配后原子切换全局 `rotom` 入口；版本回读为 `rotom 0.2.2` / Pi `1.5.2-rotom.1` |

全局安装保留 `--ignore-scripts`。沿用本机独立版本目录的安装方式，旧安装目录未覆盖，没有显式停止存活会话或触发日常 helper 同步；旧会话不会热加载新代码，新启动使用 0.2.2。标准 npm prefix 中较早的包目录没有删除，也不作为当前 PATH 入口版本的证据。

## 失败历史与边界

最早候选包已撤回，没有发布。完整维护门暴露 SDK 测试只调用 `session.dispose()`、未发送 `session_shutdown` 的清理遗漏；修正清理后重新冻结源码、构建并验证最终 tgz，保留所有原断言。干净 clone 初次缺测试依赖，另有 macOS `/tmp` 符号链接影响策略测试；补齐锁定依赖并使用 canonical `TMPDIR` 后完整重验。一次 cascade fixture 启动等待超时；聚焦检查及最终完整维护门在原超时限制下通过，没有放宽超时。早期失败不因后续 PASS 消失，原始日志留在发布工作区直到交接清理。

本次启动测试是隔离 fixture，不是日常原生 helper 的真实升级验收，也不是 GUI 任务、真实 Provider、浏览器/手机或跨平台验收。未重跑 0.2.1 的原生签名身份复用验收，不沿用其结果冒充本版本的新证据。

0.2.2 的注解 release tag 指向发布记录提交；构建源仍以验证 JSON 和 tgz 的 `build-info.json` 为准。旧版本产物、tag 和存活安装不重写。
