# rotom 0.2.1 发布与安装记录

`@bingjiang0611/rotom@0.2.1` 已发布到 npm `latest`。维护者在前台终端发布，Agent 独立核对 registry 的 version、tag、integrity、shasum、tarball URL 与下载字节。随后按维护者明确授权全局安装同一 tgz；19,049 个安装文件与产物逐一匹配。

- 变化与冻结合同：[0.2.1 发布说明](../releases/0.2.1.md)。主要变化是 helper 随产品自动同步。
- 精确构建源、摘要、检查结果与限制：[机器可读验证记录](npm-0.2.1-verification.json)。只成功构建一个最终 tgz，压缩 34,089,702 bytes，解包 147,168,261 bytes。
- Pi fork `1.4.0-rotom.4`；Computer Use `0.5.1-rotom.5`；helper/broker 协议 `11/2`。未改原生预构建字节。

## 验证

| 范围 | 结果 |
| --- | --- |
| 完整维护门 | 主测试 598/598、Goal 99/99、离线 Provider 与 runtime/deterministic gate 通过；指向实际安装的 Pi executable |
| Computer Use | 完整类型检查与 332/332 测试通过；确认运行退出码 0 |
| 实际 tgz | 隐私审计零发现；安装前后 19,049 个文件逐一匹配 |
| 实际安装 smoke | default/full 分别 26/33 个 active tools；生命周期错误为零 |
| 实际安装启动/RPC | 自动同步、重复 no-op、version/help 不同步、stdout 保持 JSON；未跳过 |
| 原生自动升级 | 0.2.0 tgz 的旧 helper fixture 经现有身份签名后启动；实际安装的 0.2.1 updater 自动复用签名身份、停止、替换，再启动新 PID；strict/deep 验签及源摘要通过；再次同步不重启 |
| 升级与卸载 | 隔离 prefix 从 0.2.0 升级到固定 0.2.1 tgz，版本回读与卸载通过 |
| 日常全局安装 | `rotom 0.2.1` / Pi `1.4.0-rotom.4`；全部文件匹配；安装期间未修改 helper 二进制 |

原生验收使用正常 HOME 的现有 keychain 和独立 App 路径，没有创建证书、导出私钥或降级签名。旧/新 fixture PID 与可执行路径均核验；日常 helper 文件与 PID 在该测试期间未变。fixture 退出后留下的 socket 文件，经进程与 listener 均不存在的检查后删除；未重放 shutdown。

## 失败历史与边界

首次 smoke 调用误指向不随包分发的维护测试驱动，改用冻结源码中的驱动验证真实安装资源后通过。首次组件测试的外层 240 秒等待先超时，随后日志完成 332/332；确认运行完整捕获退出码 0，没有修改测试或产品超时。此前源码阶段的日常 helper 副本未形成 socket，原因仍未确定；本次从旧 tgz 准备并重新签名 fixture 的成功不反推旧失败根因。原始失败日志保留在本机，不公开凭据、签名身份或本机路径。

这不是 GUI 任务、真实 Provider、浏览器/手机或跨平台验收。L2 仍为 0 成功 / 5 失败，pid 输入仍无真机正例，B1–B6 未通过。实际 npm 升级/启动与 updater API 已分别验证，未把它们冒充 `rotom update` 命令的完整外部链路。

全局安装保留 `--ignore-scripts`，未主动关闭存活会话，也不会令旧会话热加载新代码。**日常 helper 在下一次正常启动 rotom 时自动同步**；版本查询不触发同步。首次从 0.2.0 升级时，旧 updater 不具备新逻辑，因此同样由新版本的正常启动补齐，不需要额外 helper 命令。

0.2.0 的已发布产物/tag、较早安装目录和入口备份不被本版本重写。0.2.1 的 release tag 指向发布记录提交；构建源仍以验证 JSON 和 tgz 的 `build-info.json` 为准。
