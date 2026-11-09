# Computer Use v2.1 B 阶段改为“用户照常使用”模式（第四期交接）

用户决定在自己的 Mac 上测试，并明确要求：Computer Use 先要做到后台操作、不影响用户，测试也必须在用户正常使用电脑时进行。
本文替代此前“用户离开或保持安静”的前提。冻结提交、`B-STOPPED`、固定顺序、先审后冻结、只操作本次运行启动的进程、
禁用 `PI_CU_FAKE_BACKEND` 和临时命令，这些规则全部不变。

## 为什么改

原来的 K2 行（`run | real user input`）和 10 分钟空闲门禁，把“用户有没有输入”当成测量条件。这和产品承诺正好相反：
产品要证明的是“用户在用的时候，我们没有打扰他”。而且现在的测试流程本身就会打扰用户：

- `launchFixture` 用 `activates:true` 启动 fixture，会抢走用户的前台；
- 每一格之后的 `restoreOperatorApp` 会把前台切回运行前的 App。用户这时已经切到别处的话，会被拽回去。

## 新的判定：只看“我们做了什么”，不看“用户做了什么”

用户的输入不再参与判定。后台步骤（B0–B4）改为检查这几项：

| 行 | 判定 | 为什么和用户输入无关 |
| --- | --- | --- |
| `background \| agent HID events` | 本步骤期间 helper 统计的**带 agent 标记**的事件增量必须为 0 | 后台路径（AX、`pid`、`l2`）不经过全局 HID；带标记的事件只可能是我们发的 |
| `background \| focus taken` | 我们的每个动作前后各读一次前台；变成本次运行启动的进程或 helper → `fail`；变成别的 App → 记录为“用户切换”，不判失败 | 只把我们自己的进程成为前台算作抢焦点 |
| `background \| cursor warped` | helper 在后台策略下不调用任何移动光标的接口（`CGWarpMouseCursorPosition` 等）；用 Swift 自测和源码检查证明 | 光标只会被 HID 或 warp 移动，前一项和这一项一起覆盖 |
| 各步骤原有的效果行 | 按 fixture 自己的计数和读回判定 | 只读 fixture，不受用户影响 |

- 原 `run | real user input` 行降为**记录**（`recorded`），不再是必需行，也不再写 `B-STOPPED`。
- 门禁去掉空闲条件，只保留授权时间、冻结提交、`B-STOPPED` 和顺序检查。
- 未标记事件的归因（突发）继续作为报告保留，但不影响判定。

## 测试流程必须先做到“后台”

1. **fixture 不抢焦点。** fixture 增加一个启动模式：以 `activates:false` 启动后，由 fixture 自己在
   `applicationDidFinishLaunching` 里对主窗口调用 `orderFrontRegardless()`，不调用任何 activate。
   验收：启动前后用户的前台 App 不变，fixture 窗口可见、可被 AX 读取。
2. **去掉“恢复前台”。** 后台步骤里删除 `restoreOperatorApp`，改为上面的 `focus taken` 检查。我们没有抢过焦点，就不需要恢复。
3. **只在 fixture 上动作。** 不变。

## 哪些步骤仍然需要用户配合

- **B0–B4**：后台步骤，用户照常使用电脑，不需要离开，也不需要保持安静。
- **B5（前台接管）和 B6（`--with-hid`）**：这两项按设计就会占用光标和键盘，必须用户事先授权该 App 的前台模式。
  测试时用户只需要大约 30 秒不碰键鼠；B5 还要验证“用户一碰键鼠，接管立即停止”，这正是用户在场才能测的。

## 给执行方的顺序

1. fixture 的“不激活但显示窗口”启动模式，`launchFixture` 改用它；补 Swift 自测或 dry run。
2. 判定改造：`agent HID events`、`focus taken`、`cursor warped` 三行进入 B0–B4 的必需行；`real user input` 降为记录；
   门禁去掉空闲条件；后台步骤删除 `restoreOperatorApp`。`b-window.mjs` 的合同、单元测试和 dry run 同步更新。
3. 只做代码和测试，不跑真机。推送后报告 SHA，先审后冻结。`333589d` 一并报给审核者。
