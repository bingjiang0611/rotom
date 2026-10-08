# 分类器与虚拟自动路由移除

## 当前合同

Pi fork 为 `1.0.4-rotom.1`，Goal 为 `0.54.4-rotom.7`。

- 删除所有分类模型类型、分类执行/认证适配、专用 API/provider、生成目录、扩展注册字段及 Codemode `models.classify()`；TypeSafe/Jev/Clef 不再进入目录，包括曾被误列为 chat 的 Jev Router。
- 删除虚拟模型注册、provider overlay、请求分流/重试选路、持久路由状态恢复、公开类型/方法和 Jev 示例；没有留下禁用开关或兼容空壳。
- 保留普通聊天、手动模型选择、通用请求准备 hook、工具负载规范化、压缩、Codemode 工具编排及图片生成。图片调用仍按目录解析模型并保护认证字段，单脚本最多四个并发调用，使用量仍计入工具结果。
- 保留历史会话、自定义条目和辅助 usage 计账。旧分类目录项按未知类型过滤；历史路由状态只作为不执行的自定义记录。旧的路由扩展须停用或迁移，不自动删除用户文件。
- Goal reviewer 使用当前选中的普通模型，不为复核做额外分类或选路。版本化预算迁移、取消及 unknown/no-replay 合同不变。
- MCP 仍不注册或自动连接；保留其依赖与源码。Subagent 的独立 WIP 不进入本次改动。

## 离线验证

- 隔离构建完整 Pi 工作区；AI 定向 81 tests 通过；coding-agent 26 个文件、289 tests 通过（合入公开基线的压缩证据修复后重建），2 个真实模型测试跳过。
- 产品 312 tests、Goal 70 tests、Goal typecheck、Pi source/archive identity 检查通过；受影响 Pi 文件的 focused Biome 检查通过。
- 整个 Pi 工作区的测试级 `tsc --noEmit` 仍有既有 TS2353：未修改的 `packages/agent/test/agent-loop.test.ts:426` 使用 `AgentContext.systemPrompt`。本次未扩大范围修复；完整源码构建和受影响测试通过，不宣称全工作区 typecheck 通过。
- Provider 九组离线 gate 通过；default/full SDK smoke 各两次 faux Provider 调用、零 lifecycle errors，包含实际 Codemode worker、显式工具限制及 model-only 排除。
- default/full footprint 合同通过；普通/完整工具面 normalized schema 分别为 22,479 / 37,342 UTF-8 bytes。相同 Codemode 描述变化也使 scoped 完整合同增加两 bytes；不冒充 Provider 精确 tokens 或成本。

这些结果不证明真实模型/图片服务、费用、Chrome/设备、完整终端或跨平台行为。既有迁移验证是历史记录，不替代本次结果。

## 发布状态

`0.1.14 / latest` 旧候选及发布命令已撤销，用户确认未执行 publish。本次没有 npm 发布或全局安装切换。恢复发布时须重新冻结公开源码、构建并验证唯一最终 tgz，再走用户前台交接。
