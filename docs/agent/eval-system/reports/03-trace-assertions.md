# 任务 03 执行报告：规则检查接入会话卡片

实现完成，提交核验（`in-review`）。规则及卡片集成的 61 项 L1 测试通过，类型检查通过；已完成仓库外 `--limit 50` 真实数据冒烟和随机抽查。全量测试仍有任务 01 已确认的 10 项运行时依赖失败，没有新增失败。

## 改动文件

| 文件 | 作用 |
|---|---|
| `rotom/evals/scripts/trace-assertions.mjs` | 6 条确定性规则及纯函数 evaluateSession；具名阈值、稳定规则 ID、hit/clear/unknown 和仅元数据 evidence。无文件读取、模型调用或新增依赖。 |
| `rotom/evals/scripts/trace-assertions.d.mts` | 规则、输入、状态及证据的类型声明。 |
| `rotom/evals/scripts/session-cards.mjs` | 卡片 frontmatter、规则命中小节、build 汇总及 labels 导出接入 findings；拆分 session 解析错误原因。 |
| `rotom/evals/scripts/session-cards.d.mts` | 补充 findings 和 6 个解析错误计数，保持类型检查。 |
| `rotom/evals/test/trace-assertions.test.ts` | 每条规则的 hit/clear/unknown 合成用例，以及边界、缺失数据、纯函数及隐私检查。 |
| `rotom/evals/test/session-cards.test.ts` | 卡片与导出的 findings 一致性、标注保留、旧卡片处理及解析错误原因测试。 |
| `rotom/evals/README.md` | session-cards 小节下增加规则表及 unknown / 人工标注边界，新增说明不超过 15 行。 |
| `docs/agent/eval-system/README.md` | 任务 03 改为 in-review；不改任务 01/02 状态。 |
| `docs/agent/eval-system/reports/03-trace-assertions.md` | 本报告。 |

未修改 observability、CI、运行时依赖或锁文件；未增加 judge、/flag，也不根据规则自动填写 verdict。

## 规则合同与数据核对

- 已核对 observability 源码：`pi.tool.call_id_digest`、`pi.tool.outcome`（含 schema）、`pi.tool.result_text_bytes` 和 `pi.tool.fault_side` 均有对应写入；没有因属性不匹配而改条件或整条禁用规则。
- traceTools 沿用卡片读取器的 SHA-256(call ID) Map；只有当前分支的工具调用参与检查，其它分支的 span 不计入。start/end 属性由读取器按 traceId + spanId 合并；未结束 span 无可用终态属性。
- 重复调用比较递归排序对象 key 后的 JSON；数组顺序保留。相邻调用按当前分支中的工具调用顺序定义，同一 assistant 内的相邻调用也检查；命中不额外推断因果关系或自动判 fail。
- 缺少相关结果、isError、stopReason 或 trace 属性时保留 unknown。partial trace 不支持聚合规则的 clear；已有足够正面证据时仍可 hit。当前分支缺失父节点或消息等顺序信息时，顺序/收尾规则保守返回 unknown。
- schema-errors 的 count 是已观察到的 schema 次数，只有达到 2 才 hit；例如可完整判断的 1 次是 clear/count=1，信息不全的 1 次是 unknown/count=1。超长结果严格大于 50 000 字节才命中。
- evidence 不保存参数、结果正文或 assistant 文本。卡片只展示 hit 及最多 600 字符的元数据摘要；无 hit 时写 `(无)`，不能将其解释为所有规则 clear。

## 验收命令及结果

环境：macOS，Node `v24.18.0`，npm `12.2.0`，Vitest `4.1.9`。

| 命令 | 结果 |
|---|---|
| `cd rotom/evals` | 成功；以下 npm 命令在此目录执行。 |
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，安装 180 个包；仍提示既有 8 项漏洞（3 moderate、5 high），未额外升级。 |
| `npm test -- test/trace-assertions.test.ts test/session-cards.test.ts` | 退出 0；2 个文件，61/61 通过。 |
| `npm test` | 退出 1；16 个测试文件中 12 通过、4 失败；160 项中 149 通过、10 失败、1 跳过。 |
| `npm run typecheck` | 退出 0；单独执行，不受前一失败短路影响。 |
| `cd ../..` | 返回仓库根，后续 Git / audit 命令在根目录执行。 |
| `git diff --check origin/main...HEAD` | 退出 0，提交后复查；同时检查工作区和暂存区 whitespace。 |
| `python3 scripts/audit-public.py --root .` | PASS，0 finding；新增文件已加入暂存区。 |

另对两个 `.mjs` 执行 `node --check`，通过。全量失败仍为相同 4 个文件中的 Computer Use identity/version 不匹配：product-runtime 2 项、coding-hygiene-rule-ablation 3 项、pi-harness 3 项、tool-surface-ablation 2 项。本任务未修改这些文件或运行时安装，未放松 identity gate，也未跳过失败用例。

### L1 关键证据

- 每条规则均覆盖 hit/clear/unknown；包括阈值恰等于 50 000、schema 仅 1 次、trace missing/partial、属性缺失、未结束工具、未知消息及悬空分支。
- 重复参数覆盖嵌套 key 顺序、数组顺序差异、不同工具、同一 assistant 的相邻调用；末次工具按摘要关联，不能用更早的错误替代最后调用。
- aborted 后有新 user 为 clear；error 的条件不擅自加上“之后没有 user”。
- 规则输入前后相等，输出只包含元数据；其它分支 span 不产生当前分支命中。
- findings 从卡片到 labels 保持一致；重建刷新 findings 且逐字保留人工标注。合成卡片即使命中 harness-fault，也保留人工填写的 pass，不自动改成 fail。
- 旧卡片没有 findings 时导出六条 unknown；损坏的 findings 拒绝导出，不覆盖已有 labels 文件；正文不能冒充 frontmatter。
- 解析错误覆盖坏 JSON、超长行、缺 ID/parentId、悬空父节点、循环和缺消息，总数等于分项之和。

## 真实数据冒烟（仅计数）

命令：`node rotom/evals/scripts/session-cards.mjs build --limit 50 --out <仓库外私有临时目录>/delivery-cards`。

| 字段 | 计数 |
|---|---:|
| generated | 23 |
| skipped | 27 |
| skippedOversized | 0 |
| skippedInvalidHeader | 27 |
| skippedEmpty | 0 |
| skippedDuplicate | 0 |
| traceMissing | 0 |
| tracePartial | 4 |
| parseErrors | 33 |
| sessionParseErrors | 33 |
| traceParseErrors | 0 |
| badJson | 0 |
| lineTooLong | 27 |
| entryMissingId | 0 |
| danglingParent | 6 |
| cycle | 0 |
| messageMissing | 0 |
| unknownEntries | 0 |
| invalidHeaderKinds | `{"other":27}` |
| sessionVersions | `{"1":0,"2":0,"3":23,"missing":0}` |
| 含 hit 的卡片 | 6 |
| 随机抽查卡片 | 3 |

| rule | hit | clear | unknown |
|---|---:|---:|---:|
| repeat-after-error | 0 | 17 | 6 |
| ended-after-tool-error | 0 | 14 | 9 |
| ended-on-provider-error | 2 | 15 | 6 |
| schema-errors | 0 | 15 | 8 |
| oversized-tool-result | 5 | 12 | 6 |
| harness-fault | 0 | 0 | 23 |

随机抽查结论：**3 张里 3 张命中合理**。

## 与说明不一致的地方及保守解释

没有省略交付物或规则条件。以下是说明未细化处的处理：

1. 解析错误分项作为 build summary 的同名顶层计数输出。badJson 包括 JSON 语法错误、非对象记录及缺少 entry type；entryMissingId 包括缺失/无效 id 或 parentId。合法 JSON 但不是 session header 的文件仅计 skippedInvalidHeader / invalidHeaderKinds，不再人为加一次 sessionParseErrors；因此不把“非会话文件”谎称为坏 JSON。这也是相关旧断言从总解析错误 4 改为 3 的原因，坏 JSON / 超长行 / trace 错误断言仍全部保留。
2. 旧卡片缺少 findings 时导出 unknown，而不是要求用户先覆盖卡片或默认 clear；已存在但损坏的 findings 则报错。人工 verdict 和标注块的原合同不变。
3. 随机抽查使用系统随机数无放回选取，随后针对卡片命中证据回读原始 session/trace，核对分支归属、末条 assistant/后续 user 或摘要关联的已结束工具 span；不声称阅读全文。卡片摘要截断时只核对其中完整展示的证据，不把摘要当作完整 JSON 数据源。结论只表示规则条件成立，不表示人工 verdict 必须为 fail。
4. 摘要里全 unknown 不是规则不可用：属性在源码存在，不代表每个历史 span 都有该属性。没有将缺失 fault_side 当作“无 harness 故障”。

## 未验证项与遗留问题

| 项目 | 边界与下一步 |
|---|---|
| 全量测试及 npm 漏洞提示 | 维持任务 01 已确认的既有问题，不在本任务升级或覆盖运行时安装；由维护者另行处理后复跑全量测试。 |
| 规则与人工 verdict 的一致程度 | 尚未计算，也不在本任务自动推断；由 bob 完成任务 02 标注后再比较命中与人工结果。真实标签未代填；导出行为由合成测试验证。 |
| 真实输入截断及 partial | 当前错误分项揭示超长行与悬空父节点；本任务保留既有 1 MiB 行上限，不扩大读取合同。无法从不完整顺序推断安全收尾，保留 unknown；如需提高上限，由规划者另立有界读取任务。 |

真实卡片、抽样列表和核验输出只保留在仓库外私有临时目录；仓库中没有真实会话内容或标注。使用公开 `eval/system` 干净 clone 重放本次 diff，以 GitHub noreply 身份提交，只推该分支，不推 main、不 force push。额外全历史审计仍仅有规划者已确认的 `fc53915` author / committer 两项既有发现；当前文件审计 PASS，不将全历史审计表述为 PASS。

请规划者核验任务 03；本报告不宣称 accepted。
