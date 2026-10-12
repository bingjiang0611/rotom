# npm 0.1.21 发布准备

- 授权目标：`@bingjiang0611/rotom@0.1.21`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：已发布并独立核验 `0.1.21 / latest`。registry 的 version、dist-tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配唯一最终 tgz；构建源及验证见 [发行证据](npm-0.1.21-verification.json)。
- 基于公开 `main`，在独立干净 clone 中构建；最终 source commit 由 Git 读取并记录在验证报告中。

## 相对 0.1.20 的变化

- Coding policy：编码工具启用时追加 `Final report` 段。改动、调查或验证类任务的最终回复先给结论和验证程度，再按需分段写改动、验证（命令、计数、反向对照、无关失败）、未验证 / 已知限制、最终状态和待决定事项；简单问题仍直接回答。提示词每轮约增加 2KB。
- Browser relay：`open` 失败且 Chrome 确认新标签已不存在时，说明标签在创建后立即被关闭，并指出可能是其他扩展（例如去重标签扩展）所为；其他失败保留原错误。扩展侧代码变化需要重新运行 `install-chrome-relay install` 并在 `chrome://extensions` 重载。
- 文档：删除过时的实验与历史记录，当前合同文档对齐。
- Pi fork、第三方 package 版本与 0.1.20 相同。
- Eval（不进入发行包）：新增 `final-report.eval.ts` 配对 A/B；harness 支持由扩展注册的 provider（如 qoder）。

## 验证与限制

最终 tgz 须通过独立 HOME/prefix 安装、版本回读、default/full SDK smoke、`check-personal`、从 0.1.20 升级与卸载，以及实际包和 tree/history 隐私审计。执行结果在验证后记录。

`Final report` 段的模型行为证据来自小样本配对评测（每臂 1–2 次，见 `rotom/evals/README.md`），不代表长会话或所有模型。

## 发布结果

最终 tgz 已通过上述全部安装包门禁：321 个产品测试、87 个 Goal 测试、default/full smoke、0.1.20→0.1.21 升级与卸载、实际包与 tree/history 审计。`pack:release` 只成功执行一次。npm 登录和 publish 由维护者在前台终端执行，Agent 未读取凭据。未验证项见验证 JSON。
