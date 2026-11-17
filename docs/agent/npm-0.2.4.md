# rotom 0.2.4 发布与安装记录

`@bingjiang0611/rotom@0.2.4` 已发布到 npm `latest`。维护者在前台终端发布；Agent 独立核对精确 version、tag、integrity、shasum、tarball URL，并确认下载字节与冻结 tgz 完全一致，随后按维护者明确要求完成本机全局安装。

- 变化与冻结合同：[0.2.4 发布说明](../releases/0.2.4.md)。Computer Use helper 自动同步失败不再阻断 `rotom` 启动；替换策略、签名降级禁止、helper/broker 协议 `11/2` 与 8 个原生预构建文件均未变。
- 精确构建源、摘要、检查结果与限制：[机器可读验证记录](npm-0.2.4-verification.json)。唯一最终 tgz 压缩 34,948,177 bytes，解包 150,151,886 bytes，共 19,435 个文件。
- Pi fork `1.5.2-rotom.1`；Computer Use `0.5.1-rotom.10`。

## 验证

| 范围 | 结果 |
| --- | --- |
| 最终 tgz 维护门 | `check-personal` 指向产物内 Pi executable：主测试 598/598、Goal 99/99，零失败/跳过，exit 0 |
| 实际 tgz | 隐私审计 19,436 条目零发现；隔离 HOME/prefix（PATH 无全局 Pi）安装 19,435 文件 |
| 隔离安装启动 | `rotom 0.2.4` / Pi `1.5.2-rotom.1`；RPC `get_state` exit 0，stdout 只有 JSON，stderr 为空 |
| smoke | 隔离安装与正式位置：default 26 / full 33 个 active tools，lifecycleErrors 均为 0 |
| 升级与卸载 | registry 0.2.3 → 本次 0.2.4：19,435 文件与全新安装逐字节一致；卸载移除 package 与 bin，用户哨兵文件保留 |
| 正式位置 | npm 全局 prefix 由 0.2.1 切到 0.2.4，19,435 文件与隔离安装逐字节一致；`build-info.json` commit `95777adb`、`dirty=false` |
| 正式位置 helper 同步 | 本机 Apple Development 身份可用：自动重签且写入 `source.sha256`，启动 exit 0、无 helper 告警 |

## 失败历史与边界

干净 clone 起初缺维护依赖，`check-personal` 出现两处失败：`packages/rotom-pi` 缺 vitest、`packages/rotom-subagents` 缺 jiti。补齐锁定依赖后同一门禁在原断言下 598/598 通过；这两处是环境缺依赖，不是代码失败。`extensions/third-party` 的 `npm ci` 需要 `--legacy-peer-deps --omit=optional`，与 `pack:release` 内部的 flags 一致。

本次没有真实桌面 GUI 任务、真实 Provider、浏览器/手机或跨平台验收。0.2.4 的“签名身份失效”启动路径没有在真机上复现，只有隔离 HOME 回归（外来 update-lock）与它的单点负向对照覆盖；真机上走通的是“身份可用、正常重签”那条路径。

全局安装保留 `--ignore-scripts`。`~/.local/share/rotom/installs/0.2.3` 与存活会话未被覆盖：安装前确认没有进程从 npm 全局前缀运行；旧会话不热加载新代码，新启动使用 0.2.4。

## 后续

测试机 `30.7.226.226` 上的 0.2.3 没有这个修复，需要各自升级才会拿到“同步失败不阻断启动”。发布工作区在临时 npm 认证撤销交接完成后清理。
