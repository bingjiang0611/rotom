# Computer Use v2.1 第 27 轮审核：M1 修复与审计更正（`claude/computer-use-v2.1-main-candidate`，`4c7f7bb`）

## 结论

**接受 `4c7f7bb`，候选可以快进到 `main`。** M1 按 REVIEW-26 的四点修法完成；审核者在 REVIEW-26 里报告的历史审计数字是错的，本文更正。
快进后进入 HANDOFF-6 阶段 5（冻结 `0.2.0` 发布元数据）。

## 审计更正（REVIEW-26 的错误）

REVIEW-26 写“候选和 `origin/main` 的带历史审计都是 BLOCKED 244 项（482 个提交）”，这是错的，原因有两个，都在审核者这边：

1. **脚本版本不对。** 审核者在自己的工作分支目录里运行 `scripts/audit-public.py`，那是 `main` 在 `f7f2d70` 之前的旧版：没有维护者决定的
   `noreply@anthropic.com` 例外，也没有审计过的归档分片账本。候选应当用它自己的审计脚本。
2. **范围不对。** 审计脚本用 `git log --all` 和 `rev-list --objects --all`，审核者的本地仓库是浅克隆，又带着多个其他分支的引用，所以统计的不是候选可达的历史。

更正后的复现环境：

- 新建空仓库，只拉取一个引用：`refs/heads/claude/computer-use-v2.1-main-candidate` → 本地 `refs/heads/cand`，完整历史（非浅克隆），HEAD `4c7f7bb`，
  可达 545 个提交，没有其他分支或 tag。
- 检出 `cand`，用候选自带的脚本：`python3 -I scripts/audit-public.py --root <clone> --history`。
- 结果：**PASS，545 个提交，0 项**；文件 31,652 个，跳过已审计归档 317 个，公开示例 117 个，耗时约 29 秒。

执行方报告的 544/0 是 `c2922e7` 时的数字（M1 提交后为 545），与审核者的更正结果一致。执行方另行报告的“18 个远端分支合计 107 项、都不在 `main` 可达历史里”
不影响合入，因为只快进候选，不推那些分支。

附带观察（不阻断，属于 `main` 已有规则）：`audit_history_rules.py` 的注释说维护者豁免了“23 个历史提交”的 `noreply@anthropic.com` 作者，
但规则按地址整体放行，候选可达历史里这个地址作者的提交实际有 46 个（包括 `main` 当前 HEAD `1fbb1a3`）。今后用这个地址提交的都会被放行。
是否收紧为固定提交清单，由用户决定。

## M1 复审

### `rotom helper update`（`scripts/helper-update.mjs`）

- 在加锁、暂存、签名、发 socket 命令之前先用 `lsof` 探测占用；探测不确定（非 1 的退出码、有 stderr、输出不是纯 pid）一律当作“无法确认”，不当作空闲。
- 有占用时：非交互环境直接拒绝；交互终端询问“停止正在运行的旧 helper？使用它的其他 rotom 会话会失去 Computer Use。[y/N]”，只接受 `y`/`yes`/`是`，
  空回车、`n`、Ctrl-C、输入流关闭都算“否”。拒绝时不建锁、不改文件、不发 socket 命令。
- 同意后：先发一次 `diagnostics`，要求返回的 `pid` 在 `lsof` 的结果里、`executablePath` 的真实路径就是要替换的可执行文件，否则拒绝（防止误停别的 helper）；
  再发一次 `shutdown`，要求回执 `shuttingDown: true`；然后每 100 毫秒复查占用，5 秒内必须清空。回执丢失或超时记为结果未知，不重试、不替换。
- 签名完成、改名替换之前再查一次占用（原有的第二道检查保留）。
- 审核者核对：旧 helper（包括 `main` 初始快照的版本）都支持 `diagnostics` 返回 `pid`、`executablePath` 和 `shutdown` 命令，所以这条路径对真实的旧 helper 有效。

### 会话内的协议不匹配（`helper.ts`）

- 不再重新启动旧二进制。不匹配时记在会话里，只问一次“停止旧 helper，以便运行 `rotom helper update`？”；同意后只发 `shutdown`，而且用的是不会自动拉起 helper 的
  `daemonCommand`。之后这个会话里所有 Computer Use 调用都直接返回同一条提示，不再探测、不再询问、不再启动 helper。
- 关闭回执丢失时提示“未确认关闭”，不重试；确认期间取消不会发出关闭。
- 代价（符合设计）：即使用户随后在终端完成更新，这个会话也不能再用 Computer Use，必须新开会话。提示已写明。

### 提示与发布说明

`helperUnavailableGuidance`、`helperMismatchMessage`、更新命令的 `usage`/`busy` 和发布说明第 2 步都统一为“运行 `rotom helper update`（它会询问是否停止旧 helper）”，
发布说明删去了用户无法完成的“退出旧 helper”一步。

### 归档

`0.5.1-rotom.4` 归档重新打包：实算 sha512 与 `product-config.mjs`、third-party lock 一致；归档里 `scripts`、`src` 共 88 个文件与源码逐字节相同；
与上一版归档相比只有这次改动的源文件和两份说明不同，原生产物没有变化。这个版本号还没有进入 `main` 或 npm，在候选内换内容不构成冲突。

## 审核者复现

- `helper-update.test.ts` 与 `helper-protocol.test.ts`：29 项，27 通过、2 跳过（需要 macOS），0 失败。
- 组件串行完整测试：325 项，319 通过、1 失败、5 跳过；唯一失败仍是需要真实 TypeScript 编译器的用例（审核容器没装依赖）。
- `rotom/runtime/update-helper.test.mjs`：2 项中 1 项失败，原因是审核容器的 Node 是 22，启动器要求 24 以上；与本次改动无关，执行方在 Mac 上报告通过。
- 当前文件树和完整历史审计 PASS 0（见上）。

## 小问题（不阻断，可以在阶段 5 冻结前顺手改，也可以以后改）

- 新增的提示文字是中英混写（如 `helperUnavailableGuidance` 一句英文里夹一句中文）。用户界面和给模型的提示最好各自统一成一种语言。

## 下一步

1. 执行方把 `claude/computer-use-v2.1-main-candidate`（`4c7f7bb`）**快进**推到 `main`，推送前确认远端 `main` 仍是 `1fbb1a3`；若 `main` 已前进，停下报告，不要合并或强推。
2. 进入 HANDOFF-6 阶段 5，按根 `CLAUDE.md`“npm 正式发布顺序”：从最新公开 `main` 建干净 clone，单独提交冻结 `0.2.0`、dist-tag `latest` 的发布元数据，推送后报告 SHA，
   审核通过再 `pack:release`。
3. 最终 tgz 的验证必须包含：在隔离的 HOME 和 prefix 里安装，用 `rotom helper update` 和用户的 Apple Development 身份把 helper 装到**隔离路径**，
   确认它能在这台受管 Mac 上启动、`diagnostics` 为协议 11。被端点安全终止就停止发布。真实的“停止旧 helper 再升级”一步，按用户另行授权在日常 helper 上验收。
