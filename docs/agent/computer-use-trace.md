# Computer Use trace

本地界面操作 trace。默认开启，`ROTOM_CU_TRACE=0` 关闭；`trace_screenshots: false` 只记元数据、不存截图。

## 与根 `CLAUDE.md` 第 5 节的关系

第 5 节要求“不记录工具参数或工具结果正文”。Computer Use trace 是用户在 2026-11-03 明确批准的**单点例外**，因为一次界面操作如果只剩“某时刻某工具成功”，就无法回答“它到底点了哪个控件、屏幕上当时是什么”。例外的边界写死在实现和测试里：

| 记录 | 不记录 |
|---|---|
| 工具名、解析到的目标 role/label/ref、App 与窗口标题 | 模型对话、prompt、stream 文本 |
| 投递级别（L1/L2/L4）、状态、耗时、证据摘要 | 工具结果的完整正文 |
| 截图文件名（默认保存） | 输入文本明文：只存字符数和 SHA-256 |
| 租约/epoch 归属 | 凭据、密码字段内容、剪贴板内容 |

范围仅限 Computer Use：Observability（第 5 节）那条 trace 仍只写 metadata。

## 路径与权限

```
~/.rotom/computer-use/traces/<session>/<agent>.jsonl
~/.rotom/computer-use/traces/<session>/shots/0001-<ms>.jpg
```

- 目录 `0700`、文件 `0600`，以 `wx`/`O_CREAT|O_EXCL` 方式创建。
- 拒绝 symlink：只从 trace 根往下逐段检查，不检查 `/var` 这类合法上级链接。
- 保留 7 天；单会话最多 500 MB，超出时先删最旧截图。
- 永不上传，导出只在本地生成 Markdown。

## 关闭方式

| 方式 | 效果 |
|---|---|
| `ROTOM_CU_TRACE=0` | 完全不写，含截图 |
| `trace_screenshots: false`（config 或 `.pi/computer-use.json`） | 写 JSONL，不存截图 |
| `trace: false` | 不写 JSONL |

## 导出

`cu_session` 的 `trace_export` 生成 Markdown 报告（表格 + 截图时间线），写到会话目录旁，由用户自己决定是否分享。报告里同样没有明文输入。

## 未验证

- 真实会话下 trace 与截图的实际观感（本机禁止运行 helper，见 `computer-use-v2/STATUS.md`）。
- 500 MB 上限只在单测里用小阈值验证过。
