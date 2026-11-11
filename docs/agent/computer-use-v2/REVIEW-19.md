# Computer Use v2.1 第 19 轮审核：显式 `open`（AXOpen）与投递证据（`8b55ca0..a7ac286`）

## 结论

接受 `a7ac286`，**可以重建测试版做文件夹打开测试**。O1 必须在打包或合入 `main` 之前完成。

## 复测证据（`8b55ca0` 测试版，2026-11-11）

- **授权卡片在真机上走通**：`received`、`prompt_requested` 之后约 90 秒收到用户的 `allow_session` 和 broker 的 `response_ack`，
  上一轮的 45 秒提前放弃没有再出现。这是 REVIEW-18 修复的第一份真机证据。
- **点击没有生效**：Finder 的“下载”是一个只提供 AXOpen、`canPress=false` 的 `AXCell`。旧的 `click` 走了 pid 定向鼠标事件，结果 `unknown`，
  窗口标题仍是“最近使用”。pid 投递在真机上仍然没有成功记录。
- 用户报告前台、焦点、光标都没有被打扰（用户报告，非仪表记录）。

## 接受的部分

- `open` 是独立动作：只接受带 wire ref、非纯图片、当前观察里列出 AXOpen 的节点，不接受坐标；`click` 和 `press` 不会自动变成 `open`；
  同一批次不能对同一个 ref 混用 `open`、`click`、`press` 作为重试。
- Swift 分支（`performSemanticAction` 的 `open`）先确认支持 AXOpen，只调用一次 `AXUIElementPerformAction`；不回退成鼠标、不激活窗口；
  结果始终是 `unknown`，`verification=caller_required`，带 AX 返回码。
- 模型能看到的正文里写出每一步实际的投递方式和 AXOpen 枚举（最多 20 步，不带 App 名、标签或错误正文），不再只存在 `details` 里。
- helper 协议从 9 升到 10，客户端拒绝旧 helper，不自动重启；根 `CLAUDE.md` §4 同步改为协议 10。
- 审核者复现：干净 worktree 跑 2 次，289 项，287 通过、0 失败、2 跳过（macOS 专属）；dry run 38 项、0 失败、3 跳过；文件树审计 PASS 0。

## O1（高，打包或合入 `main` 之前必须完成）：打开文件或 App 会抢前台

`open` 归在 `click` 等级，只有控件标签命中敏感词表时才额外确认。但 AXOpen 作用于不同对象，后果完全不同：

- 文件夹：在 Finder 窗口里跳转目录，后台完成，不打扰用户。
- 文件、App、脚本：由系统交给对应程序打开，那个程序通常会**激活并抢走前台和焦点**，正好违反产品“后台操作、不影响用户”的承诺；
  打开 App 或脚本还会运行程序。

运行程序本身不是新风险（`click` 等级已允许 `manage_app_launch`，agent 也有 shell），新风险是**无确认地抢前台**。

修法：

1. helper 在执行 AXOpen 之前读取目标的 `AXURL`（或等价属性）：是文件 URL、`hasDirectoryPath` 为真、且不是 `.app` 等程序包，记为“导航”；
   其他情况（文件、程序包、脚本、读不到 URL）记为“打开程序”。
2. “导航”保持 `click` 等级；“打开程序”走敏感动作确认（`needs-confirmation`），卡片写明“会用其他程序打开，可能切到前台”。
   读不到类型时按“打开程序”处理（失败关闭）。
3. 补测试：文件夹不需确认；文件、程序包、缺 URL 都需要确认；确认被拒时 0 次派发。

## 下一步

1. 执行方从 `a7ac286` 重建测试版（协议 10）。旧的协议 9 测试 helper 先按方案停掉；产品原本身份、同一证书、独立路径和 socket、不碰日常安装，
   只启动一次。
2. 用户只测**打开文件夹**（例如在 Finder 里打开“下载”），记录授权卡片、目录是否跳转、是否打扰前台。O1 完成前不要让它打开文件或 App。
3. O1 和 S2 放进下一轮代码。
