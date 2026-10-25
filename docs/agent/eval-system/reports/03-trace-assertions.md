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

## 核验意见（规划者，2026-10-25）

结论：**changes-requested**。规则框架、unknown 语义、证据只含元数据、标注保留这几块都核对过源码，规划者重跑 61/61 通过，typecheck 退出 0。新的拆分计数很有价值，正好暴露了两个读取问题；另外有一条规则因为不符合 trace 合同而永远是 unknown。前两个问题出在规划者任务 01 定下的读取合同，不是执行者的错。

### 问题

1. **1 MiB 单行上限在截断真实会话**。`lineTooLong=27`、`danglingParent=6` 很可能是同一个原因：Browser 和 Computer Use 的截图以 base64 存在 toolResult 里，一行轻松超过 1 MiB。这一行被丢掉以后，它后面的 entry 找不到父节点，分支回溯就在这里断了，卡片会丢掉断点之前的全部历史，相关规则也只能退化成 unknown。
2. **header 判定和 Pi 不一致**。Pi 的 `loadEntriesFromFile` / `parseSessionHeaderCandidate`（`session-manager.ts` 第 640–690 行附近）会跳过空行和无法解析的行，**第一个解析成功的记录**才算 header。当前实现把首行的状态固定下来了。27 个 `other` 里有多少其实是 Pi 能加载的会话，现在还说不清。
3. **`harness-fault` 23/23 unknown**。按 `observability/index.ts` 的 `classifyFaultSide`，outcome 为 `ok` 或 `aborted` 的 span **按合同就不写** `fault_side`。所以属性缺失不等于数据缺失。

### 必须修改

1. `MAX_LINE` 提到 64 MiB，单文件 256 MiB 上限不变。图片仍然只显示 `(image)`，不进卡片。补一个大于 1 MiB 的 toolResult 行（合成的 base64）测试，断言分支完整、没有 dangling。
2. header 判定改成和 Pi 一致：跳过空行和无法解析的行，第一个解析成功的记录如果是 `type:"session"` 且 `id` 是字符串，就是 header；否则跳过这个文件。`invalidHeaderKinds` 增加 `missing-type` 和 `line-too-long`（第一个非空行超过上限时）。另外加一个 `invalidHeaderKeySets` 计数表：key 是第一个解析成功记录的顶层字段名排序后用 `,` 连接；字段名不全满足 `^[A-Za-z_]{1,32}$` 时记 `other`。只记字段名，不记值。
3. `harness-fault`：已结束、outcome 为 `ok` 或 `aborted` 的 span 算作「没有 harness 故障」的有效证据；只有 outcome 是错误、但缺 `fault_side` 的 span，或者存在未结束 span、trace 为 partial / missing 时，才返回 unknown。把 `classifyFaultSide` 的这条合同写进代码注释。其它规则如果也有类似「按合同不写」的属性，同样处理，并在报告里列出来。
4. 每项都配合成单测。
5. 重做 `--limit 50` 冒烟，报告写出全部计数，包括 `invalidHeaderKeySets`，以及修改前后各规则 unknown 数量的对比。

验收命令和提交方式同前。完成后把 03 改回 `in-review`，追加「修订记录」。

## 修订记录（执行者，2026-10-25）

完成本轮 5 项必须修改，状态恢复为 `in-review`。定向测试 73/73 通过，类型检查通过；全量测试仍仅有原有 10 项依赖失败。以下记录覆盖修订版，不覆盖前文的历史结果。

### 逐项修改及范围

| 核验项 | 修改及证据 |
|---|---|
| 1. 单行上限及图片 | MAX_LINE 改为 64 MiB，MAX_FILE 仍为 256 MiB；保持分块读取和文件大小快照边界。新增大于 1 MiB 的合成 base64 toolResult 用例，断言早期请求、工具结果和最后回复都在分支中，lineTooLong/danglingParent 均为 0，图片只显示 `(image)`。旧的超长行测试提高到 64 MiB + 1 字节，未删除上限检查。 |
| 2. header 及字段名诊断 | 按 Pi 的 loadEntriesFromFile / parseSessionHeaderCandidate 跳过空行、无法解析的行及其跳过的 falsy 解析值；首个候选记录若不是 session/string-id，就拒绝文件，不继续寻找更晚 header。新增 missing-type、line-too-long；首个非空行超限时保守拒绝。新增 invalidHeaderKeySets，字段名排序后逗号连接，任何字段名不满足规定正则则整个集合归 other；没有可用对象字段时同样归 other。只输出字段名，不输出值。 |
| 3. fault_side 合同 | 在规则代码中注明 classifyFaultSide 合同：已结束且 outcome 为 ok/aborted 时，缺失 fault_side 是有效的“无 harness 故障”证据。错误/unknown_outcome/incomplete 缺失 fault_side、未结束 span、partial/missing trace 仍不能据此给 clear；已有明确 harness 命中仍保留 hit。 |
| 4. 合成测试 | 覆盖长图片、64 MiB 边界、坏 JSON/空白/null/false 前缀、首个非 session 候选不得被后续 header 替代、字段名排序与隐私、safe string ID 和路径字符拒绝、ok/aborted 的省略合同，以及错误/partial/missing 不得误判 clear。共 73 项定向测试，无真实会话 fixture。 |
| 5. 同样本冒烟 | 修改前先把按 mtime 选出的 50 个真实输入及对应 trace 冻结到仓库外私有目录，保留相对路径和 mtime；旧版与新版均对该副本执行 build --limit 50。前后比较不混用不同时间采样；全部计数见下表。 |

改动文件：`rotom/evals/scripts/session-cards.mjs`、其 `.d.mts`、`rotom/evals/scripts/trace-assertions.mjs`、两份对应测试、`rotom/evals/README.md`、协作 README 状态及本报告追加内容。未修改 observability、其它规则的命中条件、CI、依赖或锁文件。

### 其它属性的省略合同核对

已核对 `observability/index.ts` 的 classifyFaultSide、toolResultMetrics 和工具结束写入路径：

- unknown_outcome 也可能按合同不写 fault_side，但这表示故障侧尚未确定，不是“可证明无 harness 故障”；保持 unknown，不能照搬 ok/aborted 的处理。
- 正常工具结束的 toolResultMetrics 始终写 result_text_bytes，空文本/纯图片也写 0。缺失该属性不等价于 0，oversized-tool-result 保持 unknown；新增用例明确验证这一点。
- 正常工具结束写入 outcome；未结束工具没有可用终态属性。schema-errors 和 ended-after-tool-error 不把缺失 outcome 推断为非错误。
- 因此其它规则没有需要新增的“按合同省略即为 clear”分支，没有为了降低 unknown 改动它们的条件。

### 验收命令及结果

环境：macOS，Node `v24.18.0`，npm `12.2.0`，Vitest `4.1.9`。

| 命令 | 结果 |
|---|---|
| `cd rotom/evals` | 成功；以下 npm 命令在该目录执行。 |
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，安装 180 个包；仍提示既有 8 项漏洞（3 moderate、5 high），未做额外升级。 |
| `npm test -- test/trace-assertions.test.ts test/session-cards.test.ts` | 退出 0；2 个文件，73/73 通过。 |
| `npm test` | 退出 1；16 个文件中 12 通过、4 失败；172 项中 161 通过、10 失败、1 跳过。失败仍为同一批 Computer Use identity/version 不匹配，无新增失败。 |
| `npm run typecheck` | 退出 0；独立运行，不被前一失败短路。 |
| `cd ../..` | 返回仓库根，后续 Git / audit 命令在根目录执行。 |
| `git diff --check origin/main...HEAD` | 退出 0，提交后复查；另检查工作区和暂存区 whitespace。 |
| `python3 scripts/audit-public.py --root .` | PASS，0 finding；本次改动全部暂存后复查。 |

另对两个实现 `.mjs` 运行 `node --check`，通过。原测试中“坏首行之后不得使用 header”的断言按本轮明确的新合同调整为成功加载；仍保留“首个已解析非 header 候选”和“首个非空行超过 64 MiB”不得被后续 header 替代的断言。

### 同样本真实冒烟（仅计数）

前后命令均为 `node rotom/evals/scripts/session-cards.mjs build --root <仓库外冻结输入目录> --limit 50 --out <仓库外私有输出目录>`；修改前基线为 `9e8dbbfa` 的实现。

| 字段 | 修改前 | 修改后 |
|---|---:|---:|
| 输入文件 | 50 | 50 |
| 对应 trace 文件 | 22 | 22 |
| generated | 22 | 22 |
| skipped | 28 | 28 |
| skippedOversized | 0 | 0 |
| skippedInvalidHeader | 28 | 28 |
| skippedEmpty | 0 | 0 |
| skippedDuplicate | 0 | 0 |
| traceMissing | 0 | 0 |
| tracePartial | 2 | 2 |
| parseErrors | 33 | 0 |
| sessionParseErrors | 33 | 0 |
| traceParseErrors | 0 | 0 |
| badJson | 0 | 0 |
| lineTooLong | 27 | 0 |
| entryMissingId | 0 | 0 |
| danglingParent | 6 | 0 |
| cycle | 0 | 0 |
| messageMissing | 0 | 0 |
| unknownEntries | 0 | 0 |
| invalidHeaderKinds | `{"other":28}` | `{"missing-type":28}` |
| sessionVersions | `{"1":0,"2":0,"3":22,"missing":0}` | `{"1":0,"2":0,"3":22,"missing":0}` |

`invalidHeaderKeySets`（修改前没有此计数表）：

| 字段名集合 | 修改后计数 |
|---|---:|
| `agent,childIndex,cwd,message,recordType,role,runId,source,sourceEventType,text,timestamp,ts,version` | 10 |
| `event,id,originalBytes,originalLines,originalTokens,placeholderBytes,placeholderTokens,removedTokens,request,sendNumber,timestamp,tool` | 1 |
| `contentHash,event,id,originalBytes,originalLines,originalTokens,request,timestamp,tool` | 17 |

| rule | 修改后 hit | 修改后 clear | 修改前 unknown | 修改后 unknown |
|---|---:|---:|---:|---:|
| repeat-after-error | 1 | 21 | 6 | 0 |
| ended-after-tool-error | 0 | 16 | 8 | 6 |
| ended-on-provider-error | 2 | 20 | 6 | 0 |
| schema-errors | 0 | 18 | 7 | 4 |
| oversized-tool-result | 8 | 12 | 5 | 2 |
| harness-fault | 0 | 17 | 22 | 5 |

修改后含 hit 的卡片 **9** 张；随机抽查 **3** 张，**3 张里 3 张命中合理**。抽查仍只表示规则条件成立，不自动推断人工 verdict。

### 边界、偏差及交接

- Pi 的 header 候选定位已对齐；作为本地文件输出的额外安全边界，string ID 仍拒绝 `/`、`\\`、`..` 和控制字符。原来过窄的字母数字正则已移除，含空格/普通点号的安全 ID 可以生成卡片并导出标签。
- 冻结输入逐文件复制，不宣称原活跃会话和 trace 的跨文件原子快照；前后两次确实读取同一份固定副本。源 session/trace 未回写；冻结副本、卡片和抽样列表全部位于仓库外私有目录，不进入提交。
- 保留 256 MiB 文件上限及新的 64 MiB 行上限。若后续真实数据仍超限，由规划者另定读取合同和验证，不在本轮继续扩大。
- 真实前后生成数量相同；前缀行兼容及 unsafe ID 拒绝由合成用例证明，不宣称这些路径在本次真实样本中都有命中。
- 全量测试的 10 项既有失败和 npm 漏洞提示保持原记录，不在本轮修复；人工 verdict 与规则一致程度仍等 bob 完成标注后再评估。

使用公开 `eval/system` 干净 clone 重放本次 diff，以 GitHub noreply 身份提交，只推该分支，不推 main、不 force push。额外全历史审计仍仅有已确认的 `fc53915` author / committer 两项既有发现，不新增问题，也不宣称全历史 PASS。请规划者核验本轮 5 项修改；不宣称 accepted。

## 第二轮核验结论（规划者，2026-10-25）

结论：**accepted**。规划者重跑 73/73 通过，typecheck 退出 0；`harness-fault` 的合同分支已核对源码和注释。同一份冻结样本前后对比的做法很好。

- 解析错误从 33 降到 0，lineTooLong 和 danglingParent 都归零，说明截图长行就是断链的原因，修复有效。
- 28 个无效 header 文件现在都能看出来源：10 个是子代理事件日志（`agent,childIndex,…,runId`），18 个是工具输出压缩的记录（`contentHash,event,…,originalTokens`）。它们首条记录都没有 `type` 字段，Pi 也不会当会话加载，跳过是对的。
- 各规则 unknown 明显下降，剩下的来自 2 份 partial trace，以及错误 outcome 本身没写故障方，这些都是合理的 unknown。
