# 任务书：rotom 近 7 天本机会话复盘（交给本地 agent 执行）

- 发起：云端分析 agent（只能看仓库，看不到你本机的会话）
- 执行：维护者本机上的 agent
- 分支：`claude/optimistic-einstein-soq1sd`（只在这个分支上提交和推送，不碰 `main`）
- 窗口：最近 7 天（以执行当天为准）
- 产出目录：`experiments/session-review-20261107/results/`

## 0. 先读这一条：仓库是公开的

`bingjiang0611/rotom` 是公开仓库，推到这个分支的所有内容都是公开的。会话文件里有 prompt、代码、路径、
可能还有凭据，所以**原始会话内容一律不进仓库**。具体规则：

1. 不提交任何 `.jsonl` 会话、trace 文件或它们的片段；不贴 prompt、助手回复、thinking、工具参数、工具结果、
   错误正文的原文。
2. 不写真实路径、cwd、用户名、主机名、项目名/仓库名（rotom 自己除外）、URL、域名、邮箱、账号、token、文件名。
3. 案例描述用你自己的话**转述**，类别化即可（例：“在一个 TypeScript 前端项目里改组件样式”，而不是项目名和文件名）。
   需要指代某个会话时只用脚本输出里的 10 位 `label`。
4. `--cases` 生成的 label→真实路径映射只放在仓库外（例如 `$TMPDIR`），不提交。
5. 推送前必须跑隐私审计（第 4 步），把你的用户名、主要项目名作为 `--deny-term` 传进去。
6. 不修改、不移动、不删除任何会话、trace 或 `.pi/` 下的文件；本任务全程只读。存活会话的文件也不要碰锁。

拿不准某句话能不能写，就不写，或者写得更笼统。

## 1. 跑聚合统计脚本（只读）

```bash
cd <rotom 仓库根>
git fetch origin claude/optimistic-einstein-soq1sd
git checkout claude/optimistic-einstein-soq1sd
git pull origin claude/optimistic-einstein-soq1sd
mkdir -p experiments/session-review-20261107/results
node experiments/session-review-20261107/extract-session-metrics.mjs \
  --days 7 \
  --out experiments/session-review-20261107/results/metrics.json \
  --cases "$TMPDIR/rotom-session-review-cases.json"
```

- 默认读 `$PI_CODING_AGENT_DIR/sessions`，没设就读 `~/.pi/agent/sessions`（trace 在每个项目目录的
  `observability/` 子目录里，脚本会一起扫）。如果你的会话不在这里，用 `--root <sessions 目录>` 指过去，
  并在 findings 里说明“会话根目录不是默认位置”（不要写出具体路径）。
- 脚本只输出聚合 metadata：工具名、模型名、stopReason、customType、计数和分位数；错误正文和用户消息只在本地做
  正则归类/关键词计数，不输出文本；会话和 cwd 都用 sha256 前 10 位代替。
- 跑完后**人工过一遍 `metrics.json`**：如果 `tools` / `customTypes` / `models` 的键里出现了能暴露私人项目的名字
  （比如用户自己 MCP server 的工具名带了公司或项目名），把那个键改成 `user_tool_1` 这类占位名，并在 findings 里注明改过。
- 脚本 stderr 打印的扫描文件数抄进 findings 的“数据范围”。

## 2. 定性复查：读会话，写案例卡

`$TMPDIR/rotom-session-review-cases.json` 按 `frictionScore` 从高到低排好了（分数 = 工具错误、用户纠正关键词、
中断、模型请求错误、重复相同调用、连续工具错误的加权和；只是排序用，不是质量结论）。

请在本机读：

- 摩擦分最高的 **10–15 个**会话（子 agent 会话也算，但同一个父任务的多个子会话合并成一张卡）；
- 再随机抽 **5 个**摩擦分低但时长或 token 量大的会话，看“顺利但贵”的情况。

每个会话写一张卡，格式：

```markdown
### <label>（摩擦分 N，<主模型>，约 X 分钟，Y 次工具调用）
- 任务类型：一句话转述（不出现项目名/路径）
- 发生了什么：按时间顺序 3–6 条要点，写行为不写原文（例：“edit 连续 4 次因 oldText 不匹配失败，之后改用 write 整文件覆盖”）
- 用户介入：用户纠正/打断了几次、因为什么（转述）
- 根因猜测：落到 rotom 的哪个组件（见下方组件清单），以及是 模型行为 / 工具设计 / 提示词 / provider / 运行时 bug / 用户环境 哪一类
- 证据强度：直接看到 / 推断
- 可能的改进：一句话（可以写“不确定”）
```

组件清单（根因尽量落到其中之一）：Pi 核心循环与重试、内置文件工具（read/edit/write/bash）、SoL-Pi Action Fusion /
Observation Pack（`obs_recall`）/ Reducer、Compaction 与 Compaction Offload、Context Layers（`context_*`）、
Deferred tools / `search_tools`、Codemode、Ask、Goal（`/goal`、`goal_*`、completion reviewer）、Subagent、
Browser relay（`browser_*`）、Computer Use、Qoder provider、其他 provider、coding-policy 提示词、TUI/footer、
observability、launcher/安装。

## 3. 回答这些具体问题（写进 findings.md）

能用 `metrics.json` 回答的直接引用数字，需要读会话才知道的写“看了 N 个会话”。答不了就写“数据不足”，不要猜。

1. **钱和 token 花在哪**：按模型的 token/费用占比；缓存命中率（`cacheHitRatio`）有没有明显偏低的模型或会话；
   Qoder 会话的 credits 是否大量为 unknown（看 footer 显示 `Cr?` 的情况，或会话里的相关记录）。
2. **工具失败热点**：错误率最高的 5 个工具及其错误类别（`toolErrorCategories`）；edit 失败后模型通常怎么处理。
3. **原地打转**：`loops` 里重复相同调用和连续失败的会话，读两三个说明在重复什么（转述）。
4. **用户纠正**：纠正关键词命中的会话里，模型最常见的误解是什么（例如没按要求范围改、擅自扩大改动、汇报不实、
   停得太早/太晚）。注意关键词是粗筛，读的时候剔除误报并报告误报率的大概印象。
5. **Goal**：`goal.stopsFromActive` 的分布；有没有不该停的停（`empty_responses`、`review_exhausted`、
   `provider_retry_exhausted`）或者该停没停；completion reviewer 拒绝是否合理。
6. **Provider 稳定性**：`assistantErrorCategories` 与 trace 的 `providerErrorCategories` / `providerEndReasons`；
   重连（“Reconnecting... waiting for network”）出现得多不多，是否最终恢复。
7. **上下文管理**：compaction 次数与 `tokensBefore` 分布；Compaction Offload / `obs_recall` / `context_*` 工具
   实际被调用了多少次、是否帮上忙，压缩后模型有没有“忘事”重做。
8. **工具面**：`search_tools` 调用次数与使用它的会话数；Subagent 是否被用到、用得是否值得；有没有模型想用但不存在
   或不可见的工具（工具名报错）。
9. **Browser / Computer Use**（如果近一周用过）：stale/重新 observe、needs-approval/needs-confirmation 的频率，
   有没有卡住的流程。
10. **延迟**：trace 里 `providerRequestMs` / `timeToFirstContentMs` 与各工具 `toolDurationMs` 的 p50/p95，
    哪个工具明显慢。
11. **你（维护者）这一周自己的体感**：请直接问维护者本人 2–3 个问题——最烦的一件事、最常手动纠正的事、最希望 rotom
    自己做好的事——把回答转述进来，标注“维护者口述”。
12. 环境事实：近一周用的 rotom 版本（`trace.runtimeVersions`）、主要 provider/模型、trace 是否开启
    （`trace.files` 为 0 说明没开或被 `--no-session`/`ROTOM_OBSERVABILITY=0` 关了）。

## 4. 产出、审计与推送

产出两个文件，都放 `experiments/session-review-20261107/results/`：

- `metrics.json`：第 1 步脚本输出（如有占位改名，保持 JSON 合法）。
- `findings.md`：结构固定为
  1. 数据范围（扫描文件数、窗口内会话数、子 agent 会话数、是否非默认根目录、是否改过 metrics 键名）
  2. 第 3 节 1–12 问的回答
  3. 案例卡（第 2 步）
  4. 你认为最值得做的 **Top 5 改进**，每条：问题 / 证据（引用数字或案例 label）/ 涉及组件 / 粗略建议
  5. 本次没能看到或拿不准的东西

推送前：

```bash
git diff --check
python3 scripts/audit-public.py --root . --deny-term "<你的用户名>" --deny-term "<主要项目名1>" --deny-term "<主要项目名2>"
```

审计必须 `"status": "PASS"`；不 PASS 就改到 PASS 为止，不要绕过。另外自己再 `grep -nE "/Users/|/home/|@|https?://" results/*`
过一遍。然后：

```bash
git add experiments/session-review-20261107/results/
git commit -m "docs(session-review): local findings for the 7-day session review"
git push -u origin claude/optimistic-einstein-soq1sd
```

只提交 `results/` 下的这两个文件。不要改脚本或这份任务书；如果脚本有 bug 或统计口径不对，在 findings 第 5 节写清楚
现象（不带原文），或者另起一个 commit 只改脚本并在 commit message 说明原因。

推送完告诉维护者“已推送”，云端 agent 会拉下来核验：对照 `metrics.json` 检查 findings 里的数字、检查案例卡是否只有转述、
再给出改进方案；需要补查的问题会以新的任务书追加到这个目录（`TASK-2.md` 等）。
