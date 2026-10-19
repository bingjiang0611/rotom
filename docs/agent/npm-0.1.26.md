# npm 0.1.26 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.26`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：准备发布，尚未执行 npm publish。只有 registry 的精确版本、标签、摘要、可信 tarball URL 与下载字节全部匹配后，才能记录发布成功。
- 产品变更基线：`19bebf12c2274d62b344b306a710f0985adeb81a`。正式构建源在本次发布说明冻结后由 Git 读取，记录在唯一产物的验证证据中；此前的独立诊断包不是本次正式产物。
- `rotom/package.json` 已为 0.1.26，保留现有 public / UNLICENSED 合同，不为准备记录再次递增版本。

## 相对 0.1.25 的主要变更

- Qoder：移除默认固定输出 token 上限，显式调用方预算仍经 Pi 原生上下文余量裁剪；修复 Ultimate 的 COSY 串行工具批次复用索引 0 时的 `invalid_tool_id`，保留完整参数、唯一 ID 和明确工具名等校验。
- Qoder：上游显式 `refusal` 在解析 delta 前返回 `model_refusal`，不吞掉拒绝后继续执行工具；工具 ID 错误只记录有界结构诊断，不保存 ID、参数或正文。
- RPC：修复初始化期间 UI 回复的接收顺序，以及 stdin EOF 前已经入队的启动命令仍需得到响应的情况。
- Pi / Qoder：更新连接建立阶段失败的恢复交互与响应头计时；只有能证明请求尚未发送的连接失败才归为 `connection_failed`，已可能发送或计费的请求不归入该类。
- Subagent：改进父会话关闭时的 runner 回收、原生 close 观察者仍存活时的 pending 状态，以及 owned scope 中内置角色的启动；关闭证明缺失仍保持 unknown。
- SoL-Pi：增加 Reducer 拒收引用时的不含正文诊断，不把被拒回执当成成功压缩。

Pi 包标记仍为 `1.3.0-rotom.2`；归档字节和锁定 identity 以本次实际产物为准。内置 Subagent 为 `0.52.1-rotom.10`，SoL-Pi 为 `0.1.0-rotom.2`。

## 验证计划与边界

- 本次正式 gate 待执行：`check:pi`、分发测试、`check-personal`、实际 tgz 隐私审计、隔离 HOME/prefix 安装、default/full runtime smoke、文件逐字节核对、0.1.25 → 0.1.26 升级和卸载。
- 功能修复参考（不是正式产物 gate）：上述产品基线的 Qoder / trace 回归 295 项通过；独立安装上的真实 Ultimate/high 双文件读取及随机标记续轮通过。另已确认上游会显式拒绝，不能承诺请求必成功。
- 正式发行 gate 使用合成数据和离线 Provider，不再调用真实模型、浏览器或手机，不重放原业务会话或真实 TUI。
- 不覆盖当前默认安装，不迁移活跃会话。正式发布后的本机切换仍由维护者另行执行。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 完成冻结、唯一 tgz、隔离验证及只读核验；维护者在自己的前台终端完成 npm 登录、官方网页确认及一次 publish。

最终产物通过门禁后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段精确命令。发布接收或自动审核不等于已公开；核验成功前不安装正式版本、不创建 release tag、不重复 publish。
