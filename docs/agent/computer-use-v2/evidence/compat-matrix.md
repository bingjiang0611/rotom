# Computer Use v2 compatibility matrix

Status: **未运行**。本机无法运行任何本地编译产物（`Killed: 9`），也没有授予 Accessibility / Screen Recording，因此这个文件目前只是约定，不是证据。

生成方式（必须在 macOS 真机、已授权、已装 v2 helper 的机器上执行）：

```bash
cd packages/rotom-computer-use
PI_CU_LIVE=1 node scripts/cu-v2-compat-matrix.mjs --apps com.apple.TextEdit,/tmp/cu-fixture
```

规则：

- 只允许驱动 fixture App，以及 TextEdit 空文档、Finder 只读窗口这类不涉及用户数据的 App。
- 单元格只有 `pass` / `fail` / `unknown` / `refused` / `skip` / `not-run` 六种，不推断、不补齐。
- 一个 App 只有在它需要的每个动作于 `background` 策略下都是 `pass`，才能加进 `src/policy/l2-compat.ts`；否则保持 `foreground_required`。
- 每次运行的文本日志放同目录，文件名带时间戳。

## 首次运行的记录

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| (未运行) | - | - | not-run | 需要 macOS 真机 + 权限 + v2 helper |
