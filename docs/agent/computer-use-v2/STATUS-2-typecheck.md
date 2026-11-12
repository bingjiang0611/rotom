# Computer Use v2.1：T1 类型检查恢复

> 本页保留该轮历史记录。当前 S2 已恢复完整类型门禁，见 [HANDOFF-6 阶段 1](STATUS-3-typecheck.md)；此前 O1/S2 的分段实现见 [打开目标确认与测试闸门](STATUS-2-open-target-guard.md)。

## 范围与环境

- 基于 `cbfac06`（含 `024d058` 的 observe_ui 修复），按 REVIEW-16 执行。
- 仅代码和离线测试；独立开发 checkout 复用测试 checkout 的产品依赖副本，安装开发依赖时使用 `--ignore-scripts`。没有改活跃安装、重建/重启 helper 或调用桌面工具。
- Node `24.18.0`、TypeScript `7.0.2`、`@types/node 26.6.6`。
- 新增包级 `tsconfig.json`：NodeNext ESM、ES2024、strict、noEmit、allowImportingTsExtensions。包含 `src/**/*.ts`、`extensions/**/*.ts`、`test/**/*.ts`；不声称检查了原生代码或所有 JavaScript 脚本。
- Pi peers 与 TypeBox 的声明从 checkout 的产品安装目录解析；开发依赖仍按本包 package.json 安装。检查产品声明使用 skipLibCheck，不屏蔽本包错误。

## 本轮修复

1. 默认 scheduler 的运行时值是对象，BrokerCore 与 LeaseManager 却按函数调用。统一成与调用方、fake clock 一致的函数合同；保留取消与 unref 行为。
2. 删除无调用方的 `ClientLeaseBroker.reportPreempted`：它转发到已不存在的 `BrokerClient.reportPreempted`。不恢复旧的用户输入即结束接管协议，也不改变现有暂停/恢复路径。
3. `pretest: npm run typecheck` 接入 npm 测试闸门。没有错误码白名单、忽略退出码或放宽 strict；残余错误清零前，`npm test` 会在执行测试体前失败。冻结前必须运行该闸门，当前不是可冻结的全绿状态。

## 验证

| 检查 | 结果 |
| --- | --- |
| 默认 scheduler 新回归（修复前） | 2/2 失败，分别为 realSchedule / this.schedule is not a function |
| scheduler、broker-core、broker-approval、outline-render、outline-secure focused tests | 20/20 通过；直接 node 执行，仅证明这些测试，不冒充 npm test 闸门通过 |
| typecheck 负对照 | 在独立开发副本临时移除 displayName 导入，确实报 TS2304；随后恢复，未变更该已审核修复 |
| npm run typecheck -- --pretty false | 非零退出；157 项降至 147 项 |
| 名字/模块/导出不存在及不可调用错误 | 当前 TS 程序中为 0；TS7016 是已有 .mjs 缺声明，不是模块文件不存在 |
| npm test | pretest 实际执行 tsc，147 项错误使闸门拒绝，未执行测试体 |

复现 focused tests（在 `packages/rotom-computer-use/`）：

```sh
node --test --experimental-strip-types test/broker-real-schedule.test.ts test/broker-core.test.ts test/broker-approval.test.ts test/outline-render.test.ts test/outline-secure.test.ts
npm run typecheck -- --pretty false
npm test
```

## 剩余类型错误（本轮不修）

以下是本轮环境下完整的 147 项诊断清单。错误码按编译器原值汇总，不将类型错误都等同于运行时故障。
后续由维护者/审核者分轮处理，并重新运行完整 typecheck；本轮不加 any、ts-ignore 或排除文件来消除它们。

| 错误码 | 数量 |
| --- | ---: |
| TS18046 | 21 |
| TS18048 | 1 |
| TS2322 | 3 |
| TS2339 | 4 |
| TS2353 | 64 |
| TS2365 | 2 |
| TS2366 | 1 |
| TS7005 | 4 |
| TS7006 | 21 |
| TS7016 | 16 |
| TS7019 | 1 |
| TS7031 | 6 |
| TS7034 | 3 |
| 合计 | 147 |

完整历史诊断按路径分组保留，正文未修改：

- [实现诊断](STATUS-2-typecheck-runtime.md)
- [测试诊断](STATUS-2-typecheck-tests.md)
