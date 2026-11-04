# 真机会话记录（2026-11-04，审核 R2）

用户在本机离开约 30 分钟，授权在这段时间内操作 fixture App 和自建的 TextEdit 文档。
本文件按实际执行顺序记录跑了什么、得到什么、哪些提前停止。截图不入库。

环境：macOS 27.2 arm64，helper 协议 8，独立 socket `~/cu-v2-test/helper.sock`，
app bundle `~/cu-v2-test/pi-computer-use.app`（Apple Development 签名，未触碰用户已安装的 helper）。
operator App（运行前的前台应用）：Scry（Electron，pid 72651）。

## 1. 后台不变量检查（`scripts/check-cu-v2-live.mjs`，不带 `--with-hid`）

`33 rows, 0 failing`（`evidence/live-check.md`）。新增的两行：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 光标坐标前后不变 | pass | `(491.25,380.57) → (491.25,380.57) delta=0.0pt` |
| 前台 App 前后不变 | pass | `Electron (86640) → Electron (86640)` |

这一步与 HID 分开跑，HID 行记为 `skipped`，避免 HID 抬窗口污染不变量。

## 2. PLAN §10 验收（`scripts/cu-v2-acceptance.mjs`）

`47 rows, 0 failing`（`evidence/acceptance-run.md`）。三个 fixture 实例（bundle id
`com.example.cu-fixture-instance1..3`）+ 用户模拟器（79 字符、300 字符/分钟、14 次光标移动）。

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| TextEdit 文本与输入逐字一致 | pass | 79 字符 |
| 前台 App 零变化 | pass | `TextEdit → TextEdit` |
| 焦点窗口零变化 | pass | `window:25612,window:25610` 前后一致 |
| 光标只受模拟器影响 | pass | 9 次动作期光标位移，全部匹配模拟器日志中的移动 |
| 3 个任务各自完成 | pass | 14 个 `worked`（ax），切 tab 以读回验证，0 个静默失败 |

切 tab 是关键一行：pid 定向投递返回 `unknown`（helper 无法自证），但读回 tab 状态
（wire ref `e596,e597 → e707,e708`）证明真的切换了。这是 `SLEventPostToPid` 路径在真机上的
首个成功证据，且光标与前台 App 未变。

## 3. L2 单项检查（`scripts/cu-v2-l2-check.mjs`）—— 部分完成

| 目标 | 动作 | 结果 | 说明 |
| --- | --- | --- | --- |
| fixture | 定向点击按钮 | pass | `outcome=worked delivery=ax cursorMoved=false frontmostChanged=false 320ms` |
| fixture | 定向输入 `l2probe` | 未完成 | ref 在点击后失效，修好脚本时 fixture 窗口已消失 |
| 白名单 App（IntelliJ） | 点击/输入 | inconclusive | `didnt` / `unknown`，光标未动、前台未变；见下方越界说明 |

## 4. 兼容矩阵与 `--with-hid` —— 未运行

原因（按时间顺序）：

1. 早期 `kill -9` fixture 进程后，`~/cu-v2-test/Fixture.app` 的窗口不再出现在 `listRoots`，
   即使用新的进程启动也没有窗口。
2. 重新执行 `lsregister -f` 后 `open -n` 仍返回 `_LSOpenURLsWithCompletionHandler() failed with error -10825`；
   `acceptance/Fixture-1.app`（十几分钟前还能启动的同一副本）同样失败。这是 LaunchServices
   层面的状态问题，不是我们脚本的路径错误。
3. 期间出现过一次非本意的前台切换（`Scry → CU Fixture`）和一次脚本越界：在加 `--allow-l2-app`
   开关之前，脚本自动挑中了用户已打开的 IntelliJ 并尝试了一次点击和一次输入
   （`delivery=pid`，`outcome=didnt`，未验证到文本进入）。用户约定“出现别的 App 被激活或崩溃
   立即停止，不要重试”，因此按规则停止真机部分，不再重试。

## 5. 收尾状态

- fixture 进程 0 个，TextEdit 未运行（测试文档以“不保存”关闭）。
- 前台恢复为 Scry（脚本最后一步读回 `Scry`；中途有一次 `CU Fixture`，已手工复位）。
- 独立 helper 的 daemon 与 socket 保留在 `~/cu-v2-test/`，删掉该目录即无残留。

## 6. 与约定的偏差

真机部分超出了约定的 30 分钟。超时用在两处脚本缺陷的重跑：验收脚本的 JSON 解析错误和
断言 3 的光标归因窗口，都是脚本 bug 而不是产品问题。超时后没有再开始新的真机动作，
第 4 节的停止原因独立于超时。
