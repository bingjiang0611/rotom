# HANDOFF-6 阶段 1：完整类型门禁

范围：按审核分支 `56e87e9` 的 HANDOFF-6，先交付 S2；推送后等待审核，再进入阶段 2。基线为 `4638f51a`。

## 改动

- 完整 `npm run typecheck` 从 144 项错误降为 0；`pretest` 恢复为 `npm run typecheck`。`typecheck:fatal` 留作旧诊断工具，不再是测试或交付门禁。
- Broker 请求按 discriminant 分发后再省略 id，保留各分支字段；补齐已有响应、PolicyGate、macOS backend 的声明，移除已不需要的请求断言。
- 收窄语义动作参数，声明既有 Set.has 的类型谓词；修正实际会新增文本块的 evidence result 返回类型，以及 Node 定时器的上下文类型。
- 测试补充真实 fixture 类型、存在性/分支断言；原断言保留，不删除或跳过验收。
- `allowJs` 让 TypeScript 从实际导入的 mjs 推断模块合同，并在原模块上补充 JSDoc。没有新增宽泛的 ambient module/any，也没有降低 strict 或排除 TS 文件。mjs 函数体仍不启用 checkJs；这不是宣称整个 JavaScript 脚本库已通过严格静态检查。
- 删除两个因 mjs 现在可解析而失效的旧 `@ts-expect-error`；新增的三个指令仅用于编译期负例，要求非法请求确实产生类型错误，不用于屏蔽债务。

## 回归与行为边界

`test/typecheck-pretest.test.ts` 在临时项目运行实际 npm pretest：TS2322 必须失败，修正 fixture 后必须通过。它同时锁定完整门禁，防止退回只过滤 fatal 的检查。

`test/type-contracts.ts` 随 pretest 编译，不执行动作；验证请求必填字段、请求分支隔离、批准值必须为 boolean，以及语义动作的正反分支收窄。

本轮对 14 个有改动的生产 TS/MJS 文件做类型擦除后的可执行 AST 对照：与 `4638f51a` 一致；在内存中改变一个运行时字面量，负对照能够发现差异。比较忽略注释、源码位置和字面量 raw 拼写，没有忽略可执行节点。类型改动不改变业务逻辑；未发现必须修改运行时逻辑才能消除的缺陷。这不证明原系统不存在其他缺陷。

## 终验与交付约束

最后一次改动后执行以下门禁，最终结果与推送 SHA 由本阶段交付报告给出：

```bash
cd packages/rotom-computer-use
npm test
node scripts/cu-v2-script-dry-run.mjs
```

另在仓库根运行产品/Ask/分发测试与 `python3 scripts/audit-public.py --root .`，重跑上述 AST 对照。dry run 只使用 fake backend；其中明确跳过的真实桌面、设备和投递项不算通过。

阶段 1 不重建归档、不改版本/lock/product-config、不启动或替换 helper、不改证书、不合并 main、不发布。阶段 2 待审核通过后，先完成签名与安装路径的只读调查并另记 STATUS，再按 UPSTREAM.md 打包。
