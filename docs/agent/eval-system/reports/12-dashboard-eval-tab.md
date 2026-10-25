# 任务 12 报告 · 本机后台 Eval 页

按 [任务 12](../tasks/12-dashboard-eval-tab.md) 实现。当前源码后台已通过合成数据的 Playwright 完整复盘/标注流程；真实数据只读加载成功，未截图、未标注。没有改 trace 记录合同，没有引入模型调用、外部资源或 npm 依赖，没有安装或发布产品。

## 改动文件

| 文件 / 模块 | 改动与目的 |
|---|---|
| `rotom/extensions/observability/dashboard.mjs` | 接入 Eval 视图及三个鉴权 API；保持原 trace GET 路由、随机 loopback、Bearer、Host、nonce CSP、并发上限。新增 POST 的 Origin、JSON 类型、体积与读取截止检查 |
| `observability/eval/session-data.mjs` | 从 `session-cards.mjs` 移入有界读取、当前分支回溯、trace 关联、卡片格式化等共享 helper；目录索引与详情也共用 header 解析，避免对空行/旧记录的行为分叉；摘要由 `sessionSummary` 统一产生 |
| `observability/eval/trace-assertions.mjs`、`session-metrics.mjs` 及类型声明 | 原任务 03/08 的实现搬入产品；eval 原路径成为 re-export，没有两份实现 |
| `observability/eval/service.mjs` | 会话发现、active/idle/unknown、列表/时间线分页、首次错误定位、预览截断、受发现范围约束的 ID 映射，以及写标注前状态复核 |
| `observability/eval/annotations.mjs` | 私有 annotation 校验/原子写入、完整路径 symlink 拒绝；统一合并卡片/annotation，冲突以 annotation 为准；保留只有 labels.jsonl 的既有使用方式 |
| `observability/eval/ui.mjs`、`copy.mjs` | 沿用原后台视觉；顶部 Eval 切换、筛选列表、复盘、折叠参数/结果、人工标注；新增文案集中管理；会话内容仅 textContent |
| `observability/eval.test.mjs`、`eval-fixtures.mjs` | 9 个 Node 测试及共享合成数据；覆盖状态、分页、XSS 字符串传输、API 拒绝路径、权限/原子性、标签合并与 review 跳过 |
| `observability/eval-ui-smoke.mjs` | 可复跑的合成 Playwright 流程；截图仅存仓库外，结束后清理合成会话/标注、关闭浏览器和服务 |
| `rotom/evals/scripts/session-cards.mjs`、`.d.mts` | 导入共享实现；labels 新增 failSet 字段/计数与 conflicts；review 跳过 annotation；agreement、breakdown 通过统一合并读取标签 |
| `rotom/evals/test/session-cards.test.ts` | 更新新增汇总字段的精确断言；symlink labels 在读取阶段更早拒绝，保留目标未修改断言 |
| `rotom/package.json`、`rotom/runtime/product-config.mjs` | 7 个新运行时 `.mjs` 同步登记 files 与 requiredFiles；测试/截图/合成 fixture 不进入产品发行清单 |
| `.github/workflows/evals-l1.yml` | 两处 paths 增加 coding-policy；根目录执行 dashboard.test.mjs 与 eval.test.mjs，无需安装产品运行时 |
| `CLAUDE.md`、`docs/agent/change-checklists.md`、`verification.md`、`rotom/evals/README.md`、看板 | 记录授权后的本机内容边界、验证/标签合同；12 标为 in-review |

上表中的 `observability/` 均指 `rotom/extensions/observability/`。产品运行时没有 import `rotom/evals/`；只有不进入发行包的测试会导入 CLI 来验证兼容性。

## 安全与行为合同

- Eval 数据仅在带 token 且 Host 合法的 API 请求中读取；GET 页面本身不嵌入会话内容。CSP 不放宽，不开 CORS，无外部字体、脚本、图片。
- POST 仅接受 `/api/eval/annotation`；`allow` 随路由分别为 POST / GET。Origin 必须缺失或精确等于当前 Host 的 http origin；Content-Type 为 application/json；请求体最多 4096 bytes（包括 chunked），读取截止 5 秒。
- sessionId 必须是已发现会话的安全 ID，不接受路径；verdict 仅 pass/fail，note 为字符串并截至 500 Unicode 字符，failSet 为 boolean 且只能在 fail 时为 true。未知字段拒绝；服务端填写 schema、updatedAt、source。
- 会话或 trace 最近 5 分钟内写入即 active；窗口边界算 active。idle 仅表示暂未写入，不保证会话不会 resume；unknown 不猜。前端禁用 active/unknown 标注，后端写入前重新核验两个文件的时间。
- annotations 目录及其父存储目录 0700，文件 0600，独占临时文件写入后原子 rename。拒绝文件和祖先目录 symlink。私有读取固定 stat 时的字节边界，不因并发 append 扩大读取量。
- 参数、结果默认折叠，文本最多 2000 Unicode 字符并显示「已截断」。时间线展示当前分支的 user、assistant 与工具；工具 outcome 优先 trace，缺失时使用 toolResult。首次工具错误或 assistant error 有标记。
- 所有会话文本、错误文本、参数、笔记均以 textContent 渲染，不使用 innerHTML。保存网络失败/5xx 时显示结果未知并禁用重复提交，需刷新只读核对。
- 原始会话/trace 共用卡片读取器的原有上限：每文件 256 MiB、每行 64 MiB；目录扫描最多 50,000 条目，按 mtime 选最近 500 文件。列表每页扫描 10 个候选；筛选可跨页继续；时间线最多 20 事件，并按字节预算提前分页；单个 Eval JSON 响应不超过 256 KiB。超出读取上限或无有效 header 的文件不列入目录；已列出后超限/变化返回不可读或 409，不伪装完整快照。合并标签的卡片/导出文件上限为 16 MiB，单份 annotation 为 8 KiB。

## 验收命令与结果

环境：Node v24.18.0、npm 12.2.0、Vitest 4.1.9；Playwright 1.61.1 + 本机已安装 Chrome 的独立 headless profile，不复用用户 Chrome 登录态。

| 命令 | 结果 |
|---|---|
| `cd rotom/evals && npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 通过；仍有既有 8 项 npm 审计告警（3 moderate / 5 high），未改 lock 或依赖 |
| `node --test rotom/extensions/observability/dashboard.test.mjs rotom/extensions/observability/eval.test.mjs rotom/runtime/distribution.test.mjs` | 57/57：dashboard 21、Eval 9、distribution 27 |
| `node --experimental-strip-types --test rotom/extensions/observability/index.test.ts rotom/extensions/coding-policy/index.test.ts rotom/extensions/coding-policy/repair-hints.test.ts` | 维护环境 42/42；原 trace 内容隔离测试通过，coding-policy 源码未改。干净 clone 未装根依赖时，coding-policy 11 项通过，index 文件因缺少 typebox 无法加载；未将 index 硬塞入 CI |
| `node --test rotom/extensions/coding-policy/edit-error-code.test.mjs` | 4/4 |
| `cd rotom/evals && npm test -- session-cards trace-assertions agreement review session-metrics error-breakdown command-failures` | 7 文件 / 241 用例通过；重用产品模块后的旧 CLI 回归通过 |
| `cd rotom/evals && npm run typecheck` | 通过 |
| `cd rotom/evals && npm test` | 329 passed / 10 failed / 1 skipped；10 项仍为既有四文件失败：pi-harness 3、coding-hygiene-rule-ablation 3、product-runtime 2、tool-surface-ablation 2，均被已安装 pi-computer-use `.0` 与要求 `.2` 的 identity gate 阻断 |
| `node --test rotom/runtime/verify-pi-runtime.test.mjs` | 7 passed / 33 failed，和任务 10 的本机结果相同；未修改安装来绕过 identity gate |
| `node rotom/runtime/smoke-runtime.mjs <已安装 Pi 的绝对路径> <产品源码绝对路径>` | 在 verifyThirdPartyPackageContract 的同一 identity/version gate 处受阻，未进入运行时 smoke |
| `PLAYWRIGHT_MODULE=<预装 Playwright 的绝对 index.mjs 路径> node rotom/extensions/observability/eval-ui-smoke.mjs` | PASS；4 张合成截图，pageErrors=0、externalRequests=0 |
| Impeccable `detect --json rotom/extensions/observability/eval/ui.mjs` | 返回 `[]`；仅机械检查，不替代真实交互 |
| `git diff --check` | 通过 |
| `python3 scripts/audit-public.py --root .` | 暂存全部新增文件后通过：7,848 文件 / 0 findings；公开 clone 中再次验证 |

初版检查实际发现并修正：labels 新字段与旧精确断言不一致；Host 负例必须用原生 HTTP 发包（fetch 不保留伪造 Host）；390px 下头部/页脚溢出；独立目录索引的 header 行为与共享读取器不一致。没有跳过或弱化验收：旧 symlink 测试只调整了更早拒绝时的错误文案，仍验证目标字节未变。

## Playwright 合成 UI 重放与截图

复跑脚本使用注入 `<script>` / `<img onerror>` 的合成会话，未使用真实数据。步骤：原 trace 视图 → Eval → 未标注筛选 → 打开会话 → 查看时间线/首次错误 → 展开参数与结果（截断标识）→ 不满意 + 原因 + 失败集 → 保存 → 下一页事件 → 浏览器刷新 → 失败集筛选 → 回读标注仍在 → active 会话按钮禁用 → 390px 无横向溢出 → 返回原 trace。

额外断言：故意延迟旧会话请求并令其返回 500，确认不会覆盖后来选中的 active 会话；DOM script 数量不增加、img 为 0、注入变量不存在；所有网络请求仍为本地后台；磁盘 annotation 的 verdict/failSet/note 与 UI 一致。

以下都是**合成截图**，位于本机仓库外，没有提交 PNG：

- [复盘与保存](/tmp/rotom-task12-ui-SdXA2d/eval-review.png)
- [时间线、首次错误和截断](/tmp/rotom-task12-ui-SdXA2d/eval-timeline.png)
- [刷新后失败集状态](/tmp/rotom-task12-ui-SdXA2d/eval-failset.png)
- [窄屏 active 禁止标注](/tmp/rotom-task12-ui-SdXA2d/eval-active-mobile.png)

已回看截图核对布局与错误标记。初次预装 Playwright 没有匹配的 bundled Chromium，改用已安装 Chrome 的独立 profile；没有下载依赖或接触用户浏览器 profile。

## 真实数据只读冒烟

在本机真实会话根启动当前源码后台，用独立 Playwright profile 打开 Eval；主动阻断 annotation API 请求，不执行标注动作，不截图。最终一次运行只报告：

| 项目 | 聚合结果 |
|---|---|
| 发现会话 | 174 |
| active / idle / unknown | 5 / 169 / 0 |
| 首列表页加载 / 不可读 | 10 / 0 |
| 详情加载成功 | 1 |
| 页面错误 / annotation 请求 / 截图 | 0 / 0 / 0 |

扫描达到既有 500 文件窗口，不宣称读取了全部历史或全部会话详情；状态数是该次读取的 mtime 快照，会随时间变化。没有替 bob 标注；真实会话内容、笔记、ID 均未写入本报告。

## 与任务说明的取舍、未验证项和遗留问题

- 共用读取、回溯、摘要内容、规则、指标只有一份产品源码；review 原有的 `extractSummary` 继续解析已有卡片格式，它不是另一个会话读取器。为最小迁移，卡片 Markdown 格式化 helper 也随读取 helper 移入产品，但后台不生成或保存整份卡片。
- labels 的唯一合并入口是 `mergedLabels`；无卡片时兼容已有 labels.jsonl 导出，实时卡片存在时不让旧导出覆盖清空的标签。annotation 覆盖 verdict/note/failSet，保留卡片 categories/findings；annotation-only 的规则为 unknown，不捏造历史规则结果。agreement/breakdown 使用该入口；stats 本来不读取标注，因此没有另开标签读取路径。weekly 未实现。
- note 不一致或 failSet 不一致也记冲突；只在标注文件中保存个人笔记，不回写会话或 trace。schema 字段与文件身份均有校验。
- 文件/目录限额及分页是明确的有界方案；目录扫描达到上限会标 limited，超出读取上限的文件不能复盘；不调高完成标志。若后续要求超过这些边界，应另行设计流式索引/存储，而非一次向浏览器下发全文。
- idle 的判断不是进程锁；Pi 仍可 resume，后端只能在写入前按文件时间再次检查。多用户并发编辑/全局事务不在任务范围。
- 本次验证的是源码后台的真实浏览器交互和离线合成/真实读取，不是安装后的 `rotom --trace` 或最终 npm tgz。发行清单/资源合同测试通过；完整产品运行时验证仍受既有 installed identity 不匹配阻断。没有覆盖活跃安装、没有发布。
- UI 标注是人工操作；没有 LLM judge、失败集导出/回放或自动标注。CI 新增 dashboard/Eval API 测试，Playwright 仍为本机明确运行的验收，不把 CI 绿称作浏览器验证。

## 提交与 Actions

从公开 `origin/eval/system` 的独立 clone 重放 diff，以 GitHub noreply 身份提交；公开 clone 与维护目录暂存树一致。干净 clone 中 57 项后台/API/distribution 测试、241 项 eval 回归、typecheck、4 项 edit-error 测试及树审计再次通过。

公开历史审计仍为 **BLOCKED / 14 findings**：均为此前 7 个公开提交的 author/committer identity（`8c10047a7b1e`、`ec14cce51612`、`dd68b62d8a94`、`b358d3c15964`、`e6da2afa5739`、`ba9288fd2b2d`、`fc539150e67d`）；本次不重写历史、不新增该类问题。树审计为 7,848 文件 / 0 findings。

仅同步 `eval/system`，不推 main、不 force push、不发布。提交后由 [Evals L1](https://github.com/bingjiang0611/rotom/actions/workflows/evals-l1.yml) 验证；交付消息回报该提交的实际 Actions 结果及链接，不用本地测试替代远端状态。
