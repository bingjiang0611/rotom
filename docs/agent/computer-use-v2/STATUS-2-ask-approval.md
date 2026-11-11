# Computer Use 授权统一到 Ask

## 范围与实现

本轮按维护者选择统一**界面实现**，不只是外观。仅修改源码、离线验证并推送送审；不替换活跃测试安装、不重启 helper、不重放此前超时的 `open`。O1（按打开目标类型分级）和 S2（类型检查债务）不在本轮范围。

- 产品组合层 `rotom/extensions/third-party/computer-use/approval.ts` 将 Computer Use 的 TUI 授权接到已固定版本 Ask 的 `loadQuestionnaireSession` / `QuestionnaireSession`，使用同样的 `ctx.ui.custom` overlay 配置。不复制问答组件，不嵌套调用模型工具，不触发 Ask 的续跑逻辑。
- 仅替换 Computer Use 上下文中的 `ui.select`。覆盖 `session_start` 捕获的 broker 上下文和工具执行时的上下文；不修改共享 UI 或其他 extension。每次访问仍经过宿主的动态 UI getter，保留上下文失效检查。
- 沿用原来的标题、目标信息和三项选择，映射仍为 `allow_session` / `always` / `deny`。授权只接受现有选项，不提供自由文本授权，不允许折叠授权卡或启动外部编辑器。
- 源码 broker 传入的剩余 deadline 和 AbortSignal 控制弹层生命周期。Esc、断连、过期均不能授权；定时器即使延迟执行，提交时仍检查 deadline。结束后清除监听和定时器，只关闭本次弹层。
- TUI 加载或显示失败不回退到旧 selector；错误交回原 broker handler，不能变成允许。RPC 没有终端 overlay，保留其原生 `select` 协议。
- 新文件加入 `rotom/runtime/product-config.mjs` 的 requiredFiles。未修改 Pi fork、原生 helper、协议或依赖版本。

本次不是对旧 `ui.select` 未显示原因的确诊；此前 trace 只证明请求过显示，不能证明当时屏幕上出现了授权卡。

## 离线证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 产品 loader、Ask schema/续跑、授权适配 | 37/37 | 包含 11 个新增用例；真实 Ask 组件在内存中渲染和接受键盘事件 |
| 原 broker 授权、连接中断、调度和拒绝 | 12/12 | 保留 deadline、取消、派发前拒绝及 unknown 不重放合同 |
| 真实 Pi `showExtensionCustom` | 通过 | 内存终端 206×50；超时仅移除本次 overlay，保留既存 overlay 和用户草稿，迟到输入不再关闭其他界面 |
| UI 生命周期负对照 | 先失败后通过 | 首版适配器缓存 `ctx.ui` 时，新用例返回旧 UI；改为经过宿主 getter 后通过，并检查失效上下文拒绝访问 |
| 新适配器严格类型检查 | **未全绿** | 依赖图仅报告上游 `state/i18n-bridge.ts` 无法解析 `@juicesharp/rpiv-i18n`；单独检查原 Ask 源码也是同一条诊断，新文件无新增诊断 |

主要测试命令（仓库根）：

```bash
node --test --test-concurrency=1 --experimental-strip-types \
  rotom/extensions/third-party/index.test.ts \
  rotom/extensions/third-party/ask/schema.test.ts \
  rotom/extensions/third-party/computer-use/approval.test.ts

node --test --test-concurrency=1 --experimental-strip-types \
  packages/rotom-computer-use/test/approval-ui.test.ts \
  packages/rotom-computer-use/test/broker-approval-transport.test.ts \
  packages/rotom-computer-use/test/broker-real-schedule.test.ts \
  packages/rotom-computer-use/test/broker-refusal.test.ts
```

产品 loader 测试使用独立临时 HOME / agent 目录，并显式将 `ROTOM_PI` 指向仓内已构建 `dist/cli.js`。该测试子进程设置 `ROTOM_CU_BROKER=0`、`ROTOM_OBSERVABILITY=0`，只验证加载/组合，不连接日常 broker 或启动 helper；broker 合同由第二组独立离线 fixture 验证。临时 HOME 已清理。首次 loader 运行未传 `ROTOM_PI`，9 项因无法定位 Pi dist 失败；补齐测试环境后通过，未改验收断言。

## 隐私与送审

当前文件树及本轮改动文件审计均为 0 项。全历史审计仍被 83 项既有命中阻断（57 个本机路径、21 个作者邮箱、5 个提交者邮箱）；对象均已存在于远端 `a7ac286` 的历史，不是本轮新增。沿用本分支已确认的送审方式：只提交本轮干净 diff，作者与提交者使用 GitHub noreply，不改写历史，不把全历史审计说成通过。

## 部署边界与下一步

**源码组合不等于当前归档或已安装产品。** 本分支此前的授权超时修复和协议 10 尚未重建 Computer Use vendor 归档。维护 checkout 的旧 `node_modules/@injaneity/pi-computer-use` 仍有不传 timeout / AbortSignal 的内联 handler；不能拿本轮源码测试证明该旧安装具备新合同。新测试将产品适配器与 `packages/rotom-computer-use` 的已审源码 handler 组合验证，产品 loader 测试另证明正常工具注册不漂移。

后续须先审阅本轮 commit，再按既有流程从冻结源码建立**新的独立安装**，用 `ditto` 覆盖其 Computer Use 源码，并验证实际安装中的 handler 和适配器均来自冻结版本。未经这一步，不宣称完整 deadline/取消合同已在新产品安装上通过。

本轮未在真实终端显示新授权卡，未执行 Finder AXOpen，也未更新发行归档。后续真实验证须由维护者授权；仍只测试文件夹、使用新 observation/ref、一次派发并只读回验。O1 解决前不开放文件/App 测试或合入发布；S2 独立处理。既存证据见 [授权超时](STATUS-2-approval-timeout.md)、[语义 open](STATUS-2-semantic-open.md) 和 [类型检查](STATUS-2-typecheck.md)。
