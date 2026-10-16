# npm 0.1.24 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.24`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：发布元数据已冻结；尚未打包、发布或核验 registry。

## 相对 0.1.23 的变更

- 内置 Pi 升级到 `1.3.0-rotom.1`（三方合并上游 `v1.3.0`，保留全部 rotom 补丁）。运行时从 8 个包减为 7 个；模型目录原样导入经 SRI 校验的官方 `@earendil-works/pi-ai@1.3.0`。详见 [Pi 1.3.0 对齐](pi-1.3-migration.md)。
- Qoder 不再把其他模型的 thinking 当正文重放，而是直接丢弃，与上游 #11000 一致。
- 新增内置扩展，安装后即可用：
  - `pi-context-view@0.7.1` 提供 `/context`。
  - SoL-Pi `0.1.0-rotom.0`：没有 `sol-pi.json` 时默认开启 Action Fusion、Observation Pack 和 Evidence-Preserving Reducer。Reducer 会额外请求 `openai-codex/gpt-5.6-luna`。
  - 以前自己安装过这两个包的用户须删除自己的副本，否则会重复加载。见[使用指南](../usage.md#内置上下文扩展context-与-sol-pi)。
- 默认工具面增加 `obs_recall`，`edit`/`write` 改用 SoL-Pi 版本：默认、full、scoped 三档都是 +1 个工具、+1,243 规范化 schema 字节。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
