# Computer Use v2.1 第 17 轮审核：`observe_ui` 修复、类型检查恢复（`c5376b7..d4acbd3`）

## 结论

接受 `024d058`、`cbfac06`、`d4acbd3`。**可以从 `d4acbd3` 重建测试版**，让用户继续手动测试。类型检查闸门的接法要调整（S2），
放在下一轮代码里做，不挡这次重建。

## 审核者复现

- 干净 worktree 用 `node --test` 直接跑（绕开 `pretest`）2 次：274 项，273 通过、0 失败、1 跳过；dry run 38 项、0 失败、3 跳过。
- 当前文件树公开审计：**PASS，0 项**（`STATUS-2-testmachine.md` 的路径已改成 `~`）。三个提交的作者和提交者都是 GitHub noreply。

## 接受的部分

- `024d058`：`lookup.ts` 导出 `displayName`，`render.ts` 导入；新增渲染、折叠、展开的测试。
- `d4acbd3` 补上 `tsconfig.json`（NodeNext、ES2024、strict、noEmit、`allowImportingTsExtensions`，peer 依赖从产品安装目录解析）。
  负对照有效：删掉 `displayName` 导入，`tsc` 报 TS2304。

## S1（高，已修）：真实 broker 的授权卡片超时会抛错

类型检查查出的第二个运行时缺陷，比 `displayName` 更隐蔽：

- `leases.ts` 把默认的 `realSchedule` 定义成**带 `schedule` 方法的对象**，`core.ts` 却把它当**函数**调用
  （`this.schedule(() => this.settleApproval(requestId, "timeout"), ...)`）。真实 broker 一旦需要弹授权卡片，设置超时这一步就抛
  “`this.schedule` is not a function”。
- 由 `57225fa`（2026-11-04，v2 M3“App 授权、分级、高危确认与宿主排除”）引入。**`main` 上的源码同样有这个缺陷**；`main` 的产品归档仍是 10-25 的旧版，
  用户实际使用的版本不受影响。
- 所有 broker 测试都注入了函数形式的 `clock.schedule`，把问题盖住了。新增的 `broker-real-schedule.test.ts` 不注入、直接走默认定时器，修复前 2/2 失败。
- 修法（统一成函数类型）接受。删除的 `ClientLeaseBroker.reportPreempted` 没有调用方，转发目标在 HANDOFF-5 中已删除，接受。

## S2（中，下一轮）：闸门不能一直是红的

`d4acbd3` 把完整 `typecheck` 接进了 `pretest`，而剩余 147 个类型错误没修，所以 `npm test` 现在一定失败、根本不跑测试。
一个永远红的闸门会被所有人习惯性忽略，等于没有闸门。

审核者抽查了剩余错误：主要是未标注类型的参数（TS7006 等）、测试里对象字面量的多余字段（TS2353）、`.mjs` 缺类型声明（TS7016）；
“属性不存在”（TS2339）都在测试文件里；`recorder.ts` 的 `number | bigint` 运算来自 `ReturnType<typeof statSync>` 的类型推断，
运行时 `statSync` 不带 `bigint` 选项，拿到的是普通数字，不会出错。没有发现其他会在运行时直接报错的问题。

修法：

1. 新增 `typecheck:fatal`：运行 `tsc`，只要出现会在运行时直接出错的类别就失败——找不到名字（TS2304、TS2552）、找不到模块或导出
   （TS2305、TS2307、TS2614、TS2724）、不可调用（TS2349）、以及 `src/` 和 `extensions/` 里的属性不存在（TS2339、TS2551）。
   `pretest` 改用它。
2. 完整的 `typecheck` 保留，作为信息输出；147 项另起一轮清零，清零后再把 `pretest` 换回完整检查。
3. 顺手把 `statSafe` 的返回类型改成 `Stats | undefined`。

## 下一步

1. 执行方从 `d4acbd3` 重建测试版：按 REVIEW-15 批准的方案和“更正”一节，仍用产品原本身份 `com.injaneity.pi-computer-use`、
   同一张证书、独立路径、独立 socket，不覆盖现有安装和日常 helper；只启动一次，被端点安全终止就停。
2. 用户继续手动测试，把用法和结果发给审核者。
3. S2 放在下一轮代码里做。
