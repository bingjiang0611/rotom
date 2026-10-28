# 本机会话与标注

[返回评测入口](../README.md)。本页命令和反引号内的相对路径以 `rotom/evals/` 为工作目录，除非另有说明。

## 本机会话卡片与标注（零模型）

Node ≥ 24；从 Pi session 当前分支生成 Markdown 卡片，按工具调用 ID 的 SHA-256 关联 trace。

```sh
node rotom/evals/scripts/session-cards.mjs build --since 7d --limit 50
node rotom/evals/scripts/session-cards.mjs labels
```

以上命令从仓库根执行。默认读取 `~/.pi/agent/sessions`，输出 `~/.rotom/evals/cards`；
可用 `--root`（仅 build）和 `--out` 指定目录。build 单次最多 500 个会话，按文件修改时间倒序。
在卡片末尾填写 `verdict: pass` 或 `verdict: fail`；`categories:` 用逗号分隔，`note:` 可多行。
`labels` 只收 verdict 非空的卡片，写入卡片目录上一级的 `labels.jsonl`。
`labeledAt` 是本次导出时间；重复 build 原样保留已填 verdict 的标注块，格式损坏时拒绝覆盖。
卡片目录权限为 0700，卡片和标签文件为 0600；拒绝 Git 工作树内输出及 symlink 根/输出目录。
输入只读，按行流式读取；超过 256 MiB 的 session 跳过，超过 64 MiB 的行跳过并计解析错误；trace 同样有界。
缺少 trace 标 missing，损坏、超限或未结束工具 span 标 partial，不把未知工具结果当成功。
build/labels 的 stdout 仅输出计数（labels 另含人工填写的类别计数），不输出会话正文。
跳过按超限、无效 header、空会话、重复 ID 拆分；解析错误分别统计 session / trace，并保留总数。
`invalidHeaderKinds` 输出受限 header 类别，`invalidHeaderKeySets` 只输出排序后的安全字段名，不输出字段值。
header 跳过空行和坏 JSON 后查找；`sessionVersions` 只统计已生成卡片的 1/2/3/missing 版本。
缺少 version 或 version < 2 的会话在内存中重建线性分支，不回写输入；支持 bashExecution / custom 消息。
真实卡片、标注及会话内容只留本机私有目录，绝不加入仓库或公开报告。

在交互终端运行 `node rotom/evals/scripts/session-cards.mjs review`，可传 `--out <cards dir>`、`--limit N`；默认按 started 从新到旧问最多 50 张未标注卡片。
`y` 满意，`n` 不满意后补一句原因（可回车留空）；categories 留空，分类交给规划者。
`s` 跳过，`o` 显示完整卡片绝对路径，`q` 退出；逐张保存，Ctrl+C 保留已保存回答，损坏标注块不覆盖。
需 TTY 输入；review 输出含私有摘要，不要复制进仓库。完成后运行 `labels` 汇总，仍可手工编辑标注块。

### 卡片规则检查（零模型）

规则只检查当前分支；hit 不等于人工 fail，缺少所需证据为 unknown，不能视为 clear。

| 规则 | 命中条件 |
|---|---|
| `repeat-after-error` | 错误结果后，紧接着调用相同工具及按 key 排序后相同的参数 |
| `ended-after-tool-error` | 最后工具的 trace outcome 非 ok，后续最后 assistant 以 stop 收尾 |
| `ended-on-provider-error` | 最后 assistant 为 error，或 aborted 后没有新 user |
| `schema-errors` | 当前分支工具的 schema outcome 至少 2 次 |
| `oversized-tool-result` | 工具结果文本字节数大于 50 000 |
| `harness-fault` | 工具 fault_side 为 harness；已结束的 ok/aborted 按合同缺此属性时视为无该故障 |

卡片、build 汇总及 labels 导出均包含 findings；旧卡片缺少 findings 时导出为全 unknown。

### 标注一致性报告（零模型）

从仓库根执行 `node rotom/evals/scripts/session-cards.mjs agreement`；可用 `--out <cards dir>` 指定卡片目录。
读取卡片目录上一级的 `labels.jsonl`，不修改标注；默认读取 `~/.rotom/evals/labels.jsonl`。
stdout 只含计数和比例；同级 `agreement.md` 以 0600 写入，包含信号统计、类别覆盖及 FP/FN 会话 ID。
仅 pass/fail 参与统计；unknown 或缺少某个信号不进入四格。零分母显示 n/a，小分母标 `(n<10)`。
信号名自动从有效标注发现，不限于当前规则；报告不生成总分、不代填 verdict，输出仍拒绝 Git 工作树。

### 每周效率统计与定向补标（零模型）

```sh
node rotom/evals/scripts/session-cards.mjs stats --since 28d
node rotom/evals/scripts/session-cards.mjs build --focus --limit 40
```

`stats` 按 ISO 周和 `provider/model` 汇总会话数、toolCalls／时长／tokens 的中位数和 p90、总工具出错率、
无最终文本与 provider 错误占比、各规则命中占比和 costUsd；stdout 只有聚合 JSON，会话 ID 只写入同级私有的
`stats.md`（含工具出错最多的 10 个会话）与 `stats.jsonl`（每会话一行）。拿不到的指标记 null 并附样本数 n，
cost 缺任一条时整列 null 并标 partial；总出错率是各会话 toolErrors 之和除以已结束 span 之和，不是比率平均。

工具与 provider 出错来源见 `session-cards.mjs breakdown --since 28d`：按工具名和 `provider/model` × 错误类别拆分。
命令与旧 edit 错误只在内存里分类；命令类别、重复失败信号及同级 `labels.jsonl` 标注对照只输出聚合计数。
stdout 不含命令、参数、fingerprint 或会话 ID；会话 ID 只写入同级私有的 `breakdown.md`。

`rotom --trace` 后台的「评测」页支持本机会话复盘与人工标注。活动状态与人工结论分开；active 会话允许按当前进度标注，记录 `atEntryId` / `atEntryCount`，unknown 状态仍禁止写入。标注后追加内容会显示「标注后有新进展」。默认筛选未标注，筛选计数与已标注进度独立显示；列表按会话身份/开始时间稳定分页，时间线变化最多自动重载一次。
标注写入 `~/.rotom/evals/annotations/`；`labels` 统一合并卡片与 annotation，冲突以 annotation 为准并计 `conflicts`，新增 `failSet`。

「让模型分析」先展示模型、发送字符数与截断情况，逐次确认后才启动产品 launcher。摘要只含当前分支，不含人工标注，最多 80,000 字符。长会话保留全部用户消息与助手文本、非 ok 工具及前后各 2 个事件、首尾各 20 个事件，其余连续 ok 工具折叠为保留原序号范围和工具计数的 `tool_run`；只能引用未折叠的事件，折叠后仍超限才拒绝。只有一个分析可运行，180 秒超时，可取消，不自动重试。原生 `--single-request` 关闭工具、会话落盘、自动压缩/预热及两层重试；默认模型仍由 Pi 解析，选定模型使用精确 `provider/model`，不模糊匹配或回退。模型目录只缓存成功结果；读取失败可点「重试读取模型」，不自动重试，也不触发分析。分析失败会区分「模型回复被截断」与「回复格式不合格」，并在页面显示原因与处理建议；截断检测同时覆盖 `stopReason` 非正常结束、半截 JSON 和 stdout 超限（4 MiB）。判词输入在截断之前先做凭据脱敏（`eval/redaction.mjs` 的具名模式表：PEM 私钥、`sk-`/`sk-ant-`、GitHub token、AWS `AKIA`、Slack `xox[a-z]-`、JWT、`Bearer`、`key|token|secret|password` 赋值），替换为 `[已脱敏:类型]`；确认弹窗显示脱敏处数，judgment 记录只保存 `redactions` 的类型与次数，不保存原文。这是尽力而为的黑名单过滤，不能证明提示词里没有秘密。判词长度上限为 summary 120 字、evidence 6 条各 80 字、suggestions 4 条各 80 字，避免输出被服务端上限截断。成功目录在更新安装/登录后需重启后台刷新；不会复制 API-key/token 环境变量或凭据文件，认证由子进程的原生登录存储处理。

后台性能合同：目录扫描按层并行（最多 64 并发）、跳过符号链接，只校验一次 canonical 根目录；会话 header 按 `(inode, size, mtime)` 缓存，列表只解析当前页会话，不再为整库构造行。一次列目录结果缓存 1.5 秒，供「打开列表 → 打开详情 → 保存后刷新」的突发请求复用；`refresh=1` 强制重新列目录，写入前也会重新校验。筛选在分页之前完成，所以「未标注」等筛选页仍是完整的 10 条，游标指向筛选后的序列。`counts` 中 `all` / `unlabeled` / `fail` / `failSet` 来自标注，始终精确；`hits` 需要完整 branch，未测量前返回 `null`，页面显示「按需统计」，首次进入该筛选时才计算并缓存。列表现已附带 `matched`、`elapsedMs` 与 `hits: null` 语义。Trace 扫描同样并行读 tail，并按文件 `(size, mtime)` 缓存摘要，20 秒内重复请求直接复用；「刷新数据」会重新扫描，但未变化的 trace 不会重读。页面加载时显示已等待秒数、骨架行与「用时」，加载期间禁用筛选以避免排队请求。

模型目录失败会区分 launcher 执行权限、运行时校验、超时、非零退出、空 stdout、非法 JSON、重复 id 和默认模型缺失，并显示可复制的同路径排查命令。子进程 stderr 只写后台进程日志，不进入 API 响应或 trace。空模型目录是有效协议响应，页面提示配置/登录后重启后台以刷新目录缓存。

真实 launcher 的可复跑检查（先按架构文档安装当前锁定运行时）：

```bash
node rotom/extensions/observability/eval-launcher-check.mjs --faux
# 可选：--launcher /absolute/isolated-checkout/rotom/bin/rotom-launcher
```

默认使用临时空 HOME、空工作目录与 Node 网络拦截，执行后台相同 argv 的模型列表检查；`--faux` 另用原生离线 faux provider 检查非空目录、默认模型、单次 JSON 事件流及 stderr 分离。复用后台校验函数，只输出计数/状态，结束后清理隔离数据，不使用用户凭据、会话或付费模型。该检查也进入 Evals L1 CI。

合成 UI 检查默认使用 Playwright 自带的 Chromium（先用对应 Playwright CLI 安装 `chromium`）；可用 `PLAYWRIGHT_CHANNEL=chrome` 显式选择本机 Chrome，`PLAYWRIGHT_MODULE` 指定已有 Playwright 模块路径。

分析以私有追加记录写入 `~/.rotom/evals/judgments/<sessionId>/<timestamp>.json`，不改原始会话/trace，不覆盖历史。结果格式不合格、失败、超时、取消均单列；缺失费用为未知，Pi 计算费用仅显示为估算，不冒充服务商账单。「采纳建议」仅预填，仍须人工保存。`agreement` 追加最新成功且非 unsure 分析与人工标注的 TP/FP/FN/TN；n < 10 标星，未对齐不同进度的结论不代表模型可靠性。
`review` 跳过已有 annotation；agreement/breakdown 复用同一合并逻辑。无卡片时仍支持已有 labels.jsonl 导出文件，不把它覆盖实时卡片。
共享读取、分支、规则、指标仅在 `extensions/observability/eval/` 保留一份源码，eval 脚本通过 import/re-export 复用。

`build --focus` 只生成可疑会话的卡片：工具出错数 ≥ 5 且出错率 ≥ 10%、任一规则命中、无最终文本、
或 provider 错误。此时 `--limit` 是要生成的卡片数上限，扫描仍按 500 个会话；summary 另有 `focusScanned`、
`focusMatched` 和各条件命中计数。已填 verdict 的卡片照旧保留标注，`review` 仍只问未标注卡片。
