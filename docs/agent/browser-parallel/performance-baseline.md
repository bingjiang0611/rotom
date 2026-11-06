# Browser relay 性能基线

这份文件记录 `rotom` Browser relay 的当前性能基线、复测方法与回归判据。它是**维护者对照表**，不是对外性能承诺：数字来自单台 macOS、headless Chrome 与本地 fixture，不能当作任意机器、任意站点或端到端任务耗时的保证。

## 这份基线是什么

- **单次调用的成本**：一次 relay 请求（观察、截图、交互、导出、录屏）在本地 fixture 上花多少时间。
- **固定开销的分解**：哪些时间是真实工作，哪些是等待窗口、持久化或轮询。
- **回归的参照点**：改动 Browser 观察/交互/持久化路径后，同机复测能立刻看出有没有退化。

## 不是什么

- 不是端到端任务延迟，不含模型推理、Prompt 组装与工具编排。
- 不是真实站点的成本。fixture 页面没有广告、第三方脚本、网络抖动与重定向链。
- 不是跨平台结论。Linux 与 Windows 只有代码级与单元测试分支（L1），没有真实 Chrome 实测。
- 不是容量承诺。并发只测到 4 个标签，RSS 只是当时进程快照。

## 环境与复测

基线环境：macOS arm64（Apple M2 Pro，10 核，16 GB），Node v24.18.0，Chrome for Testing 157.0.8103.38，headless，本地 fixture，`rotom/runtime/e2e-browser/bench.mjs`。

```bash
# 完整基线（约 4 分钟：read_full 与录屏是主要耗时）
ROTOM_BENCH_ROUNDS=30 ROTOM_BENCH_WARMUP=3 ROTOM_BENCH_CONCURRENCY_ROUNDS=10 \
  ROTOM_BENCH_JSON=/tmp/bench.json \
  node --experimental-strip-types rotom/runtime/e2e-browser/bench.mjs

# 跳过录屏（headless 下 Chrome 不给不可见页面发帧，行会记为未测量）
ROTOM_BENCH_SKIP_RECORD=1 node --experimental-strip-types rotom/runtime/e2e-browser/bench.mjs
```

`bench.mjs` 与 e2e 共用同一套隔离 harness 与 fixture，不接触真实 Chrome profile；它只报数字，不做断言，正确性由 e2e suite 负责。P95 用 nearest-rank，`n ≤ 30` 时只能当量级参考。

## 当前基线

`ROTOM_BENCH_ROUNDS=30`、`WARMUP=3`、`CONCURRENCY_ROUNDS=10`，commit `38f625fc` 之后的实测值。

| 场景 | n | P50 | P95 | max | ops/s | 备注 |
|---|---|---|---|---|---|---|
| Chrome 启动 + relay 握手 | 1 | 1 629 ms | — | — | — | 每个浏览器实例一次 |
| client 连接（握手 + 会话注册） | 10 | 0.7 ms | 1.2 ms | 1.2 ms | 1 250 | 每个新 agent 一次 |
| `snapshot_visible`（渲染 DOM） | 30 | 60 ms | 67 ms | 70 ms | 16.6 | 单次观察的固有成本 |
| `tabs`（归属与状态） | 30 | 0.5 ms | 0.6 ms | 0.6 ms | 2 177 | 几乎每个动作前都查一次 |
| `read_full`（`/large` 整页文本） | 10 | 2 959 ms | 3 905 ms | 3 905 ms | 0.32 | 60 步，与页面高度成正比 |
| `screenshot`（JPEG 视口） | 30 | 45 ms | 65 ms | 77 ms | 22.6 | |
| `interact` type + 读回 | 30 | 2.4 ms | 3.6 ms | 4.0 ms | 386 | 不带 `expect`；带 `expect` 走满 150 ms 窗口 |
| `interact` scroll | 20 | 54 ms | 67 ms | 72 ms | 18.2 | |
| 并发 `snapshot` ×1 / ×2 / ×4（每轮总耗时） | 10 | 56 / 57 / 61 ms | 64 / 59 / 67 ms | 同上 | 17.2 / 17.5 / 15.9 | ×4 时每标签约 15 ms |
| `devtools screenshot_export`（整页 PNG，`/baseline`） | 5 | 67 ms | 70 ms | 70 ms | 14.8 | 只比视口截图贵一半 |
| `devtools screenshot_export`（整页，`/large`） | — | **被拒** | — | — | — | 8 MiB 上限，非降级 |
| `devtools network_body` | 5 | 4 ms | 6 ms | 6 ms | 228 | 读本地缓冲，不发新请求 |
| `devtools trace_start/stop`（0.5 s 采集） | 3 | 16 ms | — | — | — | relay 16 ms + 解码 0.06 + 摘要 0.66 |
| `record_start/stop`（3 s @2fps）+ GIF 合成 | 2 | 3 020 ms | 3 037 ms | 3 037 ms | — | 含固定 3 000 ms 录制等待 |

首次 `open` 均值约 155 ms。内存：client RSS 约 72 MB，Chrome RSS 约 240 MB（3 个标签）。

## 优化前对照

同一台机器、同一 harness，四次改动的收益（细节见 `STATUS.md` 的对应小节）：

| 场景 | 优化前 | 现在 | 根因 |
|---|---|---|---|
| `tabs` | 103 ms | 0.4 ms | 只读操作每次都空等 100 ms 持久化合并窗口 |
| client 连接 | 208 ms | 0.7 ms | 同上 |
| `interact` type + 读回 | 159 ms | 2.4 ms | 派发后固定睡 150 ms 再读目标状态 |
| `interact` scroll | ~105 ms | 50 ms | 固定睡 100 ms 再读 `scrollTop` |
| `read_full` | 10 594 ms | 2 959 ms | 每滚动一步固定睡 150 ms（87% 的时间），之后改为按容器自适应 |
| 首次 `open` | 351 ms | 155 ms | 连接 + 持久化空等 |
| Chrome 启动 + 握手 | 2 746 ms | 1 857 ms | 启动期多次持久化空等 |

读路径（`snapshot_visible` 58 ms、截图 45 ms、并发）优化前后一致：它们本来就不走持久化，成本是单次 CDP 观察。

## 正确性联合检查（`settle` suite）

延迟优化只删等待、不改产出，这条规则靠一组 fixture 固定住，光看毫秒数看不出退化：

| fixture | 检查 | 它防的是什么 |
|---|---|---|
| `/read-medium` | 能读完的页面 `contentComplete=true`、26 段顺序完整、尾部存在、滚动位置恢复到读之前 | "稳定就返回"把没渲染完的内容当成已读完 |
| `/virtual-late` | 滚动后 60 ms 才渲染行的列表，200 行一行不少 | 稳定窗口短于渲染延迟时静默丢行 |
| `/revert-input` | 输入 80 ms 后被页面清空，`expect: value=nonempty` 必须报 `unmet` | 用"首次变化"代替"最终状态"，把会被回滚的写入报成生效 |

这三个检查第一次跑时**全部失败**，对应三处修正：

1. `expect` 是"最终状态"的断言，重新走满 150 ms 窗口；不带 `expect` 的动作仍走快速路径。
2. `read_full` 按容器学习"是否延迟渲染"：第一层扫描的结论复用到后续步骤，静态文档不再每步付渲染窗口，延迟渲染的容器则等它画完。
3. 已知延迟渲染的容器若整窗没有变化，该步标记为未确认（`contentComplete=false`），而不是声称已覆盖；末尾一步豁免，因为那里本来就没有新内容可画。

**仍然存在的边界**：延迟超过 150 ms 的渲染会被首轮判定为静态容器。这与优化前的固定 150 ms 等待是同一个假设，没有变差；要覆盖它需要页面侧的渲染完成信号，超出 relay 能观察到的范围。

## 回归判据

在同一台机器上复测，用下列判据判断是否需要处理：

1. **P50 超过基线 1.5 倍**：视为回归，必须查清原因或在提交里说明为什么可接受。
2. **新增固定等待 ≥ 20 ms/次**：任何"先睡一段时间再读"的写法都要有证据说明这段等待在等什么；能轮询到条件满足的不要固定睡。
3. **量级变化**（10 倍以上）：无论快慢都要解释，可能是改动改变了工作内容而不是效率。
4. **`contentCoverage`、`nodes` 数、`steps` 数变化**：`read_full` 这类遍历路径的耗时变化必须与产出对照，只快而少读了内容属于错误。
5. **跨机器**：只比量级（同一数量级即正常），不要用另一台机器的绝对毫秒数当基线。

## 已知限制与未覆盖

- **headless only**：录屏路径在 headless 下拿不到帧，`record` 行在有头模式才有意义；上表数字来自 headless。
- **单机**：计划在低负载的第二台机器复测，但该机的企业安全软件直接 `SIGKILL` Chrome for Testing（`--version` 即 exit 137，去掉 quarantine 后仍如此），系统 Chrome 正式版又忽略 `--load-extension`。因此只有本机数字。
- **Linux / Windows**：无真实 Chrome 实测，只有代码级与单元测试分支（L1）。
- **未覆盖路径**：真实站点（重定向、跨域 iframe、重内容页面）、多标签 8 个以上、长会话（内存随时间增长）、`trace` 的大事件流、下载与上传的实际字节路径。
- **等长文本替换**：目标状态探针只回传 `valueLength` 而不回传值，等长替换观察不到变化，会走满 150 ms settle 上限。
- **整页导出上限**：超长页面的整页导出会被 8 MiB 上限拒绝而不是降级，用户会看到失败。

## 变更记录

| 日期 | commit | 内容 |
|---|---|---|
| 2026-11 | `f89bfeed` | 新增 `bench.mjs`，覆盖连接、观察、写路径、截图、并发与录屏 |
| 2026-11 | `66ed5963` | 补测整页导出、`network_body`、`trace` |
| 2026-11 | `e0752e6a` | 持久化不再空等合并窗口 |
| 2026-11 | `7e78e25e` | 写操作改为轮询目标状态；合并窗口降为 0 |
| 2026-11 | `f6ffa012` | `scroll` 改为轮询 `scrollTop` |
| 2026-11 | `38f625fc` | `read_full` 改为等渲染稳定 |
| 2026-11 | `a23787ed` | 新增 `settle` 正确性 suite；`expect` 走满窗口；`read_full` 按容器自适应并标记未确认 |
