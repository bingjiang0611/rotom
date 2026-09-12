# Computer Use 结果证据与 stale 恢复

实现位置：`computer-use/recovery.ts`；在公开 `registerTool` 的 execute 边界组合的恢复层，不修改 native helper 或 Pi。（注：产品当前锁定的 Computer Use 已是 `@injaneity/pi-computer-use@0.5.1-rotom.0` fork，见 `vendor/README.md` 与包内 `UPSTREAM.md`；本恢复层与该 fork 是相互独立的两处改动。）

## 已修复的组合层缺口

- `act_ui` 的正文展示 outcome、verification、顶层及逐步错误码、停止步骤。替换上游固定的 “Executed … checked” 标题；保留原始 details、successor state、变化与图片。
- `failed` 后置条件可能发生在业务写已完成之后；`preexisting` 条件不证明本次动作成功。返回这些证据，不抛掉 successor state，也不把 unknown 改成可重试失败。Pi 的 execute 正常返回不会设置 isError，不能用返回一个 isError 字段假装修好了这个问题。
- 正常结果中的 `details.error`、`details.execution.error`、`details.execution.steps[].error` 也触发 stale 恢复。只检查协议错误字段，不扫描 AX/OCR、页面正文或完整结果字符串。
- stale 或丢失源窗口后，下一次 act 必须先显式成功 observe 并使用其 stateId；失败、取消的 observe 和旧 session 的迟到结果不能解除当前 gate。部分已执行批次不得整体重放。
- 同一批次对同一 ref 重复 press/click 在派发前被拒绝；显式 clickCount、多目标操作和点击后输入仍可用。press+Enter 在按钮上的补偿重试通过结果提示禁止，不能仅按按键组合硬拦截，否则会误伤文本输入。
- inspect_ui 的零尺寸 rect 增加定位证据不足提示，不伪造 offscreen 状态、不宣称 AXPress 可用就代表可见或能生效。

## 未修复 / 不改变的边界

- 默认后台投递不变，不自动 activate、转前台 HID 或重新派发 unknown 写操作。
- 不宣称修复 Electron/macOS 的 AX 几何、缓存或异步刷新；组合层只能暴露不确定性并要求止损。
- 不新增业务 App 按钮作为维护自动化入口。批处理优先已有且获授权的结构化接口，真实 UI 验证单列。
- 不保存用户会话、截图或业务正文作为测试 fixture。

## 验证

从仓库根运行（third-party package 无独立 npm scripts）：

```sh
node --experimental-strip-types --test --test-concurrency=1 rotom/extensions/third-party/index.test.ts
```

其中 `Computer Use` 定向用例覆盖结果正文、部分执行/stale、原始证据保留、生命周期、重复 activation 和零尺寸诊断。真实 Pi loader 测试证明组合能加载；runtime smoke/footprint 另按 `docs/agent/verification.md` 运行。这些测试不操作真实桌面、不调用付费模型，不能替代当前 Electron App 的真实重放。

本次验证：`check-personal` 88/88 通过；真实 loader、package identity 定向测试及默认/完整工具面 smoke + footprint 均通过，常驻 guideline bytes 不变。额外尝试的完整 `verify-pi-runtime.test.mjs` 在复制整个依赖目录的 symlink 用例阶段触及 120 秒时限，未完成；没有据此声称完整 verifier 通过。未执行真实 Electron 重放或付费模型评测。

已经运行的 Pi 进程需空闲后 `/reload` 或重启 launcher 才加载新 wrapper；不需要替换 native helper。
