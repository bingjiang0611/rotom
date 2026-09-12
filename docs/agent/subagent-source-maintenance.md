# Subagent 源码内化：第一阶段交付

> 本页保留首阶段的安装状态与历史证据。后续已完成默认组件接入，组件接入记录见 [默认接入](subagent-default-integration.md)，当前 scope 见 [scoped 默认](subagent-owned-default.md)；首阶段“不切换安装”不再代表新启动入口。

**已实现源码内化与独立构建维护，不自动切换当前产品安装。** 开发单源是 [`packages/rotom-subagents`](../../packages/rotom-subagents/README.md)，不是 `node_modules`，也不再由八层 patch 生成新实现。原 patches/归档保留为历史对照（部分旧 revision 仅在私有维护仓中，不保证公开仓库可复现）；不自动跟随上游。

## 所有权与边界

- 私有包版本 `pi-subagents@0.52.1-rotom.0`；目录名为 rotom-subagents，保留 npm/internal/resource/protocol ID，避免无关迁移。
- 来源是已通过两平台验证的 `.owned-flat.7`。原 248 文件清单/hash、MIT 许可证及 Nico Bailon 版权留在 `IMPORT.json` / `LICENSE` / `UPSTREAM.md`；原 README 单独保留。
- **213 个 TS 及原有四个顶层 mjs 与导入逐字节相同**。本次改变源码维护面、package metadata、文档、构建/测试入口，不同时裁剪或重写运行行为，不 fork Pi。
- 固定四个运行依赖和独立 lockfile；开发公开 Pi 0.85.1、TS 5.9.3、Node types 22.19.19。测试默认解析本组件的公开 Pi 安装，不用 PATH/global Pi 或旁边 checkout。
- 当前 `rotom` manifest/lock/product-config、维护 vendor 和 installed source 仍为原固定安装，未被这次提交升级。运行源码修改必须经过新打包/独立产品构建和验收，不能热改活跃安装。
- 当前 rotom 的 retired tools、scope、unknown/replay、lease 与会话迁移边界继续有效；源码包含上游旧能力不代表产品启用。

## 新维护入口

在 `packages/rotom-subagents` 内：

| 命令 | 范围 |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | 按独立锁安装开发/运行依赖 |
| `npm test` | 维护合同、实际离线打包、路径/receipt 拒绝、19 项 wait/drain |
| `npm run test:sdk` | 本源码快照的三组真实进程/local faux 验收 |
| `npm run test:compat` | 指向本源码的历史 reader/lease/lifeline 等兼容检查 |
| `npm run typecheck` | 显式枚举当前 TS，核对 `--listFilesOnly` 后 strict/noEmit |
| `npm run test:all` | 上述四组；无真实模型授权 |
| `npm run pack:release -- /absolute/private/out` | 白名单源码 → audited tgz + digest/integrity receipt，不覆盖产物 |
| `npm run stage:product -- ...` | committed 产品 snapshot 中同步包/lock/archive/config；不修改当前安装 |
| `npm run test:product -- /absolute/prefix /absolute/private/evidence` | 实际 npm bin 的六种 loopback SSE 场景 |

完整可执行示例见组件 README。测试快照的源码直接来自本目录；只为测试复制四个已锁定依赖。发行包不复制开发 node_modules，不包含维护脚本/tests/旧 patch/运行状态。历史对照仍可重建旧版本，但它们不是新组件的构建输入。

产品 staging 工具要求新私有目录，读固定 Git revision，不混入 dirty WIP；核对实际 archive SHA512、TS digest 与 receipt，再同步新副本的 package、lock/shrinkwrap、vendor、product-config。仍沿用产品 `pack:release` 的隔离 HOME/cache、fresh install、实际 tgz 审计及 runtime gate，不复制 Pi 生命周期。

## 实际验证

源码摘要（213 TS）两平台均为：

`d01b37e59e17abb0f95e5d123ba59d33f903e5176fb29fb9f798373477c77826`

| 门禁 | macOS | 独立 Linux VM |
|---|---:|---:|
| 组件 unit / pack / wait | 26/26 | 26/26 |
| 组件 SDK（当前源快照） | 3/3 | 3/3 |
| 历史兼容（当前源作为 candidate） | 225/225 | 225/225 |
| 当前真实输入集 strict/noEmit | PASS | PASS |
| 新身份实际 npm bin 六场景 | PASS | PASS |

实际入口覆盖 immediate wait、persistent parent、headless drain、deferred search、native resume、flat mixed + foreground。SDK 覆盖 pre-writer 拒绝、lost controller、ack 不解锁、controlled closure/unknown、native lease、stop/timeout/三类 pipe escape。全部是本地进程或 synthetic 状态与 local faux/SSE，不是远端模型或真实业务效果验证。

macOS 另运行实际新产品的 default/full runtime smoke 和 distribution/runtime **48/48**；隔离 prefix `.owned-flat.7`→`0.1.0-rotom-subagents.0` 升级、`rotom --version`、read-only store inspect、卸载通过，安装外 store marker SHA256 不变。这不是存活 session 升级/迁移。

Privacy auditor **10/10**。内化源码 tar 初次因已知上游配置样例的路径变化被扫描器拒绝；原样例字节保持不变，仅增加该维护位置的**原有行 SHA256 + 路径**匹配，错误路径或改过的个人路径仍报告。私有 VM 副本当次已传入；最终同一源码归档重扫 PASS。没有对外上传或用删改版权/上游示例消除告警。

首次 staged diff 检查发现原始五个文件的十处 trailing blanks。为保持已验证 import 的字节一致，只给这些文件增加 `blank-at-eol` 的局部 Git 属性例外，其余 whitespace 检查继续生效；以后有意规范化对应文件时移除例外，不对整棵源码关闭检查。

其他保留的开发失败：第一次组件 resolver 使用 CJS `require.resolve`，公开 Pi 仅导出 ESM，遂改为公开 `import.meta.resolve`；首次 compat 和产品 fixture 因旧版本硬编码拒绝新身份，增加显式维护测试版本通道并保留 legacy 默认约束，未给 runtime 放宽 identity gate。最终所有对应检查重跑通过，日志没有覆盖失败记录。

## 产物与证据

当前私有产品基线 Git revision：`8fdfcfc452ec140926ebc3511d8c07a2c3ef3635`，不含并行 Qoder WIP。

- Component：`pi-subagents-0.52.1-rotom.0.tgz`，984124 bytes / 250 files。
  - SHA256：`c158071589811e5550cea7cd6dcee2b756372fd6c39601e3cca9664f9175cd71`
  - SHA512 integrity：`sha512-Ga0COYoHd7ln5TCEd9ZSEs72GaaU9N869RhTUGvsq66YDg2v7AtHNHKbKJEa2gKpTDDDSxdqN8mpEcDf6rdqhQ==`
- Product：`rotom-0.1.0-rotom-subagents.0.tgz`，9362558 bytes / 3805 files。
  - SHA256：`1781b05da57d3c7db77618de969cb08c59105260f925c1620439b4690dcf028a`
  - SHA512 integrity：`sha512-YXtH6ux0pfHpEjh1Un79xpFYDLTq7iu0/VXTM3piehculcfC7CWiUhfBKKeh39KQLd9kiNIcI6JKBqK0t+8WLA==`

两份实际 tgz 审计通过，保持 private，未发布。另一次独立 staging 重打组件 tgz 与首份逐字节相同；Git index 中的 217 个运行文件也与原始 import 摘要一致。`/tmp/rotom-internalize-root` 指向本机私有证据根，包含 `out/`、`unit-final3.log`、`sdk-final2.log`、`compat-final.log`、`types-final.log`、`stage-final.log`、`product-test-final.log`、`product-smoke-{0,1}.log`、`product-contract.log`、`upgrade-*.log`、`audit-final.log` 与失败日志。Linux 原件在独立 profile `rotom-owned-verify` 的 `owned-validation/internalized-*.log`；未变更旧默认 VM、HOME mount 或 Docker context。

后续直接修改组件源码，补测试、显式升私有版本、构建/验证新产物；上游只人工挑选必要修复。默认安装切换、存活会话迁移、公开发布、真实远端模型/业务效果不在本次交付内。
