# npm 0.1.27 发布记录

- 用户明确授权：`@bingjiang0611/rotom@0.1.27`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest、integrity、shasum、可信 tarball URL 与下载字节均已核验。随后用户明确授权 Agent 安装，已切换新启动命令，保留旧目录与存活会话。
- 唯一构建源：`3f9b74d34b15b9819511c98979c7926aee8a6bf9`。最终产物只成功构建一次：33,015,460 字节、18,910 文件；摘要与验证结果见 [机器可读证据](npm-0.1.27-verification.json)。后续用户授权的维护测试修复 `73a15cf58a479fd733f27098b54d8245bef495f2` 不进入包，逐项确认产品源文件及 tgz 未变，没有重打。
- 已执行 `npm run check:pi`，归档与源码/构建器摘要匹配，无须重建 Pi 或修改版本锁。
- 实际 tgz 审计、隔离安装、default/full smoke、check-personal、升级及卸载通过后，才交接用户前台认证与一次 publish。

## 相对 0.1.26 的主要变化

- Pi fork 对齐至 `1.4.0-rotom.2`，保留 Codemode、分类/虚拟模型 API 与原生 MCP；修复压缩后的 deferred-tool 状态和持续执行指令处理，见 [Pi 1.4 迁移](pi-1.4-migration.md)。
- Compaction Offload 在没有 SoL-Pi 配置文件时默认开启：先卸载旧的中等文本工具结果，空间够时推迟摘要，否则走原生摘要；`ROTOM_COMPACTION_OFFLOAD=0` 可关闭。已有用户配置完全替代 rotom 默认，不自动迁移省略的字段；依赖 Observation Pack。回放证据和局限见 [压缩卸载](compaction-offload.md)。
- 默认内置 Context Layers 的分层摘要与只读召回工具；可用 `ROTOM_CONTEXT_LAYERS=0` 关闭。它不同于已移除的 Context Fold，不保证节省费用。
- Goal、Subagent、Ask、Computer Use 的生命周期、恢复和兼容性改进；macOS 后台文本能力仍有目标应用、文本范围和 helper 版本限制，不代表通用 GUI 隔离。
- 加强任务跟进、错误恢复观测和可执行质量检查。测试通过不等于任意真实模型、设备或浏览器路径均已验证。

内置版本由产品合同锁定：Subagent `0.52.1-rotom.11`、Goal `0.54.4-rotom.9`、Computer Use `0.5.1-rotom.2`、SoL-Pi `0.1.0-rotom.5`。本次只递增产品版本，不重新制作这些组件归档。

## 审计与发布边界

初始 tree+history 扫描只有一条身份 finding：`commit:f6497ad22ebb` / `non-noreply-committer` / digest `3c205d8fc749`。已独立核实该提交者恰为 GitHub 官方 `GitHub <noreply@github.com>`，不是个人邮箱。用户明确接受**仅此提交的此条误报**；不修改扫描规则、不重写历史、不扩展为通用豁免。历史扫描仍如实标为 BLOCKED with one accepted false positive，不写成零 finding。

本轮没有调用真实模型或重放付费回放。认证、网页确认与发布由用户在自己的前台终端完成；Agent 未接触密码、OTP 或 token。安装是在发布核验成功后、用户另行明确要求下执行，不覆盖正在使用的旧目录。

## 验证与安装

| 检查 | 结果 |
| --- | --- |
| check-personal | 392 项产品测试、88 项 Goal 测试及 9 组离线 Provider 检查通过 |
| 实际 tgz | 隐私扫描 18,911 项、0 finding；18,910 个安装文件逐字节一致 |
| 隔离 HOME/prefix | PATH 无全局 Pi/rotom；default/full smoke 均无 lifecycle error |
| 工具面 | 当前 runtimeContractGate / deterministicGate PASS；不可变历史参考仍为 DRIFT |
| 升级与卸载 | 摘要核验过的 registry 0.1.26 → 唯一 0.1.27 tgz 通过；卸载后包/bin 消失，HOME 哨兵保留 |
| 发布核验 | 精确 version/tag、摘要、可信下载地址与远端 tarball 字节全部一致 |
| 本机命令切换 | 新目录安装，原子切换全局入口；版本为 rotom 0.1.27 / Pi 1.4.0-rotom.2，18,910 文件一致 |

初次验证脚本用了非 canonical 的 `/tmp` 路径，之后改用 realpath；smoke driver 缺少维护依赖时，按冻结锁安装后继续。初次 check-personal 的 390 项通过、2 项失败来自隔离 HOME 的 Computer Use 权限提示。经用户批准，仅修维护测试，在自己的 PTY 中取消已观察到的提示，未授予系统权限、未删除断言。stderr 泄漏负对照仍失败，恢复后完整门禁通过；产品内容未变。

新版本外部启动 wrapper 保留既有 helper app/socket、headless 和 cursor-overlay 设置，未覆盖或重启已授权 helper。用户 settings/SoL-Pi 配置摘要保持不变；旧版本目录保留，活跃会话不迁移、不热更新。

未做新的真实模型、浏览器/手机或跨平台验收；真实 registry `rotom update` 路径未执行，升级检查使用隔离 npm prefix。
