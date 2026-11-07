# Computer Use v2.1 第 8 轮审核：两次 B0 窗口与 fixture 构建（`a6286bd..4430a68`）

## 结论

- `4430a68` 的根因分析和修复都接受：没有传 `-target` 时，swiftc 用了 SDK 的默认部署目标，产出 `minos 28.0`，
  比主机系统还新，dyld 拒绝加载。现在 `FIXTURE_MINIMUM_MACOS` 同时决定编译目标和 `LSMinimumSystemVersion`，
  构建后还用 `otool -l` 回读校验。“plist 无法为二进制背书，所以放在构建时校验”这个判断是对的。
- **但 `4430a68` 还不该冻结。** 两次 B0 窗口和更早几个窗口浪费掉的原因，大多在 Linux 上执行一遍脚本就能发现。
  先补 T1–T3，再冻结。
- 审核者复现：干净 worktree 连跑 2 次，201 项，200 通过、0 失败、1 跳过；dry run 23 项、0 失败、3 跳过；
  工作区干净。

## 窗口账目

| 窗口 | 冻结提交 | 审核过 | 结果 | 能在 Linux 上提前发现吗 |
| --- | --- | --- | --- | --- |
| 第一窗口 | `3aa2893` | **是** | 门禁永远不通过（`readGate` 不解析字符串） | 能：执行一次 `requireGate` |
| 第一窗口 | 同上 | **是** | `--delivery` 缺省成 `process.argv[0]` | 能：执行一次矩阵脚本 |
| 第一次 B0 | `a6286bd` | **是** | `alive is not defined` | 能：执行一次 B0 路径 |
| 第一、二次 B0 | `a6286bd`、`c026d0f` | 一次是、一次否 | fixture 起不来（`CFBundleVersion`、`minos`） | 不能：必须在 macOS 上启动 |

前三行都出在审核者批准过的提交里，是审核者的遗漏。原因相同：现在的 dry run 大部分是 grep 源码文本，
从来没有执行过真机脚本的主路径。HANDOFF-2 §2 要求“所有脚本都要先在 Linux 上用假 backend 跑通逻辑”，
这一条实际上没有做到。

第二次 B0 的读数（什么都没启动，未标记事件 `+0`）和“启动 App 产生未标记事件”的假设一致，但定向 L2 也没有运行，
所以还分不开这两个嫌疑。

## T1（高）：用假 backend 真正执行 `cu-v2-l2-check.mjs`

给脚本加一个只用于测试的注入点（例如环境变量 `PI_CU_FAKE_BACKEND=<模块路径>`，替换 `macosBackend`、`macosHelper`
和门禁读数）。dry run 在临时 git 仓库和临时 `--runs-dir` 里，**把整个脚本作为子进程跑完**，至少覆盖：

1. B0：fixture 启动、AX 点击、直连 L2 点击（计数 0→1）、`attribution` 行、无 `Verdict:`、无 `B-STOPPED`。
2. B1 通过：同上，并写 `Verdict: pass`。
3. B1 失败：直连 L2 点击计数不变，写 `Verdict: fail` 和 `B-STOPPED`。
4. 假 helper 不返回 `recentEvents`，见 T2。

注入点在真机运行时必须不可用：设置了 `PI_CU_FAKE_BACKEND` 却同时给了 `--expect-commit`，就拒绝运行（退出 2）。
控制实验：在 `a6286bd` 上，这套执行会因为 `alive is not defined` 失败。

## T2（中，阻断 B0）：归因数据缺失时不能报 0

`cu-v2-l2-check.mjs` 在 `userActivity` 没有返回 `recentEvents` 时把它当作空数组，汇总写成 `unmarked=0`，
看起来和“没有事件”一样。helper 没按冻结提交重建时就会这样，而 B0 的全部价值就在这一行。

修法：

- 没有 `recentEvents` 或 `recentEventLimit` → 写一行 `attribution | ring = fail`，说明 helper 不支持归因。
- 对账：运行开始后缓冲区里的条数，和运行前后 `userEventCount + agentEventCount` 的差值不一致 → 写一行
  `attribution | ring complete = fail`（缓冲区溢出或丢失）。上一轮的低优先级项升级到这里。

## T3（中）：构建产物要能证明来自冻结提交

冻结提交只约束仓库里的源码，不约束 `~/cu-v2-test` 里的 fixture 和 helper 二进制。旧 helper 会触发 T2 的问题，
旧 fixture（还是 `clicked/idle`）会让点击判定永远 `inconclusive`。两种情况都会白白浪费一个窗口。

修法：

- `build-fixture.mjs` 在 `Contents/Resources/source.sha256` 写入 `FixtureApp.swift` 的 SHA-256（不改 Info.plist，
  保持与已知能启动的 bundle 一致）。脚本启动前比对冻结提交里的源码，不一致就退出 2。
- helper：启动任何 App 之前，先确认 `userActivity` 带 `recentEventLimit`，`diagnostics` 的协议版本正确；
  不满足就退出 2。如果能在 helper 构建时嵌入 `bridge.swift` 的摘要，同样比对。
- 这类“环境没准备好”的拒绝是退出 2，不写 `B-STOPPED`，因为步骤并没有开始。

## 流程建议（由用户决定）

`637a62c`/`c026d0f` 和 `6e6a54d`/`f60cb0e` 两组冻结提交都没经过审核就进了窗口。每个窗口都要用户离开电脑一段时间，
代价比一轮审核高得多。建议恢复“执行方报 SHA → 审核者确认 → 用户冻结”的顺序。

## 给执行方的顺序

1. T1、T2、T3，各自补测试；T1 的控制实验写进提交说明。
2. 只做代码和测试，不跑真机。推送后报告最终 SHA。
3. 审核者确认后，下一个窗口仍然只跑 B0；窗口开始前按冻结提交重建 helper 和 fixture。
