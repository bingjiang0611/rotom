# O1 请求构造修复

## 已确认缺陷

`35b74fbc` 中，bridge 已把 `openTarget` 和 `openApproved` 放进 prepared action，但 `src/tools/act-request.ts` 把 open 与无参数语义动作合并，只序列化 delivery。原生 helper 因缺少预检信息返回 `open_target_changed`，文件和目录都受影响。这是产品传参缺陷，不是已证实的 Finder 或权限问题。

用户确认本次真实测试选择的是“允许一次”，不是“拒绝”。测试报告显示 helper 在 AXOpen 前拒绝，随后停止 B；该次不能作为“拒绝后零派发”的验收。没有为本次修复重放动作。

此前的 broker 测试、构包测试、原生 fixture 分段通过，但构包测试没提供预检字段，原生 fixture 又手工构造字段，未覆盖中间链路。上一轮全量测试后更新了协议文档，遗留一个仍断言协议 10 的测试；本轮一并改成与实际协议常量对照，而不降低文档检查。

## 最小修复

- open 单独构造请求，显式保留 openTarget/openApproved 和原有投递信息；其他动作的白名单不变。
- `PlatformActRequest` 为 open 增加对应类型；不扩大其他动作参数，不用 any 掩盖新类型问题。
- helper/broker 协议仍为 11/2。原生检查、每次确认、unknown 不重放和 broker 拒绝边界不变。

## 回归证据

`semantic-open.test.ts` 现在将实际 `prepareAction → buildActRequest` 的输出写成 JSON，再由包含实际原生 open 分支的 Swift fixture 读取。目录、文件、程序包、未知类型分别覆盖 true/false 确认，共 8 组；允许路径在 AX 返回成功或错误时都只调用一次桩并保留 unknown，非目录未确认时为零调用。不把调用桩当作真实 AX 或 App 效果。

未修复代码上的负对照：4 项测试中 2 项失败；序列化字段断言失败，原生 fixture 也真实返回 `open_target_changed`。修复后完整包测试 298/298、产品测试 63/63 通过，均无跳过；pretest 为 0 fatal / 144 total，完整类型债务未清零。独立新安装另行复验同一 wire 回归与实际 Ask 适配器，结果记录在该构建的日志中。

修复仅送审并独立重建，不替换运行中的安装，不停止现有 helper，不自动启动新 helper，不执行 A/B。新测试会话仍须先观察、每个动作一次；异常即停，unknown 只读核对。
