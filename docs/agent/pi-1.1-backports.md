# Pi 1.1 定向修复移植

> 历史记录：已被 `1.1.0-rotom.x` 的完整 v1.1.0 合并取代，见 [Pi 1.1.0 对齐](pi-1.1-migration.md)。

交付 fork：`1.0.4-rotom.2`。基于当前公开的 Pi 1.0.4 fork，保留已经移除分类器与虚拟自动路由的边界；不是完整升级到上游 1.1.0。上游 commit 与模型目录发行包 SRI 记录在 `packages/rotom-pi/FORK.json`。

## 范围与兼容性

- Codemode 明确异步 lookup helper 必须 `await`；多段 text/return 输出编号，console 汇总到独立块，图片仍按既有保存与截断合同处理。脚本输出的文本布局有意变化。
- 公共与 extension 的 `agent_settled` 事件新增必填 `aborted`，包含最后一条响应成功之后的取消；手工构造 typed event 的集成需补此字段。
- `tool_execution_end`、嵌套工具终态与持久化 `ToolResultMessage` 携带可选 `durationMs`。只用单调时钟测量 `execute()`，不包含 hooks；抛错仍记录，未执行和旧消息不伪造耗时。`ToolRenderContext.durationMs` 可为 undefined，Bash/PowerShell 优先显示记录值，恢复会话后仍有效；HTML 导出尚不显示记录耗时。
- 请求上下文估算改为 3.5 字符/token。这是保守估算，不是 tokenizer 或准确 token 计数。
- 目录生成器保留 OpenRouter、Vercel 与 models.dev 的长 prompt 分层价格和缺省档位价格；固定离线目录从经 SRI 校验的 Pi AI 1.1.0 中更新 154 个现有条目的 cost，仅匹配基础价格相同的条目。不增加模型、不改变能力；Haiku latest 基础价格已变化，未借此升级别名。
- Bedrock OpenAI GPT 的嵌套 reasoning effort 与 gpt-oss 的扁平 effort 正确映射；server-busy 文案和 Mistral `finish_reason=error` 进入已有有界重试策略。不添加新的 retry loop。
- 不引入 OSC 7501、新模型、MCP 功能、assistant/durable 计时。保留原 provider/会话边界。

Codemode 描述的实测增量为 164 UTF-8 bytes，三个启动工具面精确合同随之更新；工具数量、guidelines 和历史 reference 不变，不把字节差当作 provider token/成本。

## 验证（macOS arm64 / Node 24.18.0）

在最新公开基线的独立 clone 上验证最终 `.2` 源码和归档，没有复制维护安装或发送真实模型请求：

| 检查 | 结果 |
|---|---|
| 隔离锁定安装、全 workspace offline build、builder focused 回归 | 683 passed，3 个既有条件测试 skipped |
| fork 全量 TypeScript noEmit；本次 TypeScript diff 的 Biome | PASS |
| `check:pi`、builder 回归、distribution | PASS；2 + 25 tests |
| 新归档的独立 npm ci、CLI version | PASS，`1.0.4-rotom.2` |
| runtime verifier | 39 passed |
| `check-personal` | 312 tests、9 项离线 Provider 矩阵、70 项 Goal tests；最终 footprint PASS |
| default / full / scoped-full SDK smoke 与 footprint | PASS；无真实模型调用 |
| 当前归档真实 CLI PTY 恢复合成会话 | 120×40，显示 `Took 4.2s`；测试进程已退出 |
| public auditor 回归、tree + history | 13 passed；完整扫描 0 findings，仍为有界启发式 |

开发中修正了浮点费用断言和并行工具终态顺序断言；新纳入的旧 abort fixture 去掉 Pi 1.0 已废弃的 `systemPrompt`，并断言原生工具声明 system 消息。维护目录既有第三方安装与源码 identity 不一致，未覆盖该安装，产品验证改用干净 clone 的锁定安装。Codemode 的预期描述增量曾触发 footprint 精确门禁，核对增量后更新当前合同，未修改历史 reference 或放宽比较。

尚未验证真实 Provider 计费/重试、跨平台或桌面 GUI；PTY 不等于桌面视觉验收。本次只交付源码与内置 runtime 归档，不发布 npm，不切换用户全局安装或迁移存活会话。
