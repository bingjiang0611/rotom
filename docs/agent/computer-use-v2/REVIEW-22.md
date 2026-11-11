# Computer Use v2.1 第 22 轮审核：AXOpen 预检的请求构造（`35b74fb..4638f51`）

## 结论

接受 `4638f51`。用户报告在重建的测试版上完成了打开文件和打开文件夹的验证，结果通过；细节待补（见末尾）。

## 真机暴露的缺陷

在 `35b74fb` 测试版上的第一次尝试：用户在确认卡上选了“允许一次”，helper 却在 AXOpen 之前以 `open_target_changed` 拒绝，测试 B 随之停止。

原因是请求构造：`src/tools/act-request.ts` 把 `open` 和不带参数的语义动作合在一起，只序列化了投递方式，丢掉了 bridge 放进去的
`openTarget` 和 `openApproved`。helper 收不到预检信息，只能拒绝，所以文件和文件夹都会失败。这是传参缺陷，与 Finder 或权限无关。

各段测试分别通过，但构包测试没带预检字段，原生 fixture 又是手工拼的字段，中间这一段从没有被串起来测过。这和 REVIEW-16 的 `displayName`、
REVIEW-17 的定时器属于同一类：单元边界都对，接缝处断了。

## 修复

- `open` 单独构造请求，显式保留 `openTarget`、`openApproved` 和投递信息；其他动作的参数白名单不变。
- `PlatformActRequest` 为 `open` 加上对应类型，没有用 `any` 掩盖。
- 新的回归把实际的 `prepareAction → buildActRequest` 输出写成 JSON，交给含真实原生 `open` 分支的 Swift fixture 读取，覆盖目录、文件、程序包、
  未知类型乘以“是否确认”共 8 组。修复前 4 项中 2 项失败（字段断言失败，原生 fixture 真实返回 `open_target_changed`）。
- 协议号测试改为与 `HELPER_PROTOCOL_VERSION` 常量比对，R1 关闭。

## 审核者复现

298 项，293 通过、2 失败、3 跳过。两个失败与本次改动无关：一个是已知的并行偶发用例（两个客户端同时拉起 broker；执行方串行运行时通过），
一个是审核容器没有安装 TypeScript。dry run 38 项、0 失败、3 跳过；当前文件树审计 PASS 0。

## 流程

REVIEW-21 预先批准“只改测试断言就可以直接重建”。这次提交同时修了产品代码，按约定应先送审再重建。考虑到修复是真机测试直接暴露的、改动很小，
而且由用户在场主导验证，审核者事后接受；约定本身不变。

## 待补

用户报告“验证通过”。请补充测试 A（打开文件）这次是否选择了“拒绝”、拒绝后是否零派发（`dispatch=not_started`、没有新 App 切到前台），
以及测试 B（打开文件夹）的读回结果和前台情况，写进执行方的 STATUS 记录。
