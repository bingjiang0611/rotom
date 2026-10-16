# npm 0.1.24 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.24`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节均已独立核验。维护者确认后，Agent 先备份 `~/.pi/agent/settings.json` 并删除其中用户自装的 `sol-pi-updated` 与 `npm:pi-context-view@0.7.1`（避免重复加载），再全局安装；全局命令已切换到分版本目录中的 0.1.24，保留 0.1.23 及更早版本和活跃会话。实际安装的 18,885 个文件与最终包一致。
- 唯一构建源：`23d0fc67d3b1b9fa7d1339a04cd3c52bf1e2f71e`。只成功打包一次；48,661,826 字节、18,885 个文件。完整摘要和验证结果见 [机器可读证据](npm-0.1.24-verification.json)。

## 相对 0.1.23 的变更

- 内置 Pi 升级到 `1.3.0-rotom.1`（三方合并上游 `v1.3.0`，保留全部 rotom 补丁）。运行时从 8 个包减为 7 个；模型目录原样导入经 SRI 校验的官方 `@earendil-works/pi-ai@1.3.0`。详见 [Pi 1.3.0 对齐](pi-1.3-migration.md)。
- Qoder 不再把其他模型的 thinking 当正文重放，而是直接丢弃，与上游 #11000 一致。
- 新增内置扩展，安装后即可用：
  - `pi-context-view@0.7.1` 提供 `/context`。
  - SoL-Pi `0.1.0-rotom.0`：没有 `sol-pi.json` 时默认开启 Action Fusion、Observation Pack 和 Evidence-Preserving Reducer。Reducer 会额外请求 `openai-codex/gpt-5.6-luna`。
  - 以前自己安装过这两个包的用户须删除自己的副本，否则会重复加载。见[使用指南](../usage.md#内置上下文扩展context-与-sol-pi)。
- 默认工具面增加 `obs_recall`，`edit`/`write` 改用 SoL-Pi 版本：默认、full、scoped 三档都是 +1 个工具、+1,243 规范化 schema 字节。

## 验证范围和限制

- `check:pi`、分发 25 项、离线 Provider 通过；以实际安装 tgz 的 Pi 运行 `check-personal`：产品 329 项、Goal 87 项通过，footprint default/full/scoped 合同 PASS。唯一 tgz 的独立隐私审计（21,800 个文件、0 发现）、隔离安装、default/full smoke（`obs_recall` 激活）、真实 RPC `/context`、0.1.23→0.1.24 升级与卸载通过。
- 隔离验证脚本第一次把 npm user/global config 都设为 `/dev/null`，npm 拒绝重复加载同一文件而未安装；改用两个空文件后通过。产品与产物未改动，未重新打包。
- 发布后补充验证（2026-10-16）：
  - SoL-Pi 上游测试换成 0.1.24 实际安装的 Pi `1.3.0-rotom.1` 包后：166 项通过、`tsc` 0 错误。导入副本里 `tests/install-guide.test.ts` 的 2 项会失败，因为它读取未导入的上游 `AGENTS.md`/`CLAUDE.md`；补上这两个文件后全过，与 Pi 无关。
  - Reducer 用已安装的 0.1.24 资源、faux 主模型和约 10 KB 的合成失败 `make` 输出实测。未登录 `openai-codex` 时：`model-response-error`，模型收到完整原始输出（10,702 字节），保留错误状态，0 token。真实登录时：1 次 `gpt-5.6-luna` 请求、3,543 token，回执 1,576 字节，保留首尾错误、`Error 1` 与退出码，并附原文路径供按范围回读。
  - 已知限制：Reducer 用量只记在 SoL-Pi 自己的 journal，没有写入 Pi 的 `usage` entry，所以 footer 和会话统计不包含这部分 token。
- 本次发行 gate 不调用真实模型、浏览器或手机。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
