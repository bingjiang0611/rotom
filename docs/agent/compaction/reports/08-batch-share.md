# 任务 08 · 单批读取占比校准（零费用）

起始基线：`bd6cc20f502b08c29b0efab3939c7782582276b3`。

## 结论

核心验收通过：三个任务每轮 20 次 read 时，candidate 均有一次 defer，baseline 在相同 assistant 轮触发一次原生压缩，均发生在第一阶段结束前。无需触发任务规定的“仍无法 defer 就停止”分支。

本轮只修改 `rotom/evals/` 的 fixture 和相关测试，另新增本报告。没有真实模型调用；`LIVE_AUTHORIZATION` 始终为 `null`。未改 sol-pi、Pi fork、64K 阈值、5,120 keepRecentTokens、卸载判定、真实熔断上限或产品默认。prompt、工具面、评分和停止规则沿用 07；Action Fusion 仍只在 eval 两臂中关闭，未重新开放 then_run。

这证明的是本地 faux 下的机制与任务几何比例，不证明真实模型合规率、真实 defer 成功率或成本收益。后续真实运行仍需新授权，不能复用 06 的记录。

## A. Fixture 改动与尺寸证据

- `padded()` 改为约 3 KiB。预先计入关键正文及换行，只追加不会使总字节超过 3,072 的完整行；避免“先填满 padding，再插正文”使目标尺寸溢出。
- notes 从 60 增至 100。config-aggregate 仍有 20 个 modules；deferred-exact 仍有 20 个 logs；multi-file-fix 仍沿用 3 个 src、17 个 modules，再加失败日志。
- module 2/7/13/19 的 VALUE 规则未变；测试核对全部 20 个 module 值。EXACT_CODE 内容及插入中间行的规则未变，新增精确位置断言。
- `failureLog` 截断从 4,500 缩到 2,400 字符；连同原断言说明，`logs/test-output.txt` 为 2,558 字节。检查脚本只缩短这段诊断 fixture，判分逻辑未变，仍受保护。

以下分母是 manifest 条目，不含 manifest.json 本身。token 代理为每份 `ceil(chars/4)`，不是供应商精确 token。

| task | 条目数 | 单份最小字节 | 单份最大字节 | 单份最小 token 代理 | 最大 20 份代理合计 | 占 64K | 第一阶段材料代理合计 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| config-aggregate | 120 | 3017 | 3045 | 755 | 15222 | 23.78% | 91117 |
| deferred-exact | 120 | 2985 | 3045 | 747 | 15222 | 23.78% | 90963 |
| multi-file-fix | 121 | 2558 | 3060 | 640 | 15226 | 23.79% | 91736 |

最小文件仍比 1,536 字节卸载下限多 1,022 字节。三个任务材料均超过 83K，约为阈值的 1.42–1.43 倍；未依靠降低阈值获得覆盖。

批量断言先按代理大小降序选最大的 20 份，再验证合计 ≤ `0.25 × 64000 = 16000`，不只检查恰好出现的某一批。负对照临时恢复 8 KiB 目标后，该断言按预期失败：40,867 > 16,000；随后恢复 3 KiB，并通过完整回归。

实际产品 read 的既有测试覆盖全部 364 次 manifest/条目读取，逐次文本与 fixture 相等、无截断；目录、glob、超长文件与 offset/limit 回归也通过。

## B. Faux 轨迹与阈值决定

先只跑 20-read 核心与尺寸检查，4/4 通过，才继续完整回归。每轮 20 个 read 是同一 assistant 回复中的 20 个 toolCall，不是 20 次模型请求。

### 20-read：两臂同轮越过阈值

| task | baseline 触发轮 | candidate 触发轮 | baseline 原生次数 | candidate defer / 原生次数 | 第一阶段覆盖（两臂） |
| --- | --- | --- | ---: | --- | --- |
| config-aggregate | [5] | [5] | 1 | 1 / 0 | 120/120 |
| deferred-exact | [5] | [5] | 1 | 1 / 0 | 120/120 |
| multi-file-fix | [5] | [5] | 1 | 1 / 0 | 121/121 |

partialReads 均为 0，任务判分均正确；candidate 各 offload 61 个结果并成功召回其中一个。候选数包含早先读取的 manifest 结果，不等同于材料条目数。

### 每一次 candidate 阈值决定

每个 task/轨迹只有下表这一条决定，全部为 `defer`。before/after 是既有卸载日志中的估算值，after 显示到三位小数；不是实测计费 token。T 固定 64,000，目标固定 `0.6T = 38,400`。

| read/轮 | task | before | after | T | 候选数 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 20 | config-aggregate | 66058 | 25286.630 | 64000 | 61 |
| 20 | deferred-exact | 65842 | 25211.069 | 64000 | 61 |
| 20 | multi-file-fix | 66045 | 25294.772 | 64000 | 61 |
| 10 | config-aggregate | 66111 | 18582.997 | 64000 | 71 |
| 10 | deferred-exact | 65894 | 18506.703 | 64000 | 71 |
| 10 | multi-file-fix | 66097 | 18591.359 | 64000 | 71 |
| 1 | config-aggregate | 64021 | 15609.426 | 64000 | 72 |
| 1 | deferred-exact | 64580 | 15657.262 | 64000 | 73 |
| 1 | multi-file-fix | 64008 | 15618.068 | 64000 | 72 |

baseline 没有启用卸载，offloadDecisions 为空，不能给它补造 before/after 或候选数。其阈值事件与原生压缩次数由独立 metrics 记录。

10-read 三个任务的首次触发轮均为 9；逐份 read 为 78、79、78。两臂各自同轮触发，baseline 各一次原生压缩，candidate 各一次 defer，均早于 READY。原先“在材料读到一半之前触发”的测试假定不适用于更小文件，改为直接核对第一阶段边界；没有放宽“必须在第一阶段触发”或 candidate 必须 defer 的条件。

与 07 相比，留存的最后一批由约 41K 降到约 15.2K 代理 token，使原判定逻辑在 20-read 下即可达到目标。没有更改切分点、保留区或目标比例来配合测试。

### 只读 5 份的偷懒轨迹

| task | 第一阶段覆盖 | partialReads | contextPeak（全运行） | 请求数 | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| config-aggregate | 5/120 | 0 | 9096 | 6 | threshold-not-reached |
| deferred-exact | 5/120 | 0 | 8971 | 5 | threshold-not-reached |
| multi-file-fix | 5/121 | 0 | 11535 | 8 | threshold-not-reached |

三者 thresholdCompactions=0。即使任务判分正确，整 case 结束后的既有熔断仍标为 failed，下一运行 not-run，runtime factory 和请求数不再增加；未新增或移动停止检查点。

## C. N=3 规划与停止线

### 计算口径

从最终 fixture 的每任务、每臂一次 faux 结果，按现有执行顺序外推 N=3、18 次运行。请求数包含原生摘要；合计输入为 input + cacheRead + cacheWrite。faux 缓存两项为 0，数字是本地代理，不是付费测量。另一次完整 N=3 faux case 的 18/18 验收通过，但它没有复用已消费的真实授权或给未来运行提供授权。

沿用 07 的每份 8 KiB 对应 2,500–3,000 token 假设，按目标尺寸比例 `3072/8192 = 0.375` 折算为每份约 937.5–1,125 token。实际 fixture 的平均 chars/4 代理为 758.493，因此对合计输入乘以 **1.236003–1.483204**。该方法把系统/摘要等开销也整体放大，是规划假设，不是 tokenizer 标定。

| read/轮 | N3 请求外推 | N3 合计输入代理 | N3 output 代理 | 缩放后输入范围 | 另加 25% 后输入上端 | 每 run 请求加 25% 向上取整后的总数 |
| ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 2271 | 73882644 | 34827 | 91.32M–109.58M | 136.98M | 2847 |
| 10 | 327 | 10913517 | 34035 | 13.49M–16.19M | 20.23M | 417 |
| 20 | 219 | 8056770 | 34035 | 9.96M–11.95M | 14.94M | 279 |

若只对整个 N3 请求总数加 25% 再取整，分别为 2,839 / 409 / 274；表中逐 run 取整略保守，避免小数请求。25% 是人为余量，不是统计置信区间。

### 逐份 read 会停在哪次

参考原来的 **2,000 请求 / 100M 合计输入**，逐份 read 无法按当前脚本完成全部 18 次：

- 每次 baseline/candidate 请求数：config-aggregate 为 126/125，deferred-exact 为 125/124，multi-file-fix 为 129/128。
- 按任务分组、重复轮交替两臂顺序：前 12 次结束累计 1,500 请求；第 13、14、15 次结束分别为 1,629、1,757、1,885。
- **第 16 次：multi-file-fix、baseline、repetition=2**，还需要 129 请求，而停止线只余 115。按此轨迹，该 run 的第 116 个请求不能准入；第 17、18 次不会执行。
- 即使按输入缩放上端，第 16 次假设完整结束的累计也约 97.07M，因此此情形请求线先到。若忽略请求线，仅输入上端会在第 17 次越过 100M。
- 若把 25% 余量均匀分配到每个 run，请求线更早落在 **第 13 次：multi-file-fix、baseline、repetition=1**；此时输入上端加余量在第 13 次假设完整结束约 97.51M，单独输入线在第 14 次越过。

以上运行编号是按实测 faux 请求计数和明确的缩放假设推算，不是实际执行了一个 2,000 请求的共享熔断 campaign，也不是预测真实模型一定停在这些位置。真实行为不同则位置不同；尤其不能把 25% 情景当作新的固定脚本。

### 建议（未执行、未授权）

如果下一次授权要覆盖逐份 read 的最坏已测轨迹，建议停止线为 **3,000 次请求 / 140,000,000 合计输入**：覆盖逐 run 加余量后的 2,847 次与约 136.98M，并分别向上取整到千次/千万 token。原 2,000 / 100M 对 10、20-read 场景足够，但不足以覆盖逐份 read 的完整 N3。

本轮没有更改真实停止线，也没有填写授权常量。新增材料使逐份 read 轮次数上升，不能因单份更小就声称费用下降。实际摘要长度、工具选择、重复读取、缓存命中及 tokenizer 均未知；已准入请求的事后 usage 仍可能越过输入线，output 没有独立熔断，美元费用 unknown。任何采用建议停止线的真实运行都需要规划者新建记录并由 bob 明确确认。

## 验证与自审

环境：Node v24.18.0、产品 Pi 1.4.0-rotom.2、Vitest 4.1.9。本轮没有安装/升级依赖或修改 lockfile。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 先行 20-read 与尺寸检查 | 4/4 | core20.log |
| 完整 compaction-offload-eval 专项 | 21/21 | focused.log |
| LIVE=0 的 live/entry/metadata/read 专项 | 27/27 | live-entry-final.log |
| 显式 faux provider，N=3 case | 18/18 | faux-n3.json |
| 指定产品 ROTOM_PI / ROTOM_TEST_PI 的 npm test | 146 passed / 1 既有 skip | full-test.log |
| npm run typecheck | PASS | typecheck.log |
| 8 KiB 静态负对照 | 按预期失败，已恢复 | batch-share-negative.log |
| git diff --check（含 origin/main...HEAD）及 staged 文件大小 | PASS | 本地检查 |
| tracked-tree 公开扫描 | PASS，7,829 项，0 finding | tree-audit.log |
| 公开历史基线扫描 | BLOCKED：12 项已接受的既有身份问题 | history-before.log；不将此记为全绿 |

验收命令按任务 08 执行；faux 命令额外显式设 LIVE=0，N=3。唯一 skip 是未设置 `ROTOM_TEST_SIDECAR` 的既有条件测试，不涉及本改动。

测试中两个小额度的 synthetic budget fixture 随新轨迹调整：首个完整批量 case 从 16 请求变为 18，为继续覆盖“下一 run 中途失败、再下一个 not-run”，测试额度从 18 改为 20；原生摘要拦截改用 20-read 的第 5 次边界。原来的 18 恰好耗尽测试额度时，下一 run 正确返回 not-run，而不是 failed；没有把这个正常行为当作实现 bug。实际 budget/stop 实现及授权常量没有修改。窗口回归的预期摘要调用数从 2 改为本次实测的 1，仍核对全部摘要请求、usage 和 SSE/maxRetries=0。

提交前核对最终 diff、staged 文件大小和公开扫描；只交付三个 eval 文件及本报告，不提交 JSONL 或原始工具内容。本机证据与规划脚本位于 `/tmp/rotom-offload-08.pNEoFM/`。真实模型结果仍未验证，下一步仅交规划者评审，不自动继续付费回放。
