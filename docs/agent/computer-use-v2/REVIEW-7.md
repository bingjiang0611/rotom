# Computer Use v2.1 第 7 轮审核：第二至第四个 B 窗口（`bf7bd8e..d474ec3`）

审核范围：`runs/2026-11-06T2240-b1-*`（第二窗口，`bf7bd8e`）、`runs/2026-11-06T2305-window-gate-hold.md`
（第三窗口，`6e6a54d`）、`runs/2026-11-06T2336-b1-*`（第四窗口，`f60cb0e`），以及 `6e6a54d` 的判定修改。

## 结论

- 两次 B1 都是有效的失败：都在冻结提交上运行，门禁通过，失败后立即停止，存档原样保留。规则这次执行到位。
- `6e6a54d` 和 `f60cb0e` 作为冻结提交是用户授权的，但没有经过审核。`f60cb0e` 相对 `6e6a54d` 只改了文档，
  所以第四窗口跑的代码就是 `6e6a54d`。审核者现在补审了 `6e6a54d`，见 R1。
- 执行方提出的两项修改方向都对，按下面的约束做。

## 一处说法更正：L2 还不能说“走通了”

两次直连 L2 点击都返回 `delivery=l2`、helper 存活、`outcome=unknown`，第四窗口的效果读回前后相同。能证明的只是：
**`SLEventPostToPid` 在真机上被调用了两次，调用返回，helper 没有崩溃**。事件有没有到达 fixture，仍然未知。
STATUS-2 和根 `CLAUDE.md` §4 只能写到这一层，不要写成“已走通”或“已验证”。

## R1（中）：点击效果要用计数，不要靠调整顺序

fixture 的结果是二值的（`idle` → `clicked`，见 `FixtureApp.swift` 的 `accessibilityValue`），点过一次就不会再变。
同一个按钮先被 AX 路径点过，定向点击就无从判定。只把 `--direct-l2` 挪到前面能救这一行，但同一次运行里
只有第一次点击可以判定，以后再加任何点击都会重演同一问题。

修法：fixture 的按钮结果改为单调递增的计数（例如 `clicks: N`，同时写进 `accessibilityValue`），每次点击都按
“计数加一”判定。`judgeDirectedClick` 的 readback 分支相应改为 `after == before + 1`。这样 AX 点击那一行
（现在一直是 `inconclusive`）也能用同一种读回判定。补单元测试：计数不变 → `fail`，加一 → `pass`，加二 → `unknown`。

## R2（高，阻断）：未标记事件要先归因，判定规则暂不放宽

读数：

| 窗口 | 运行前 | 运行中（约 12 秒） |
| --- | --- | --- |
| 第一窗口（`c0b96ad`，fixture 以 `activates:false` 启动） | — | live check 前后 `106 → 106` |
| 第二窗口（`bf7bd8e`） | 门禁 626 s 无输入 | `+103` |
| 第四窗口（`f60cb0e`） | 门禁 618 s 无输入 | `+72` |

运行前 10 分钟机器确实安静，运行的十几秒里出现几十个未标记事件，所以来源几乎可以肯定在运行内部。
自 `ce9c568`（P3）起，fixture 改为以 `manageApps launch activates:true` 启动；更早的
`runs/2026-11-06T1435-b1-four-attempts.md` 也记过 `manageApps launch` +15。启动并激活 App 是首要嫌疑，
直连 L2 投递次之。

修法，按顺序：

1. **helper 记录每个未标记事件的来源元数据**，放在有界环形缓冲区（例如 512 条），由 `userActivity` 返回：
   时间戳、`CGEventType`、`kCGEventSourceUnixProcessID`、`kCGEventSourceStateID`、是否带 agent 标记。
   **不记录键码、字符和坐标**，这是根 `CLAUDE.md` §5 的边界。脚本在存档里按（事件类型、来源进程名、state id）
   分组计数，并和运行日志的行时间对齐。
2. **在拿到数据之前，K2 的 `run | real user input` 规则一个字都不改。** 数据出来以后，只能排除“来源 pid
   属于本次运行启动的进程（helper、fixture 副本）”的事件，并且要在审核里逐项说明。来源 pid 为 0 或来自
   HID 系统状态的事件一律算真人输入，不能排除。
3. 如果是我们自己的投递路径漏打了标记，修的是标记，不是判定。

采集数据需要真机。建议增加一个 **B0 归因运行**：门禁、冻结提交、`--runs-dir` 的约束和 B1 相同，动作也和 B1 相同，
但它只写归因报告，不写 `Verdict:`，不能放行 B1，也不写 `B-STOPPED`。它同样需要用户单独授权。

## R3（中，流程）：`--runs-dir` 由用户在授权里指定

`B-STOPPED` 放在 `--runs-dir` 里。如果执行方每个窗口自己选一个新目录，这个标记换个目录就绕过去了。
这几个窗口里旧标记的删除都有用户授权，没有出问题，但规则不该依赖这一点。从下一个窗口起，
`--runs-dir` 写在用户的授权里，执行方不得自行更换。

## 第三窗口：需要用户确认

23:03–23:19 门禁一直 hold：1,656 秒里有 39,540 个未标记事件（每秒 20–65 个，这是鼠标移动的典型速率），
前台在 Scry、Google Chrome、Etch 之间切换。这更像有人在用机器。如果用户那段时间确实不在，就是有别的东西
在驱动这台机器的输入，需要查清楚，和 Q6（安全软件界面短暂成为前台）一起看。

## 给执行方的顺序

1. R1：fixture 计数、`judgeDirectedClick` 改为按计数判定，补测试，重建 fixture。
2. R2 第 1 步：helper 归因缓冲区和脚本分组报告，补测试（Swift 自测覆盖缓冲区上限，以及不记录键码和坐标）；
   增加 B0 模式（dry run 覆盖：不写 `Verdict`，不放行 B1）。
3. STATUS-2：更正 L2 的说法；B1 记两次有效失败。
4. 只做代码和测试，不跑真机。推送后报告最终 SHA，由审核者确认后再冻结。

## 复核（2026-11-07，`30b112a..a6286bd`）：接受，`a6286bd` 可作为冻结提交

冻结提交：`a6286bd7a6782bae2bdd92563291e5b4872d2d2e`。

### 审核者复现

- 干净 worktree 连跑 2 次：192 项，191 通过、0 失败、1 跳过；dry run 21 项、0 失败、3 跳过；运行后工作区干净。
- 用真实 `git` 在 `a6286bd` 上重放第 6 轮的全部场景：结果都不变（仓库内 `--runs-dir` 被拒绝、B1 通过后 B2 允许、
  `inconclusive` 的 L2 点击写 `B-STOPPED`、走 `pid` 判 `fail`、B3 子步骤不能跳过）。
- B0：`reportOnly` 为真，存档没有 `Verdict:` 行，不写 `B-STOPPED`；它的存档不能当作 B1 通过，也不能放行 B2；
  已有 `B-STOPPED` 时 B0 同样被拒绝。

### 接受的部分

- R1：fixture 改为 `clicks: N`；`judgeDirectedClick` 正好加一判 `pass`，没变判 `fail`，加二及以上判 `unknown`，
  读不到计数判 `inconclusive`。`outcome=unknown` 的定向点击可以由读回证明。
- R2：helper 的环形缓冲区只有 `at/type/pid/stateId/agent` 五个字段，上限 512；Swift 自测断言字段是这五个的子集，
  并逐个排除键码、字符和坐标。存档只写按（类型、来源进程、state id）分组的计数。只统计运行开始之后的事件。
  K2 的判定（`evaluateStep`、`recordRealUserInput`）没有改动。
- 根 `CLAUDE.md` §4 改为“调用两次、helper 未崩、效果未确认”，与本轮措辞一致。

### 低优先级（不阻断）

- 缓冲区溢出没有提示：一次运行超过 512 个事件时，最早的会被丢掉，汇总会少算。用运行前后的
  `userEventCount + agentEventCount` 差值和缓冲区里的条数比较，不一致时加一行 `ring truncated`。
- `ps -o comm=` 在 macOS 上给的是完整可执行路径，可能带家目录，也会列出机器上其他软件的名字（例如安全软件）。
  把 B0 存档复制进公开的 `evidence/runs/` 之前，家目录要写成 `~`，并由用户看过进程名再决定是否公开。
- 根 `CLAUDE.md` §4 同一段仍写“helper 协议已升到 8”（实际是 9）。“仲裁是协作式的”按 Q4/E4 有意保留到 B4。

### 下一个窗口只跑 B0

K2 规则在 B0 数据审核之前不变，所以同一窗口里接着跑 B1，大概率又因为同一批未标记事件失败，白白写一个 `B-STOPPED`。
下一个窗口只跑 B0，审核者看完归因数据、决定 K2 怎么改之后，再授权 B1。B0 的动作和 B1 相同；输入法切到 ABC，
定向 `typeText` 才会运行，按键投递路径也才能被归因。`--runs-dir` 由用户在授权里指定。
