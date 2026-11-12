# Computer Use v2.1 第 26 轮审核：合入 `main` 的候选（`claude/computer-use-v2.1-main-candidate`，`c2922e7`）

## 结论

候选的合并质量很高，但**还不能快进到 `main`**：升级流程有一个会卡住所有升级用户的问题（M1）。修完 M1 再审一次，就可以推 `main`。

## 结构

- `origin/main`（`1fbb1a3`）是候选的祖先，可以快进；候选只新增 1 个提交，作者和提交者都是 GitHub noreply，没有带入 v2.1 的分支历史。
- 与审核过的 v2.1（`7eea832`）逐目录比较，差异分三类：
  1. **直接采用 `main` 的版本**（候选与 `main` 完全相同）：`permissions.ts`、`broker-socket.test.ts`、`helper-protocol.test.ts`、`regression.md`。
  2. **纯粹的搬移**：`setup-helper.mjs` 拆成 `setup-helper`、`-common`、`-release`、`-signing` 四个文件。审核者核对：两边各 38 个顶层函数，函数体（去掉空白后）全部相同；
     去掉 import/export 后，其余顶层代码两边逐行相同。`handlePing` 从 `core.ts` 原样移到 `user-control.ts`。`main` 在分叉后没有改过 `setup-helper`。
  3. **为 `main` 的变化做的适配**：`main` 把 Ask 升到了 2.15.0，`approval.ts` 补上新版 `QuestionnaireSession` 需要的字段，并把新导入的 Ask 内部文件
     （`config.ts`、`presentation.ts`）加进 `requiredFiles`；启动器在 `main` 新增的 `ROTOM_LAUNCHER_PATH` 之上加入 `helper` 子命令。
- `0.5.1-rotom.4` 归档按合并后的源码重建，实算 sha512 与 `product-config.mjs`、third-party lock 三处一致。这个归档名从未在 `main` 或 npm 上出现过，与 v2.1 分支上的同名归档内容不同不构成冲突。

## 文档

根 `CLAUDE.md` 新增 `rotom helper update` 的启动器约定和证据分级表，内容如实。发布说明草稿（`docs/releases/computer-use-v2-draft.md`）把升级步骤放在最前，
如实列出未经真机验证的能力、ScreenCaptureKit 的周期确认，并写明“重启确认不会安装新二进制”。

## 审核者复现

- Computer Use 包串行：315 项，309 通过、1 失败、5 跳过；唯一失败需要真实 TypeScript 编译器（审核容器未安装依赖）。执行方在 Mac 上报告组件 315/315、产品 597/597、Goal 99/99。
- 当前文件树审计 PASS 0。
- **带历史的审计**：候选 BLOCKED 244 项（482 个提交）；对 `origin/main` 跑同样的审计也是 BLOCKED 244 项，两者逐项比较，**候选新增 0 项**。
  这 244 项（非 noreply 作者 73、非 noreply 提交者 59、家目录路径 68）都是 `main` 公开历史里早已存在的，与本次合并无关。执行方报告“544 个提交 0 项”，
  与此不符，请说明审计的范围或参数。清理 `main` 的公开历史需要改写历史，属于另一个由用户决定的事项，不在本次范围。

## M1（高，推 `main` 之前必须修）：升级流程会把用户卡住

两条路径在最常见的升级场景里互相冲突：

1. `main` 的 `ensureProtocolWithConsent`（`bc405d9`）在协议不匹配时询问“要重启 helper 吗”，同意后执行 `shutdown` 再从
   `~/Applications/pi-computer-use.app` **重新启动**。但升级不会替换这个文件，重新启动的仍是旧二进制，协议依旧不匹配；而且旧 helper 又被启动了。
2. v2.1 的 `rotom helper update` 发现有进程打开着 helper 就拒绝。于是用户照提示运行更新命令时，会被刚刚重启的旧 helper 挡住。
3. 发布说明第 2 步要求“退出旧 helper”，但 helper 是 `LSUIElement`（不在程序坞里），菜单栏只有 agent 列表、“继续”“停止 agent”“停止所有 agent”，
   **没有退出项**。普通用户没有受支持的方法退出它，只能去活动监视器强制结束。
4. 给模型的 `helperUnavailableGuidance` 说“等人重启 helper”，可重启解决不了。

修法：

1. **`rotom helper update` 能自己处理正在运行的 helper**：检测到 helper 在运行时，如果是交互终端，询问“停止正在运行的旧 helper？使用它的其他 rotom 会话会失去 Computer Use”，
   默认“否”；用户同意后通过 socket 发送 `shutdown`（不强杀进程），确认可执行文件已不再被占用，再继续更新。非交互环境保持现在的拒绝。
2. **会话里的不匹配处理不再重新启动旧二进制**：把询问改为“停止旧 helper，以便运行 `rotom helper update`”，同意后只 `shutdown`，不重新启动；
   拒绝或完成后，都提示运行 `rotom helper update`，然后新开会话。
3. `helperUnavailableGuidance`、`helperMismatchMessage`、发布说明第 2 步，统一写成“运行 `rotom helper update`（它会询问是否停止旧 helper）”。
4. 补测试：运行中的 helper 在用户同意后被 `shutdown` 再更新；拒绝时不改任何东西；非交互环境拒绝；会话不匹配路径不会重新启动旧 helper。

## 下一步

执行方在候选分支上修 M1，推送并报告 SHA；审核通过后快进到 `main`，再按根 `CLAUDE.md` 单独提交冻结 `0.2.0` 的发布元数据。
