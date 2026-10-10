# npm 0.1.18 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.18`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：重新冻结发布元数据；尚未证明 npm 发布成功。
- 基于公开 `main`，独立干净 clone 构建；最终 source commit 由 Git 读取并记录在验证报告中，不手填或重建旧包。

## 首次冻结的发布尝试（已作废）

首次冻结于 `754e6dc`，产物仍是 Pi `1.0.4-rotom.2`。维护者在前台终端执行一次 `npm publish`，package PUT 返回 E404。随后只读核验：registry 中精确版本 0.1.18 返回 HTTP 404；npm 官方 Versions 页滚动到底共 27 个版本，latest 为 0.1.17，没有 0.1.18，也没有 Validating 状态。数小时后再次查询 registry 仍为 404，`latest` 仍为 0.1.17。该 tgz 未被重新提交，现在作废，不得发布；0.1.18 改为在本次重新冻结的提交上重新构建唯一产物。E404 的根因未诊断，再次 publish 前须在同一前台终端确认 `npm whoami` 为包所有者。

## 相对 0.1.17 的变化

- Pi fork 升级到 `1.1.0-rotom.2`：三方合并上游 Pi `v1.1.0`，保留 rotom 品牌、Qoder、压缩/中止修复、模型选择器与 `pi`/`pi-rpc` 进程身份。详见 [Pi 1.1 迁移](pi-1.1-migration.md)。
- 恢复上游的分类器 API 与模型（OpenAI Decisions、llama.cpp System One、TypeSafe 等）、虚拟模型路由 `registerVirtualModel`，以及内置 MCP 扩展。rotom 默认不调用分类器、不注册虚拟模型；没有 `mcp.json` 时 MCP 不连接任何服务器，`--no-mcp` 可完全关闭。
- 修复启动器把 `rotom mcp …` 当作提示词处理的问题：`mcp` 子命令与 `install`/`list` 一样原样透传给 Pi。
- 内置 Subagent 更新至 `0.52.1-rotom.6`：runner 异常先收尾再关闭，并释放 paused 容量；`.5` 精简了模型可见合同，移除旧 mission Goal driver 和定时调度器。不影响独立 `/goal`。
- Goal 保持 `0.54.4-rotom.8`。公开历史审计总扫描上限经维护者批准调至 1216 MiB；单文件、归档与检测规则不变。不迁移活跃会话，不改变本机安装。

## 验证与限制

最终 tgz 必须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、当前 `check-personal`、从 0.1.17 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果与摘要在验证后记录，不将此前源码测试冒充本次安装包验证。

发布前已用真实模型验证（源码 launcher，非安装包）：虚拟模型按 thinking 档位路由到对应的 `openai-codex` 物理模型，工具后续请求保持在同一模型；模型可在 Codemode 内调用 stdio MCP 工具并返回正确结果。分类器的真实调用未验证：本机 ChatGPT OAuth 不能调用 Decisions API，也没有其他分类器提供方的 key。OAuth MCP、完整终端交互、Chrome/设备与跨平台尚未验收。组件历史 `test:compat` 因缺失/归档测试路径无法运行。

npm 登录和最终 publish 由维护者在前台终端执行一次。仅精确 version、tag、摘要及下载字节全部一致才记为 verified；submitted/reviewing/unknown 不重复 publish，也不自动升级本机。
