# 第十一批：独立 Linux 真进程与类型门补正

**仍是隔离候选，不是已采用的产品。** 用户在第十批后明确授权新建独立验证 VM；未修改旧 VM、切换 installed `.2`、迁移会话、推送或调用付费模型。唯一发行身份、archive/lock/integrity 与新产品会话接入仍待完成，见[采用合同](../../../docs/agent/subagent-external-adoption-contract.md)。

## 环境和输入

- 独立 Colima profile `rotom-owned-verify`，VZ / arm64 / 2 CPU / 4 GiB RAM / 20 GiB root disk；Ubuntu 24.04.4、Linux 6.8.0-117-generic。
- 唯一挂载为私有测试目录的只读 share；无默认 HOME 挂载、SSH agent forwarding、自动 Docker context 切换或旧磁盘修复。测试复制到 guest-native 文件系统执行，不在共享盘上模拟 Linux。
- Node 24.18.0 Linux arm64，官方 tarball SHA256 `58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6`。公开 Pi 0.85.1 经过原有 executable/package/public-exports gate。
- 从 `1b4dcd6` 的选定 tracked 文件构建 bundle，不复制 Git history、维护者 node_modules、HOME 或运行时状态。Pi 使用该提交的 shrinkwrap；Subagent 测试安装只取原锁中的 `.2` 和 acorn/jiti/typebox/yaml，保留版本与 integrity。全部 `npm ci --ignore-scripts --no-audit --no-fund`，空白独立 npmrc/HOME/cache；只在安装时保留 VM 已有网络代理。
- 基础 bundle SHA256 `3f602e1a5cca623ee921f1cb302c49efba21bb19af58425b495bb93331974d22`；两文件测试补充包 `1e7907ea074bd721dd91c45e1140eeef2387ec6f9c0ee93fb289005ff548bf7b`；类型工具输入包 `a4e0d21e7f226f09628f899fb48898d4c697aff67e919628e653d1026e0d0165`。实际归档隐私审计分别通过；仍只是启发式扫描，不保证任意秘密或代码所有权。

## 实际结果

| Gate | Linux 结果 |
|---|---|
| 同一 flat source 综合回归 | **228/228，零 skip** |
| 第五至九层独立重建 SDK | **10/10**，不是用 flat source 冒充历史层 |
| 固定上游 unit | **188 pass / 2 skip**：Windows-only 与无原生 start probe 平台用例；Linux 有 `/proc` 原生 probe |
| 调整过 readiness 的上游 single integration | **219/219**；与第十批同一固定上游及两项事件驱动 readiness 修正，原断言保留 |
| 精确候选类型门 | **213 个实际 TS 文件**，TypeScript 5.9.3 / `@types/node` 22.19.19，strict/noEmit/noUncheckedIndexedAccess 通过 |
| 类型门自身回归 | **2/2**：installed source 拒绝、陈旧 include 不能掩盖真实候选类型错误 |
| installed seed integrity | `.2` 归档中的 **209 TS byte-identical** |

公开 SDK 包括 30 direct + 24 workflow 拒绝，正面对照前零 writer/faux 调用、拒绝后零占槽；公开 single 保持真实 runner 身份；完整 15 项正负矩阵包括 native resume、mixed/foreground workflow、stop/timeout、三种强关管道 escape、opaque lease 和 owner loss。真实 controller SIGKILL 后重新执行公开 init 仍保留未封存占槽。实际 Markdown agent 与 ambient-extension 对照通过，远端模型调用为零。

Linux 与 macOS 当前候选的 213 TS 内容摘要相同：`5fea0391a0b4ecbd95d88680330224256bdfb2865c0d3cc9fd3980c5f1defa04`（排序的相对路径/NUL/内容/NUL）。这是源码与编译范围证据，不是发行包 identity。

## 失败和更正，不抹掉历史

1. VM 没有 `xz` 命令，第一次解包失败；保留已校验下载，使用 Python 标准库 xz reader 解包，没有重下或修改旧 VM。第一次 npm 安装清空环境后失去必要代理，报 `EAI_AGAIN`；确认无存活安装进程、代理连接可用后，仅安装环境恢复已有代理，随后按锁安装成功。测试仍隔离环境、阻断模型网络。
2. 首轮 Linux **223/228**。三例因私有 bundle 漏掉动态导入的 `subagent-policy.ts`，driver 保留明确 module-not-found；补入 pinned 文件。两例新建替换目录继承 Linux umask，实际为 `0775`，先命中目录权限拒绝而非预期 inode drift；测试显式使用 `0700`，保留原失败断言和 runtime fail-closed 行为。未改候选运行时代码。macOS 受影响 store 回归亦 **36/36**。
3. 复核发现第九、第十批临时 tsconfig 的 include 仍指向第八层。**撤回这两批原先“完整当前候选类型通过”的证据归属**。新增 `fixtures/typecheck-owned-candidate.mjs` 从传入的确切 source 生成显式文件列表，并将 `--listFilesOnly` 与实际输入逐一比对；不复用旧 tsconfig，只按公开 package types 合同解析 Pi。补跑 macOS 第九层及第十层，各 213 TS 通过；Linux 第十层 213 TS 通过。第九层内容摘要为 `3d140ec741de25cd8c5396baae85f37bc78714d27056c8af6e225835299d5f51`。新增回归同时在 macOS/Linux **2/2**。
4. 首轮综合 log 被重跑覆盖，不能再以该文件声称保留了初跑记录；初跑结果来自当时 tool output，具体失败 driver/probe 仍保留。后续 runner 在重跑前复制旧 log。先前 macOS 未归因波动也不因 Linux PASS 而被解释或消除。

## 复验入口

在独立、完整的测试布局与已验证公开 Pi 下，使用各层原有 preparer；上游由 `prepare-flat-upstream.mjs` 核验固定 preimage 并准备。综合、历史 SDK 和上游测试的命令分组沿用第十批，全部 `--test-concurrency=1`，不并行挤压两核 VM。

```sh
ROTOM_PI=/absolute/verified/pi \
  node rotom/extensions/third-party/fixtures/typecheck-owned-candidate.mjs \
  /absolute/current/candidate /absolute/compiler-root
# compiler-root/node_modules: locked typescript + @types/node + undici-types
ROTOM_PI=/absolute/verified/pi ROTOM_TYPECHECK_COMPILER_ROOT=/absolute/compiler-root \
  node --test --test-concurrency=1 \
  rotom/extensions/third-party/history/subagent-owned-typecheck.test.mjs
```

私有 guest evidence 位于验证根的 `combined.log`、`historical.log`、`upstream-unit.log`、`upstream-integration.log` 与 `rotom-owned-types-*`；主机留有对应只读导出及本次补跑日志。它们是测试材料，不进入产品包。Linux gate 完成不授权重放 unknown 工作，也不将 `.2` 同名私有 pack 变成可安装候选。
