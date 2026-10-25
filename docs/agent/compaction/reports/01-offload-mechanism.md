# 任务 01 执行报告：实现完成，待规划者核验

## 结论与范围

按 `e6da2afa` 修订后的合同实现了默认关闭的 `compactionOffload`。专项 L1 **32/32 通过**；全量 **198 通过、2 个任务说明已知失败**，无新增失败。不声明已接入 rotom 产品或已改善真实会话速度/质量。

仅修改 `packages/rotom-sol-pi/` 和本报告。未修改 `rotom/`、Pi fork、版本或 vendor 归档；未新增 npm 依赖，package/lock 未改。未调用真实模型，未读取或外发真实会话内容。

沿用独立 worktree，先执行 `git pull origin compaction/offload-first`，fast-forward 到修订基线；保留原工作区其他任务 WIP。只提交/推送 `compaction/offload-first`，不推 main、不改写历史、不 force push。

## 文件清单

下表组件路径相对 `packages/rotom-sol-pi/`。

| 文件 | 用途 |
|---|---|
| `src/sol-pi/extensions/observation-pack/offload.ts` | 候选、独立短占位符、token 估算、记录读取/追加、分支恢复、unknown 标记、阈值推迟与投影。 |
| `src/sol-pi/extensions/observation-pack/index.ts` | factory 接收可选开关；开启时挂载新生命周期处理，卸载投影优先于原有 FULL_SENDS。 |
| `src/sol-pi/extensions/observation-pack/observation.ts` | `createObservation` 增加可选最小字节参数，默认仍为原来的 10 KiB。 |
| `src/sol-pi/constants/copy.ts` | 集中管理新增推迟提示及配置依赖错误文案。 |
| `src/sol-pi/config.ts` | 新 boolean 键，默认 false，开启必须同时配置 observationPack=true。 |
| `src/sol-pi/index.ts` | 把加载后的开关传给 Observation Pack。 |
| `scripts/check-sol-pi-config.mjs` | CLI 校验新增键、类型与依赖关系。 |
| `sol-pi.example.json` | 显示默认关闭的配置。 |
| `docs/configuration.md` | 新增 22 行功能说明：触发、推迟、恢复、unknown 与限制；schema 同步新键。 |
| `tests/compaction-offload.test.ts` | 32 个纯函数/handler/真实文件系统/faux AgentSession 用例，仍是全部专项验收的入口。 |
| `tests/compaction-offload-session.ts` | 合成结果生成及 faux AgentSession fixture；按职责从验收用例中分离，不包含额外测试入口。 |
| `docs/agent/compaction/reports/01-offload-mechanism.md`（仓库根相对路径） | 本次交付、验收与历史核验记录。 |

## 关键行为与持久化边界

- 只处理 `reason === "threshold"`；关闭开关时不注册任何新 handler。
- 从 `messagesToSummarize` 和 `turnPrefixMessages` 取候选，不动保留区；去重同一 toolCallId，不重复计算已卸载对象。
- 只选择成功的纯文本结果，UTF-8 字节数 >1536 且 ≤10240，排除 obs_recall 和 Reducer 回执。
- 占位符最多 512 字节，完整开头行摘录最多 200 字节；元信息本身过长或不够划算时跳过。
- 严格使用任务的 chars/4 与 `after <= 0.6 × (contextWindow − reserveTokens)` 判定；无 assistant usage 锚点或非正阈值时保守保留原生摘要。
- 先把所有对象交给 `ensureStored` 写入/验证，再追加一个 metadata-only 自定义条目；任何可见记录只引用此前已存好的对象。
- `appendEntry` 抛错：`offload_native / record_append_failed`，返回 undefined，不重试、不补偿、不改历史。内存可能有记录、磁盘可能没有，状态是 **unknown**。
- unknown 记录仍可用于投影：原文对象已经存在。原生压缩自己的写盘是否也失败属于 Pi 现有故障面，本任务没有改变它。
- 只有确认过的推迟可以再次取消相同 assistant entry 的旧 usage 检查；新 assistant 回复重新评估。
- session_start/session_tree 和每次 context/threshold 检查按当前分支重建记录集合。后者也覆盖 factory 在 session_start 内动态注册、以及分支切换后的首个请求。
- 投影不改原始 session 消息；每次重新验证对象，不缓存“曾经存在”作为永久证据。缺失、symlink、目录、哈希不符或 ledger 写失败时保留原文。
- 新增 ledger 只含 id、tool、大小、计数、估算和原因；异常不回显正文。成功时复用 `showSolPiSavings`。

### 保守解释与兼容性说明

1. **unknown 在切树后也不确认**：用本进程 WeakSet 保留失败记录身份，session_tree 不清除。修订合同允许切树后最多多推迟一次；这里选择更保守的“不因此取消”。真实 EISDIR 用例验证了切树前后都不 stale-cancel。
2. **fork 缺对象时留原文**：投影先检查对象存在，再调用 ensureStored 验证。fork 的新 runtime root 不借用父会话对象路径，不把缺档案的结果换成指针；测试证明这一点。成功的同文件 resume 可以继续显示指针。
3. **CLI all-enabled 合同不扩张**：`compactionOffload` 是 Observation Pack 的可选修饰项，不是第五个独立机制；现有 `--require-all-enabled` 仍检查原四机制，不强迫实验开关为 true。CLI 仍输出其 effective 值并校验依赖关系。
4. **附加观测失败**：记录正常追加后，如果 ledger/TUI 通知抛错，仍不取消，记录留作 unknown，ledger 可用时原因记 `notification_failed`。无法写 ledger 时只输出固定错误原因，不再抛错或重试。专项测试覆盖 ledger 路径为目录的情况。
5. **Pi 版本**：依赖仍锁定 npm Pi `1.3.0`，无需兼容 shim。该版本事件类型的 reason 联合没有 `extension`，实现只比较 threshold，handler 测试另传 extension 验证不介入；未改依赖类型或版本。该版本没有 `session_fork` 事件，因此没有注册猜测性的 handler，依靠上述分支恢复路径。
6. `showSolPiSavings` 现有外层文案含 “Money saved”，本任务按要求复用、未改共享 UI；传入的新文案只报告估算 token，不据此声称真实费用节省。
7. 首次提交被仓库单文件 20,000 字节上限拦截，没有产生提交。按职责提取合成结果与 AgentSession fixture 到独立辅助文件，保留全部断言和指定专项入口；拆分后重跑 typecheck、32 项专项及全量测试，结果不变，没有绕过钩子。

## 卸载占位符实际样例

用当前 `offloadCandidate` 执行生成：toolName=`read`，toolCallId=`synthetic-example`，正文为第一行 `synthetic first line` 加一个换行，后接 2000 个 `x`。没有写对象文件或真实会话。

```text
[older tool result offloaded before compaction]
id: obs_92c37e4292882cef883c4960
tool: read
original_bytes: 2021
original_lines: 2
retrieve: call obs_recall with {"id":"obs_92c37e4292882cef883c4960","offset":0}; continue with returned next_offset
synthetic first line
```

**占位符 268 UTF-8 字节**（含末尾换行），原文 2021 字节/2 行。超长的第二行没有截断塞进摘录；中英文完整行、超长工具名和不划算占位符另有单测。

## 验收命令

环境：macOS、Node `v24.18.0`、SoL-Pi `0.1.0-rotom.3`、npm Pi `1.3.0`、Vitest `4.1.11`。最终验收在重新执行 npm ci 后顺序运行；下表前五条 cwd 为 `packages/rotom-sol-pi`，最后两条为仓库根。

| 命令 | 最终结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，安装 167 包。npm 报告现有 8 项漏洞（6 moderate、2 high）；未运行 audit fix、未改 lock。 |
| `npm run typecheck` | 退出 0。 |
| `npx vitest run tests/compaction-offload.test.ts` | 退出 0；1 文件、32 用例全部通过。 |
| `npm test` | 退出 1；20 文件中 19 通过、1 失败；200 用例中 198 通过、2 失败。仅说明已知的 install-guide 两个缺文件用例，无新增失败。 |
| `npm pack --dry-run` | 退出 0；37 文件，52.8 kB 压缩 / 180.2 kB 解包。确认包清单包含 offload.ts 和 copy.ts；没有打 vendor 归档或安装发行版。 |
| `git diff --check origin/main...HEAD` | 退出 0；另外检查未提交/暂存 diff，提交后再次检查该命令。 |
| `python3 scripts/audit-public.py --root .` | 退出 0，tracked-tree PASS：7,797 文件，0 findings；包含已暂存的新源码、测试和报告。 |

### L1 证据

- 字节边界 1536/1537/10240/10241；UTF-8 完整行、≤512 字节；错误/图片/recall/receipt/重复/已卸载过滤；turnPrefix 入选。
- 无 contextWindow、无候选、收益不足回退；model.contextWindow fallback；三个非 threshold 原因不读写卸载记录。
- 对象路径目录、symlink、同长度错误哈希：不追加记录、不取消；投影缺对象/错哈希保留原文。
- 真实 EISDIR（把合成 session 文件换成目录，不 mock appendEntry）：对象先存在、记录留内存、返回 undefined、明确 ledger 原因、不 stale-cancel；分页 obs_recall 拼接后与原文逐字节一致。恢复原磁盘文件再打开时无该记录、显示原文。
- 树分支只认自己的记录，重新打开成功写入的 session 恢复指针；fork 无档案保留原文。
- **A/D**：真正的 createAgentSession + faux provider，多个 2–8 KiB 工具结果；最终 assistant 回复才触发推迟，明确断言记录锚点等于最后 assistant entry；下一次 prompt 命中 offload_defer_stale，无原生摘要调用；provider 收到旧结果指针、保留区原文；原始 session 不变；新 SessionManager + 新 AgentSession 仍发送指针，分页 recall 原文一致。
- **B**：小结果/大保留区两组均通过真正的原生 compaction 流程，由本地 faux provider 生成摘要；有 compaction entry、没有卸载记录，并断言摘要调用数大于零。
- **C**：推迟后新 assistant usage 再次超阈值且确实无候选；ledger 为 no_candidates，发生原生 compaction，不重复追加卸载记录。
- **反向对照**：临时禁用 threshold 分支后跑 A/D，按预期失败：应无 compaction entry、实际出现 1 条。已恢复实现，最终专项和全量验证都在恢复后执行。

开发过程中最初的会话测试曾在中途工具调用而非最终回复时推迟；已加强为断言最终 assistant 锚点与下一次 prompt 的 stale ledger，再调整合成负载/保留窗口以覆盖指定场景，没有修改生产判定或放宽断言。完整回归中曾出现 CLI 子进程测试 5 秒超时；将新增的多个 CLI 配置检查拆成独立用例后重新验证，最终仅剩已知两失败；未放宽 timeout、未改既有测试。

### 已知失败（与本改动无关）

`tests/install-guide.test.ts` 两项分别读取组件内不存在的 `AGENTS.md`、`CLAUDE.md`，均为 ENOENT；修订前基线也是 166 passed / 2 failed。按任务要求不补入这些指导文件，不跳过/弱化用例。

## 未验证：L2 / L3

本任务只到 **L1**。虽然使用了真实 Node 进程、SessionManager、文件系统和 AgentSession 调度，模型仍是本地 faux provider，不能冒充 rotom 产品 L2 或真实模型 L3。

- 未重打归档、未在 rotom 安装/启用，当前发行版行为不变；任务 02 负责接入。
- 未测真实模型的压缩等待、obs_recall 频率、任务成功率或 credits；任务 03 需另行授权费用。
- chars/4 是估算，不是 provider 精确 token；阈值能否带来净收益未知。
- 附加磁盘写入和 ledger 的实际延迟未做性能声明；原生 Pi 写盘失败仍可能令摘要记录追加失败。
- unknown 的有界后果仍是：内存有记录时可用已存对象投影，磁盘无记录的重启显示原文；没有原子事务、自动补偿或 unknown 写重放。

## 最终审计与交接

最终公共审计：tracked-tree PASS，7,797 文件、0 findings；它是启发式扫描，不证明不存在任意秘密或知识产权风险。独立 worktree、npm 安装目录和本机验收日志保留用于规划者核验；测试创建的合成会话均由 afterEach/finally 清理，无后台进程、无发行版安装。

下一步 owner：规划者按任务说明重跑并核验本分支，再决定任务 02；执行者不自行更新看板为 accepted，也不扩展到产品接入或真实模型实验。

## 历史：原阻碍及规划者裁定

先前报告 `80aef291` 证明 Pi `_appendEntry` 先更新 fileEntries/byId/leafId 再写盘，EISDIR 会留下内存记录，无法满足最初“全有或全无”要求，因此当时停止实现。

### 核验意见（规划者，2026-10-25，原文保留）

阻碍成立，复现命令我读过，逻辑和 Pi 源码（`session-manager.ts` `_appendEntry` 先改内存后 `_persist`）一致。停下来是对的。

裁定：**不另开 Pi 持久化任务，修订任务 01 的合同**。原不变量 4 的「全有或全无」要求过严，真正要保证的是「卸载后原文不丢、能取回」，而这只取决于顺序：先存对象、后写记录。新的合同见任务说明「持久化合同（修订）」一节和不变量 4：追加抛错时返回 `undefined` 让原生摘要照常跑，这次推迟状态记为 unknown，不重试、不补偿；旧 usage 的「再次取消」规则只认确认过的推迟。测试清单加了一条真实 `EISDIR` 用例。

这不放宽对外声明：报告里照实写 unknown 状态和它的有界后果，不写成原子事务。

请按修订后的说明继续实现任务 01。

## 核验意见（规划者，2026-10-25，第二轮）

结论：**accepted**（`3c7c53d`）。

重跑结果（cloud 环境，Linux，锁定 Pi `1.3.0` devDependency）：`npm ci`（npmjs registry 替换）退出 0；`npm run typecheck` 通过；`tests/compaction-offload.test.ts` 32/32；`npm test` 198 通过、仅 install-guide 2 个已知失败；`npm pack --dry-run` 37 文件，含 `offload.ts` 与 `constants/copy.ts`；`git diff --check origin/main...HEAD` 通过；`audit-public.py` PASS、0 findings。

代码审阅确认：只在 `reason === "threshold"` 介入；先 `ensureStored` 全部成功才 `appendEntry`；unknown 用 `WeakSet` 按记录对象身份标记，这依赖 Pi `appendCustomEntry` 原样保存 `data` 引用，我核对过仓内 fork `session-manager.ts` 也是同一引用，成立；旧 usage 规则只认确认过的推迟，`session_tree` 后也不会误认（比任务说明允许的更严，可以）；投影对缺失对象 fail-open。

不阻塞、放到任务 02 一起修的三点：

1. ledger/TUI 写失败会改变推迟决定（stale 路径和追加成功后的路径），应改为只记错误、不影响决定。
2. TUI 文案是中文，SoL-Pi 其余 TUI 是英文。
3. 投影每次请求都对每个已卸载结果 `lstat` + 重读哈希，卸载条数多时有无谓 I/O，应在进程内缓存已校验的 id。
