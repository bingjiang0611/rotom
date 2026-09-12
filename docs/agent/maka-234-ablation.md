# Maka 2/3/4：本地设计消融与精简

> 历史消融记录：版本、资源数量与结果仅适用于下述基线。命令中的仍存测试路径已同步目录重构，不代表当前源码重跑会得到历史计数；私有基线不保证存在于公开仓库。

基线：`633e21e`。范围仅限这次新增的 ownership 与 handoff 设计；不清理仓库其他架构。无付费模型、真实 Chrome 或平台写入。

## 决定

**删除冗余包装，保留有证据支撑的边界。** 两个独立精简方案及其组合都通过同一组回归；不是看到负向变体测试失败，就把整个设计宣布为必要。

实际精简：

1. **Subagent 两层 Proxy → 一层。** 把 publication lease 合入现有 `subagentPolicyApi`，统一执行参数归一化、update/result fencing 和 API publication 拒绝；删除 `subagent-publication.ts` 及其独立资源声明。注册次序、同步抛错、原工具 `this`、非主工具防护、命令/快捷键限制保持不变。
2. **Browser 分页两层同步包装 → 一个发布边界。** 七个分页返回路径从 `boundedResult(snapshotPage(...))` 改为 `snapshotResult(...)`。检查仍发生在 cursor mutation 之前；之后的分页与结果构造均同步，不跨 await，因此不需要再检查一次。

生产代码净减少 **18 行**，少一个模块、一个 Proxy 层和一次主工具参数转发包装。测试有所增加，不能把生产代码减少说成整个 diff 都在删行。未增加新的 registry、runtime、调度器或消融框架。

保留 Chrome dispatch adapter、tab reservation、Browser owner/abort 检查、artifact drain、退休 lease 和 `steeringRecovery:false`。305-byte handoff 指导不变；没有模型实验，不能判定移除它后的语义质量。

## 第一阶段：逐项移除

复制基线受 Git 管理的 `rotom` 文件及精确安装的 `.2` dependencies 到私有临时目录；每个变体独立从基线复制，只修改一个机制，不修改 installed source。统一执行五个测试文件，共 **24 项，无 skip/cancelled**：

| 变体 | passed / failed | 解释 |
|---|---:|---|
| control | 24 / 0 | 对照通过 |
| 禁用 publication lease 的 `assertLive` | 19 / 5 | 四项 fixture/protocol 拒绝合同失败；一项真实 Pi lifecycle 只是错误文案不同，**不能算泄漏** |
| `operationChrome` 直接返回原 API | 20 / 4 | attach/full-read/mouse 后续 dispatch 及 cleanup 边界回归；均为 Chrome API fixtures |
| 去掉 artifact close 的 pending-I/O drain | 23 / 1 | 真实本地文件 cleanup 返回 rejected，而非完成清理 |
| 禁用 Browser owner/abort 断言 | 19 / 5 | public-runtime 延迟 connect/store、cursor 和 abort 回归 |
| 去掉 direct-steer override | 23 / 1 | 参数策略合同失败；已有 timeout fixture **没有**触发 replacement，不能声称观测到重复 writer |
| 去掉 tab reservation 的 add/delete | 22 / 2 | 最初失败命中 private Set 断言，需进一步验证行为，不能据此排斥等价设计 |

## 第二阶段：删除包装而非删除边界

沿用第一阶段 **相同 24 项行为断言**；Subagent 变体仅适配合并后的 import/function 入口，没有放宽断言。

| 变体 | passed / failed |
|---|---:|
| 只合并 Subagent Proxy | 24 / 0 |
| 只合并 Browser 分页发布包装 | 24 / 0 |
| 两项合并 | 24 / 0 |

代码检查同时确认：lease 仍先于 package shutdown handler 注册，send 必须同步抛错；分页检查后到 cursor/result 构造之间没有 await。测试通过仅是局部等价证据，不是所有行为的形式证明。

## 第三阶段：排除自证式断言

增加一个主工具组合回归，检查绑定、参数归一化、单次执行、单份 guideline 和退休拒绝。修正两个消融证据薄弱点：

- **真实 public Pi shutdown 窗口**：以 readiness/release 握手暂停 shutdown，证明此时原始 Pi API 仍可写 outgoing fixture，而产品 lease 已拒绝迟到 append。去掉 lease 后，这次失败是 `Missing expected exception`，不再是 `retired` / `ctx is stale` 文案差异。这证明更早的退休拒绝合同，**不是复现真实子 agent 向新 session 发错消息**。
- **claim 行为探针**：去掉对私有 Set 的断言。清理未结束时 claim 必须在进入 Chrome API 前被拒绝；清理结束后允许进入。无 reservation 变体现在实际命中 `claim reached Chrome`，而非仅仅缺少某个内部字段。

三个确认变体共享更新后的 **25 项测试**：

| 变体 | passed / failed |
|---|---:|
| 精简后 control | 25 / 0 |
| 精简后禁用 lease | 19 / 6 |
| 精简后禁用 reservation | 23 / 2 |

三个阶段合计 13 次有界测试运行、315 项重复执行；不是 315 个独立案例。负向变体全部留在隔离目录，不进入产品。

## 最终验证与限制

- `rotom/bin/check-personal`：**137 passed / 19 既有停用 Safety skipped / 0 failed**。
- Browser relay + Chrome extension fixtures：**30/30 PASS**；resource/launcher identity：**32/32 PASS**。
- full/deferred public-loader 与 footprint：**PASS**。full 仍为 24 tools、40,547 schema / 13,427 guideline bytes；deferred 仍为 19 tools、17,052 / 8,466 bytes。工具 schema、指导文本和 package 版本未变。
- `git diff --check`：PASS。旧 helper 路径引用、测试 import 和 required resource 声明已同步。
- 保留一次交付检查失败：未改动的 `process-tree` abort 用例偶发返回 `unavailable`，连同父测试记为两个失败。确认无残留测试进程，核对源码/测试与基线逐字节相同；基线与当前定向检查各 **5/5 PASS**，随后完整检查通过。根因未确定，未改该模块或放宽断言，也不掩盖此波动。
- 未重跑付费 A/B，未真实 Chrome/TUI 重放；不报告 token、成本或速度收益。已 dispatch 的效果仍不等于被取消，lease 不隔离第三方任意文件写入。

## 复现与本地证据

各变体使用同一命令（cwd 为独立副本，`ROTOM_PI` 固定实际 Pi **0.85.1** executable）：

```sh
node --experimental-strip-types --test --test-concurrency=1 --test-reporter=tap \
  rotom/extensions/browser/ownership.test.mjs \
  rotom/extensions/browser/artifact-ownership.test.ts \
  rotom/extensions/browser/runtime-ownership.test.ts \
  rotom/extensions/third-party/subagent/publication.test.ts \
  rotom/extensions/third-party/subagent/runtime-ownership.test.ts
```

原始证据保存在维护者私有临时目录，不作为公开下载或可复现路径。保存基线 source digests、各变体源码、13 份 TAP、`results.json`、精简 patch/source digests、最终验证日志和三个一次性执行脚本。未复制凭证；临时目录不是永久归档。原模型实验见 [maka-234-report.md](maka-234-report.md)，不能将其当成本次精简的模型评测。
