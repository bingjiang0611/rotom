# npm 0.1.25 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.25`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节均已独立核验。维护者用 `scripts/install-release.sh` 安装后，全局命令已切换到分版本目录中的 0.1.25，保留 0.1.24 及更早版本和活跃会话；实际安装的 18,885 个文件与最终包逐字节一致，真实配置下 `/context` 只注册一次。
- 唯一构建源：`997251965f664f9e8c0faf4d1deb5670890374c9`。冻结提交 `2648250` 漏改了 `distribution.md` 的指向（脚本中一处文本替换失败，后续命令仍执行）；`9972519` 只补这一行文档。只成功打包一次：48,664,829 字节、18,885 个文件。完整摘要和验证结果见 [机器可读证据](npm-0.1.25-verification.json)。

## 相对 0.1.24 的变更

- 内置 Pi 升级到 `1.3.0-rotom.2`。详见 [Pi 1.3.0 对齐](pi-1.3-migration.md#130-rotom2)。
  - 中止后的轮次在本地以 0 用量的 `aborted` 助手消息收尾，不再用已中止的 signal 请求 provider。中止后排队的 steering 消息会保留在对话里；工具执行到一半切换会话时，被切走的会话以 aborted 回复结尾。修复了两个长期存在的 coding-agent 测试失败。
  - 扩展 API 新增 `pi.appendUsage`：扩展自己发起的模型请求可以写入 Pi 原生用量记录。
- SoL-Pi 升级到 `0.1.0-rotom.1`：Evidence-Preserving Reducer 每拿到一次模型回复，就写一条 `sol_pi_reducer` 用量记录。footer、会话统计、按模型的用量拆分和 Goal 预算现在都包含 Reducer 的 token。
- 默认、full、scoped 三档的工具面和规范化 schema 字节不变。

## 验证范围和限制

- `build:pi`、`check:pi`、coding-agent 全量（2781 通过、0 失败）、分发 25 项通过；以实际安装 tgz 的 Pi 运行 `check-personal`：产品 329 项、Goal 87 项通过，default footprint 合同 PASS；full/scoped 在源码树 PASS，与 0.1.24 相同。
- 唯一 tgz 的独立隐私审计（21,800 个文件、0 发现）、隔离安装（18,885 个文件逐字节一致）、default/full smoke、RPC `/context`、0.1.24→0.1.25 升级与卸载通过。
- 发布后补充验证（2026-10-16）：用已安装的 0.1.25、你的真实配置和 `openai-codex` 登录，主模型为 faux，输入 17,162 字节的合成 pytest 失败日志。
  - 1 次真实 `gpt-5.6-luna` 请求：输入 4,698、输出 251，共 4,949 token；按模型目录价格折合 $0.0012（实际消耗订阅额度）。回执被采用，压到 1,740 字节，保留两处失败堆栈、测试汇总和退出码，并附原文路径。
  - 会话里写入 1 条 `sol_pi_reducer` 用量记录。在真实 PTY TUI 中恢复该会话（不发 prompt），footer 显示 `↑17k ↓265 $0.001`，即主模型 11,949/14 加 Reducer 4,698/251；不含 Reducer 时应为 `↑12k ↓14`。
  - `auth.json`、`sol-pi.json`、`settings.json` 未被修改。未验证：真实项目输出上的效果和长会话累计成本。
- 本次发行 gate 不调用真实模型、浏览器或手机。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
