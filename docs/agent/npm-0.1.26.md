# npm 0.1.26 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.26`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest 标签、integrity、shasum、可信 tarball URL 与下载字节均已独立核验。Agent 按用户本轮明确授权完成全局安装，仅切换新启动命令，保留旧目录与正在运行的会话。
- 唯一构建源：`16fd1842fe0379058035c1169c94927d4aa98707`。正式产物只构建一次：48669936 字节、18883 个文件；完整摘要和验证结果见 [机器可读证据](npm-0.1.26-verification.json)。正式 tgz 与此前已做真实模型验证的诊断包逐字节一致，但仍重新执行了正式发布门禁。
- `rotom/package.json` 已为 0.1.26，保留现有 public / UNLICENSED 合同，不为准备记录再次递增版本。

## 相对 0.1.25 的主要变更

- Qoder：移除默认固定输出 token 上限，显式调用方预算仍经 Pi 原生上下文余量裁剪；修复 Ultimate 的 COSY 串行工具批次复用索引 0 时的 `invalid_tool_id`，保留完整参数、唯一 ID 和明确工具名等校验。
- Qoder：上游显式 `refusal` 在解析 delta 前返回 `model_refusal`，不吞掉拒绝后继续执行工具；工具 ID 错误只记录有界结构诊断，不保存 ID、参数或正文。
- RPC：修复初始化期间 UI 回复的接收顺序，以及 stdin EOF 前已经入队的启动命令仍需得到响应的情况。
- Pi / Qoder：更新连接建立阶段失败的恢复交互与响应头计时；只有能证明请求尚未发送的连接失败才归为 `connection_failed`，已可能发送或计费的请求不归入该类。
- Subagent：改进父会话关闭时的 runner 回收、原生 close 观察者仍存活时的 pending 状态，以及 owned scope 中内置角色的启动；关闭证明缺失仍保持 unknown。
- SoL-Pi：增加 Reducer 拒收引用时的不含正文诊断，不把被拒回执当成成功压缩。

Pi 包标记仍为 `1.3.0-rotom.2`；归档字节和锁定 identity 以本次实际产物为准。内置 Subagent 为 `0.52.1-rotom.10`，SoL-Pi 为 `0.1.0-rotom.2`。

## 验证结果和边界

| 检查 | 结果 |
|---|---|
| Pi identity / 分发 | `check:pi` PASS；分发 25 项通过 |
| 实际安装 tgz 的 Pi + `check-personal` | 产品 330 项、Goal 87 项、离线 Provider 9 组通过；源码与已编译 Pi 一致 |
| 工具面 | 当前 runtimeContractGate / deterministicGate PASS；历史不可变参考仍标记 DRIFT，不是当前合同失败 |
| 实际 tgz | 独立隐私审计 21,796 文件、0 发现；安装后 18,883 个文件逐字节一致 |
| 隔离安装和运行时 | PATH 无全局 Pi；default/full smoke、RPC 的 EOF 前入队命令响应、`/context` 单次注册通过 |
| 升级与卸载 | 已核验 registry 0.1.25 包 → 唯一 0.1.26 tgz 升级通过；卸载后包/bin 消失，HOME 哨兵保留 |
| 用户明确授权的全局安装 | 正式包安装到新目录并原子切换命令；18,883 个文件一致，`rotom --version --verbose` 为 0.1.26 / Pi 1.3.0-rotom.2；旧目录、存活会话和已检查的配置保留 |

- 初次 `check-personal` 因干净 clone 缺少 Pi 源码测试的 Vitest 而失败（329/330）；按冻结锁文件安装开发依赖后，focused 控制与完整门禁重跑通过。没有修改源码、弱化测试或重新打包。
- 功能修复参考：同字节诊断包上的真实 Ultimate/high 双文件读取和随机标记续轮通过。另已确认上游会显式拒绝；客户端保留拒绝，不把后续工具帧当成许可，不能承诺模型请求必成功。
- 正式发行 gate 使用合成数据和离线 Provider，没有再调用真实模型、浏览器或手机，没有重放原业务会话或真实 TUI。真实 registry `rotom update` 升级路径未执行，隔离升级使用 npm。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 完成冻结、唯一 tgz、隔离验证及只读核验；维护者在自己的前台终端完成 npm 登录、官方网页确认及一次 publish。

最终产物通过门禁后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段精确命令。发布接收或自动审核不等于已公开；核验成功前不安装正式版本、不创建 release tag、不重复 publish。
