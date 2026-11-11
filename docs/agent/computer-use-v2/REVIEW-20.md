# Computer Use v2.1 第 20 轮审核：授权弹层复用 Ask（`a7ac286..8b6b638`）

## 结论

接受 `8b6b638`。**可以从 `8b6b638` 重建测试版**，用户复测授权弹层的显示和打开文件夹。O1、S2 仍待下一轮。

## 审核要点

- 改动在 rotom 自己的组合层（`rotom/extensions/third-party/computer-use/approval.ts`），不在 vendored 的 Computer Use 包里。
  `computerUseApprovalApi` 只包装传给 `computerUse(...)` 的 `ExtensionAPI`，只在 Computer Use 的事件回调和工具执行上下文里替换 `ui.select`，
  其他扩展的界面不受影响；每次访问仍经过宿主的 `ui` getter，保留上下文失效检查。
- 弹层用 Ask 已固定版本的 `QuestionnaireSession` 和同样的 overlay 配置，不调用 Ask 工具、不触发续跑。只给原来的三个选项，
  不提供自由文本授权、不折叠、不打开外部编辑器。
- 安全语义保持：Esc、断开、过期都返回空，由原授权处理按“拒绝”记；提交时再检查一次截止时间；Ask 加载失败直接抛错，原处理记为 `ui_error` 并拒绝，
  不会退回旧选择框，也不会变成允许。RPC 模式没有终端 overlay，保留原生 `select`。
- 新文件加入 `product-config.mjs` 的 `requiredFiles`。根 `CLAUDE.md` 新增一条说明，并如实写明只做了离线验证、旧归档还没有新版。
- 兼容性：组合层代码在仓库源码里，合入 `main` 并更新后会直接生效；它只替换 `ui.select` 的呈现，与旧版 Computer Use 的授权调用方式兼容。

## 审核者复现

- Computer Use 包：289 项，287 通过、0 失败、2 跳过（macOS 专属）。当前文件树公开审计 PASS 0。
- 组合层测试依赖 Ask、`jiti` 等第三方包，审核容器里没有安装，无法复现；以执行方报告的 37/37 和 12/12（含真实 Pi `showExtensionCustom`
  在 206×50 内存终端里的渲染、超时只关闭本次弹层、负对照）为准。

## 低优先级

`approval.ts` 直接导入 Ask 包内部的 `ask-user-question.ts`。以后 Ask 升级移动了这个文件，授权会失败关闭（全部拒绝），安全但会让授权不可用。
建议把这个文件也加进 `requiredFiles`，让启动检查提前发现。

## 下一步

1. 执行方从 `8b6b638` 重建测试版（协议 10），方式同 REVIEW-19。
2. 用户复测：让它在 Finder 里打开“下载”文件夹，记录授权弹层是否出现、样子是否清楚、选了什么、目录是否跳转、是否打扰前台。
   O1 完成前不要让它打开文件或 App。
3. O1、S2 放进下一轮代码。
