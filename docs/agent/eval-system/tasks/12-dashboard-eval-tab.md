# 任务 12 · trace 后台加「Eval」页（第一步：标注与复盘，不调模型）

阶段：Phase 4。模型调用：**无**。报告写到 `docs/agent/eval-system/reports/12-dashboard-eval-tab.md`。

## 背景与授权

bob 平时用 `rotom --trace` 打开本机后台看 trace。他希望在同一个后台里管理 eval：看到自己的会话，会话结束后去复盘、标注，有问题的加入失败集，形成循环。
bob 的决定（2026-10-25）：**先做第一步，放进产品后台**（`rotom/extensions/observability/dashboard.mjs`）。后续的 LLM judge（第二步）和失败集回归（第三步）**不在本任务**。

这是一次明确授权的**数据边界扩大**：后台此前只显示 trace metadata，Eval 页会在本机显示会话对话内容。CLAUDE.md 第 5 条的其它约束全部保持：只监听随机 loopback 端口、Bearer token、不开 CORS、不加载外部资源、不自动开浏览器。trace 文件本身的记录合同**不变**（trace 仍不记内容，内容只在后台请求时从会话文件现读）。

## 先读

- `rotom/extensions/observability/dashboard.mjs` 及 `dashboard.test.mjs`：现有路由、Host 检查、token、CSP（nonce）、并发上限、snapshot 分页。
- `rotom/evals/scripts/session-cards.mjs`、`review.mjs`、`trace-assertions.mjs`、`session-metrics.mjs`：卡片摘要、分支回溯、规则、指标。

## 代码放哪里

`rotom/evals/` 不随 npm 包发布，产品代码不能 import 它。把后台要用的**纯函数**（会话读取与当前分支回溯、摘要、规则、指标）放到产品目录（建议 `rotom/extensions/observability/eval/*.mjs`），再让 `rotom/evals/scripts/` 改为从那里 import，**不要维护两份实现**。如果搬迁牵动太大，至少保证同一个函数只有一份源码，并在报告里说明取舍。
新文件要登记进 `rotom/package.json` 的 `files` 和 `rotom/runtime/product-config.mjs` 的 `requiredFiles`（同任务 10），并跑 `rotom/runtime/distribution.test.mjs`。

## 功能

### 1. 会话列表（Eval 页）

后台顶部加一个「Eval」切换（原 trace 视图保持不变、默认仍是 trace 视图）。列表每行：开始时间、时长、状态、首条请求前 80 字、工具调用数 / 出错数、规则提示、成本、标注状态（未标 / 满意 / 不满意 / 失败集）。
可按「未标注」「不满意」「失败集」「规则命中」筛选。

状态三值，不要猜：
- `active`：会话或 trace 文件在最近 `ACTIVE_WINDOW_MS`（具名常量，默认 5 分钟）内有写入；
- `idle`：超过窗口没有写入（大概率结束，但 Pi 会话可以随时 resume）；
- `unknown`：拿不到时间。
`active` 的会话可以看，但标注按钮禁用并提示「会话进行中」。

### 2. 复盘视图

点开一个会话，显示：
- 摘要（同 `review` 的内容：请求、规则提示、最终回复）；
- **时间线**：按当前分支顺序列出 user 消息、assistant 文本、工具调用（工具名 + outcome，出错的标红），标出**第一次出错**的位置；工具参数与结果正文默认折叠，展开时最多显示 `MAX_PREVIEW_CHARS`（具名常量，例如 2,000 字）并标「已截断」；
- 规则检查结果、指标（复用任务 03 / 08 的函数）。
- 分页或懒加载：大会话不能一次把整个文件推给浏览器；单次响应体有上限。

### 3. 标注与失败集

- 「满意」「不满意」两个按钮，不满意时一个输入框写一句原因；一个「加入失败集」开关（只有不满意时可开）。
- 写入新的私有存储 `~/.rotom/evals/annotations/<sessionId>.json`：`{ schema: "rotom-eval-annotation/v1", sessionId, verdict, note, failSet, updatedAt, source: "dashboard" }`。目录 0700、文件 0600、原子写入、拒绝 symlink。
- **兼容现有工具**：
  - `labels` 同时读卡片标注块和 annotations；同一会话两边都有且不一致时，以 annotation 为准，并在输出里计 `conflicts`。输出新增 `failSet` 字段与计数。
  - `review` 跳过已有 annotation 的会话。
  - `agreement`、`stats`、`breakdown`、`weekly`（若以后实现）都通过 `labels` 的合并结果拿标注，不各自读。

### 4. API

- 现有 GET 路由不变。新增：`GET /api/eval/sessions`、`GET /api/eval/session?id=…&cursor=…`、`POST /api/eval/annotation`。
- POST 要求：Bearer token、Host 检查（沿用）、`Content-Type: application/json`、`Origin` 缺失或等于后台自身地址、请求体上限（例如 4 KiB）、字段校验（verdict 只能 pass/fail，note 截断到 500 字，failSet 只在 fail 时可为 true）。任何一项不满足返回 4xx，不写文件。
- 参数里的会话 id 只能映射到扫描根下已发现的会话，**不接受路径**。
- 不开 CORS；405 的 `allow` 头随路由更新。

### 5. 前端安全

- 会话内容里会有网页、HTML、脚本片段：**只用 `textContent` 渲染，不使用 `innerHTML`**；CSP 保持 nonce 方式，不放宽（`connect-src 'self'` 足够 POST）。
- 不引入任何外部库、字体、图片。

## 测试至少覆盖

- 纯函数：状态三值与窗口边界；时间线与第一次出错定位；截断；分页游标。
- API（`dashboard.test.mjs` 风格）：无 token / 错 Host / 错 Content-Type / 跨 Origin / 超大 body / 非法 verdict / 不存在的 id / 路径形式的 id 都被拒且不写文件；正常 POST 写入 0600 文件且原子；active 会话拒绝标注。
- 内容渲染：带 `<script>`、`<img onerror>` 的合成会话在页面里显示为文本（可用 Playwright 在合成数据上断言 DOM 中没有新增 script/img 元素）。
- `labels` 合并：只有卡片、只有 annotation、两边一致、两边冲突；`review` 跳过已有 annotation 的会话。

## 验证

- observability 测试（`dashboard.test.mjs`、`index.test.ts`）、coding-policy 不受影响的确认、`distribution.test.mjs`、eval 定向测试、typecheck、`git diff --check`、树审计。
- **UI 真实重放**（CLAUDE.md「UI 修复」要求）：用合成会话目录启动后台（`--root` 或等价参数指向仓库外临时目录），用已预装的 Playwright 走一遍：切到 Eval 页 → 筛选未标注 → 打开会话看时间线 → 标「不满意」并加入失败集 → 刷新后状态保留。报告附截图（合成数据，可以进仓库外的临时目录，**不要**把真实会话截图放进仓库或报告）。
- 真实数据：在本机真实会话上打开 Eval 页，只确认能加载、计数合理、无报错，报告只写聚合数字（会话数、各状态数），不写内容、不截图。**不要**替 bob 标注。
- 把 CI 的 `paths` 加上 `rotom/extensions/coding-policy/**`，并把 observability 的 `dashboard.test.mjs` 纳入 CI（若它在干净环境能跑；跑不了就在报告里说明原因，不要硬塞）。

## 不在本任务范围

LLM judge、失败集导出与回放、自动告警、修改 trace 记录合同、远程访问或多人共享、npm 发布、推 `main`。
