# Computer Use v2.1 · 0.2.0 最终产物验收：blocked

日期：2026-11-12。环境：Mac、Node 24.18.0、npm 12.2.0。

> 本文保留首次验收失败的历史事实。后续结果与用户批准的两步签名边界见 [STATUS-7](STATUS-7-artifact-acceptance.md)。

**结论：最终 tgz 已构建，但发布验收未通过。不得发布，也未生成发布交接命令。**

## 来源与构建次数

- 唯一构建源仍为 `8e1fe0c50273f50926709324c38d1c7dadbdfd25`；`ab7d49a` 作废。
- [REVIEW-29](REVIEW-29.md) cherry-pick 为 `31165ba7d0d138f0d9597f380e414bb943e082cb`，仅放在独立审核分支；没有带入构建 clone，没有推到 main。
- 首次 npm 调用在配置初始化阶段失败：执行方误将 user/global npm 配置都指向 `/dev/null`。没有 tgz，没有自动重跑。
- 用户另行授权一次尝试后，改用两份不同路径的空 npm 配置。只继承标准代理路由变量，隔离 HOME/cache；PATH 没有全局 Pi。
- 从干净的固定提交成功执行一次 `npm run pack:release -- <绝对产物目录>`，exit 0。之后没有再次打包。
- 产物内 `build-info.json`：commit 为上述完整 SHA，`dirty: false`、`allowDirty: false`，`builtAt: 2026-11-12T13:36:57.613Z`。
- 产物目录在仓库与隔离 HOME 之外。验收后冻结 clone 的 tracked tree 仍干净。

## 唯一产物

文件：`bingjiang0611-rotom-0.2.0.tgz`。

| 项目 | 结果 | 证据 |
|---|---|---|
| 普通文件数 | 19,049 | 实际 tar 成员清单 |
| 压缩大小 | 34,088,284 bytes | 实际 tgz 字节数 |
| 解包文件大小 | 147,162,933 bytes | 普通文件成员大小之和 |
| SHA-256 | `636dc80bd2466d6823d5efdd7ac0a34897adebf9b31c61bb9bdbdbedac980d9e` | 构建后与清理前回读一致 |
| SHA-1 / npm shasum | `128c9febea7fa3c812839c37dc5c93122d5d904b` | 实际 tgz |
| SRI | `sha512-BgoZK+ITxR2C3hwxTS512udGddvfWdYQzI1JTR1i1ehQb6Icqp5fJkXFnx26TZkzC+L9A/wXYTkjEnF+e6hGMg==` | 实际 tgz |

## 已完成的检查

| 检查 | 结果 | 证据与范围 |
|---|---|---|
| 构建前 registry 查询 | 0.2.0 返回 HTTP 404 | 只读；不是发布前的永久授权或状态保证 |
| 实际 tgz 审计 | PASS，0 findings | `audit-public.py --artifact`；审计报告 19,050 个扫描项，扫描项不等于 tar 普通文件数 |
| 隔离安装与升级 | PASS | 独立 HOME/prefix 安装公开 0.1.27，再安装本次最终 tgz；`rotom --version` 从 0.1.27 变为 0.2.0 |
| 安装字节核对 | PASS | 19,049 个普通文件逐个与 tgz 字节摘要匹配；不是只核对 package version |
| default public-runtime smoke | PASS | 验证器来自冻结维护源码，Pi executable 与 product root 均指向实际 node_modules 安装；26 个 active tools，0 lifecycle errors |
| full public-runtime smoke | PASS | 同一实际安装，`ROTOM_DEFERRED_TOOLS=0`；33 个 active tools，0 lifecycle errors |
| 隔离安装卸载与清理 | PASS | `npm uninstall --global --ignore-scripts --offline`；确认 bin/package 已不存在，再删除本次 HOME/cache |
| 日常 helper 保护 | PASS | 只读回验二进制 SHA-256、PID、启动时间与操作前完全一致；未更新、停止或重启它 |

首次 smoke 因干净维护 clone 缺少 `typebox` 而未启动。按锁文件补齐维护面的 third-party/Pi 依赖后通过；没有更改源码或最终 tgz。以上 smoke 是实际安装的 SDK/loader 验证，使用假 Provider，不是原生 helper 启动或真实 GUI 任务验收。

## 阻断一：check-personal 未通过

`check-personal` 是维护面测试入口，不随产品打包。本次在冻结维护源码运行，并将 `ROTOM_PI` 指向最终 tgz 的实际安装；没有把维护面测试称为 node_modules 内存在的产品命令。

1. 首次完整运行传入了给原生验收准备的 helper/broker 路径覆盖，1800 秒未结束，没有完整测试汇总，不能报 PASS。
2. 对第三方组合测试做只读句柄诊断：断言输出后仍存在 PipeWrap；有界诊断运行也未结束。该证据不足以独立确定生命周期缺陷的根因。
3. 去掉三个额外路径覆盖变量，对同一 `rotom/extensions/third-party/index.test.ts` 定向运行，24/24 通过，约 8.55 秒。没有修改、删除或跳过测试。
4. 随后标准隔离环境下的完整 `check-personal` 仍未通过，900 秒等待超时，日志含以下失败记录：
   - `rotom/extensions/browser/ownership.test.mjs`：`real full-read loop start, overlap and restoration evidence: nonoverlapping-jump`，约 47.63 秒。
   - `rotom/extensions/context-layers/index.test.ts`：整文件失败记录，约 394.38 秒。

最后一次运行没有完整终态汇总，不能推算全套通过数量或错误原因。定向对照通过不证明完整 gate 已修复，也不能把全部失败归因于路径覆盖、资源压力或某个产品缺陷。签名硬门禁触发后没有继续循环测试、放宽 timeout、改断言或修改冻结源。后续 Provider/Goal 等阶段没有本次完整 gate 的通过证据，旧版本结果不补位。

## 阻断二：隔离环境不可见签名身份

在隔离 HOME 下只读执行：

```text
security find-identity -v -p codesigning
     0 valid identities found
```

与日常 helper 的既有 Apple Development 签名作元数据比对，匹配身份数为 0。按用户硬门禁立即停止。没有尝试改变 HOME/搜索列表、复制钥匙串、导出私钥、创建证书或改用另一身份。

**未执行 `rotom helper update`、codesign 签名或原生 helper 启动。** 因此前置身份不可见，不是端点安全已杀死新 helper 的证据；协议 11、隔离 PID/可执行路径均未获得真实 diagnostics 验收。L2 0 成功 / 5 失败、pid 无真实成功、B1–B6 未通过的既有边界不变。

## 留存与清理

- tgz、摘要、完整构建/验收日志和一次尝试标记保留在本机仓库外；原始本机路径、签名身份元数据不进 Git。
- 证据文件包括 `artifact-metadata.json`、`artifact-inventory.json`、`artifact-audit.json`、`attempt-2/pack-result.json`，以及验收目录内的 `installed-byte-verification.json`、两套 smoke 日志、两次完整 check-personal 日志、定向对照日志、`signing-preflight.json` 和 `cleanup.json`。
- 清理前核对本次 HOME/cache 没有打开文件与残留 socket；没有创建独立 helper app。卸载后删除本次构建与验收 HOME/cache，证据和 tgz 不在这些目录中。
- 没有执行 npm login、whoami、publish，没有更新日常安装，没有创建 release tag；没有删除候选分支。

## 需要审核者与用户处理

1. 审核者先评估完整 check-personal 的失败与超时证据，确定下一轮定向诊断；不能拿 24/24 代替完整 gate。任何影响产品内容的修复均须重新冻结、审核，不能沿用这个 tgz。
2. 用户确认已有 Apple Development 身份在隔离签名场景中不可见的处理方式，并明确授权后续动作；执行方不得自行调整钥匙串或换路径尝试。
3. 两个阻断解除并补齐[冻结清单](../../releases/0.2.0-freeze.md)全部验收后，才允许生成 handoff 命令供审核。当前没有可交给用户执行的发布命令。
