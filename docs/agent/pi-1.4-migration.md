# Pi 1.4.0 对齐

## 范围与来源

- fork：`1.4.0-rotom.1`；产品版本保持 `0.1.26`，不是 npm 发布或本机安装切换。
- 公开基线：`3fc425018f8e2fcdff04d393a9d72eb0906f31b5`。在独立公开 clone 实施，不带入本地分叉维护历史。
- 三方合并 base：上游 `v1.3.0` / `71023aec1546d6d677a65669c5665c0927ce0dd0`。
- 目标：上游 `v1.4.0` / `4a080252f06caf63a525d7873c5d94d3c23887e0`。
- 上游变化文件 343 个：322 个无 fork 重叠、15 个自动合并、4 个文件需人工解冲突、2 个维护文件继续省略。此计数是文件字节比较，不是逐行安全审计。
- 模型目录来自官方 `@earendil-works/pi-ai@1.4.0` 的 43 个数据文件，下载后核对 registry SHA-512 SRI 与 SHA-1，再更新 `FORK.json` 中的逐文件摘要。
- 仍只分发七个 Pi runtime 包；新增外部运行时依赖 `marked-cjk-friendly@0.1.2`。chord、durable、env 仍是维护 workspace，不进入产品七包边界。

## 主要行为变化

- 分类器图片输入；Codemode worker 排队与 `PI_CODEMODE_MAX_WORKERS`。
- 压缩不再用 `reserveTokens` 派生摘要输出上限；split-turn 前缀摘要也接收用户压缩指令。
- 恢复时成对处理被省略的 tool call/result；恢复会话或切换 tree 时激活真正新增的普通扩展工具。
- Provider identity headers 移入 pi-ai；工具变化缓存失效、并发对话框、CJK Markdown 与模型目录更新。
- 保留 rotom 的连接阶段无限恢复/发送后有界恢复、Context Layers 投影、压缩 usage/计时/思考档位、并发 split-turn 摘要与 sibling 取消、文件列表去重，以及 Codemode 的 `model-only` 边界。
- pi-ai 的 telemetry 仍由调用方显式传入；不为此次升级启用新采集器，不改变 rotom 的 metadata-only 观测边界。

## 按需工具兼容修复

评估阶段用真实 AgentSession 和本地 faux provider 复现：仅替换成上游 1.4 的工具恢复算法，`/tree` 会把从未发现的 Subagent 当作新增工具重新激活。原实现对照通过，上游算法对照失败。

产品注册层现在只在 launcher 的默认工具面握手有效且 deferred 未关闭时，为 Subagent 设置原生 `defaultActive:false`。不是禁用上游“新扩展激活”功能，也没有给 Pi 添加产品专属恢复分支。

- loader 接受原生全组 inactive 初始状态；部分 active 的 group 视为调用方更窄的选择，不覆盖。
- live tree 在 Pi 恢复选中分支工具面后，只追加当前会话已发现的 group，不把放弃分支的发现记录写回新分支。
- new/resume/fork/reload 则只从选中分支恢复，不能沿用 outgoing live loadout。完整 `check-personal` 首次运行抓到 reload 泄漏；保留原有启动收窄步骤并适配原生 inactive 默认值后，真实 public runtime 回归通过。
- `ROTOM_DEFERRED_TOOLS=0`、显式 `--tools`/`--exclude-tools`、SDK/extension 直载与更窄 runtime policy 保持原有优先级。

## 验证与边界

环境：macOS arm64，Node 24.18.0 / npm 12.2.0。只使用本地 fixtures、faux provider 与隔离 HOME；没有发起真实模型评测。

| 检查 | 证据 |
|---|---|
| `cd rotom && npm run build:pi && npm run check:pi` | 全部 workspace offline build；分批 1048 次通过、3 次依赖外部条件的跳过（含重叠）；七包来源/构建器/归档合同通过 |
| `npm run test:distribution` | 27 passed，含当前文档版本、installed identity、路径和分发边界 |
| `rotom/bin/check-personal` | 373 个产品检查 + 87 个 Goal 检查通过，另含离线 Provider 矩阵和 footprint gate |
| deferred/public loader/ownership 定向检查 | 32 passed，含未发现工具、live tree、分支替换、resume/fork/reload、默认面/关闭/显式选择 |
| 独立上游回归 | recovery tool-result 配对 1 passed；Codemode 27 passed；TypeSafe/Cloudflare classifier mock transport 29 passed |
| runtime verifier + builder | 42 passed；七包 installed archive integrity 与最终重建产物一致 |
| default/full public runtime smoke + footprint | 均通过；每次 smoke 为 2 次本地 faux 调用，lifecycleErrors=0 |
| 合并冲突涉及的 5 个源码/测试文件 | Biome check 通过；没有自动格式化其它上游代码 |
| `audit-public.py --root . --history` | 244 个公开提交、33175 个文件，0 findings；启发式扫描，不是任意秘密或代码所有权保证 |

新增 `rotom/extensions/third-party/deferred-tools/native-restore.test.ts` 使用真实 AgentSession，验证未发现工具不会被 tree 激活、已发现工具在 live tree 保留、新普通扩展仍激活、replacement/resume 的分支边界。它依赖 fork 的开发构建，与无需开发 workspace 的 `check-personal` 分开运行：

```sh
cd packages/rotom-pi
npm ci --ignore-scripts --no-audit --no-fund
npm run build:offline
cd ../..
node --experimental-transform-types --test rotom/extensions/third-party/deferred-tools/native-restore.test.ts
```

macOS checkout 位于 `/tmp` 时先 `cd` 到 `pwd -P` 的 canonical 路径，避免 TypeScript 将 `/tmp` 与 `/private/tmp` 当成两套带品牌类型的模块。测试路径已随上游 SDK attribution 测试改名更新为 `sdk-client-identity.test.ts`，不以不存在的旧文件名冒充执行覆盖。

本次提交的文件大小门禁报告 103 个文件超过 20,000 bytes，其中 101 个为 Pi fork 文件，另外两个为已有的 `CLAUDE.md` 与第三方集成测试。用户明确批准仅此次同步的一次性豁免；不修改门禁规则，不把上游大文件机械拆分，也不豁免构建、行为测试或公开审计。

未做真实 Provider/付费调用、真实 Chrome 或桌面 TUI 验收；没有执行 npm publish、pack:release 或替换存活安装。分类器图片、CJK 显示、并发对话框及压缩费用/延迟的真实外部结果仍未验证；离线测试不替代这些验收。

## 1.4.0-rotom.2：压缩摘要保留长期指令

真实会话中出现两类摘要偏差：

- 扩展消息（如 Goal 的 `goal-contract`）经 `convertToLlm()` 变成 user 消息，摘要输入里标成 `[User]`。摘要把“Goal 模式未启用、不得调用 Goal 工具”写进 `## Goal`，像是用户本人的目标。
- 用户先说“不要停下，直到完成整体功能”，之后问“目前什么进度了”。下一次压缩按最新消息重写，丢掉了这条长期指令，随后模型多次停下等待。

修复：

- `compaction/utils.ts` 新增 `serializeMessagesForSummary()`。扩展消息标为 `[Extension message (<customType>)]`，其他消息仍用 `serializeConversation()`。公开的 `serializeConversation()` 行为不变。
- 初次、增量、split-turn 前缀和分支摘要提示都追加 `SUMMARY_SOURCE_RULES`：范围、自主推进和交付方式的长期指令按用户原话放进 Constraints & Preferences，直到用户撤销、替换或工作完成；进度询问、阶段完成或暂停不算撤销；扩展消息不是用户目标或约束。

验证：`compaction-serialization` 与 `compaction-summary-reasoning` 新增回归，回退源码后两者失败；压缩、分支摘要与 bug-report 相关 vitest 25 文件通过。这只证明提示与序列化输入正确，不证明真实模型一定照做；摘要质量需要真实长会话回放验证。
