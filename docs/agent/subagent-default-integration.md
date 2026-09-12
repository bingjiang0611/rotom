# Subagent 默认接入

> **历史接入记录**：本文记录 `alpha.1`。后续 `alpha.2` 使用个人 wrapper，`alpha.3` 起由发行包 launcher 默认启用 owned scope；当前入口与限制见 [默认启用 owned scope](subagent-owned-default.md)。下文的 PATH、安装版本与文件摘要仅指该批验证，不是当前机器状态；最新产品版本以 `rotom/package.json` 为准。

## 当前状态

`rotom@0.1.0-alpha.1` 默认选择内化组件 **`pi-subagents@0.52.1-rotom.0`**。产品 manifest、shrinkwrap、第三方 manifest/lock、vendor archive、runtime version/integrity/requiredFiles 与 notices 已同步。组件源码未改，仍是已验证的 213 TS + 4 mjs；不动态加载维护源码，也不自动同步上游。

**组件默认接入不等于启用 owned scope。** `PI_SUBAGENTS_EXECUTION_SCOPE` 没有新增默认赋值；`owned-process-groups-v2` 仍要求新进程显式 opt-in 和新 store。未知 descendant/business effect、恢复/重放和旧会话迁移边界不变。

## 本机入口：旁路安装而非原地覆盖

- 新安装：`~/.local/share/rotom/releases/0.1.0-alpha.1/`，包含实际 tgz、npm 安装和 `activation-{intent,verified}.json`。
- 当前 Node 24.18.0 PATH 下的 `rotom` 命令链接已原子切到该安装的 `node_modules/rotom/bin/rotom`。
- 原全局 npm 包目录没有改名、替换或删除；维护树原 `node_modules` 也保留，6238 个旧运行/metadata 文件前后 SHA256 一致。既有进程仍使用原路径；不迁移 session、store 或浏览器绑定。
- **新开 `rotom` 使用新版；当前存活会话不会自动升级，不要通过 reload 混用两版。** `rotom --version` 显示 Pi 的 `0.85.1`；产品与组件版本需看上述安装目录里的 package.json。
- `npm ls -g rotom` 仍可能显示保留的旧全局包，因为新默认是独立 prefix。后续 `npm install -g`、`npm uninstall -g` 或切换 NVM 版本可能重新接管/改变命令链接，需重新确认 `command -v rotom` 及其 realpath。
- 维护工作树旧安装刻意不覆盖，所以不能用旧 `node_modules` 假装已测试新默认。源码直接启动前需在**无存活会话的新 checkout/prefix** 按新锁安装；`pack:release` 自身从新目录安装依赖，不依赖维护树的旧安装。

可只读核对（不会启动模型）：

```sh
command -v rotom
rotom --version
node -p 'require(process.env.HOME + "/.local/share/rotom/releases/0.1.0-alpha.1/node_modules/rotom/package.json").version'
node -p 'require(process.env.HOME + "/.local/share/rotom/releases/0.1.0-alpha.1/node_modules/rotom/extensions/third-party/node_modules/pi-subagents/package.json").version'
```

显式 `ROTOM_PI` / `ROTOM_NODE` 覆盖仍优先，不替用户修改 shell 配置。链接切换或切回旧版都不构成未知执行的恢复授权；不要自动回放原任务。

## 门禁与实际证据

产品基于已提交的 `4c8e31f` 及本次明确的接入文件构建；不包含随后并行出现的 Qoder probe WIP。Subagent 输入是首次内化的同一不可变归档，SHA256 为：

`c158071589811e5550cea7cd6dcee2b756372fd6c39601e3cca9664f9175cd71`

本次产品 `rotom-0.1.0-alpha.1.tgz`：9364759 bytes / 3805 files。

- SHA256：`942a7e660b64484d8a06e17aa30c3ccd4fdf606bb0b8e15fa35d55e6c4dd08c5`
- SHA512 SRI：`sha512-Yw2W7T3SLjIi9fzWwIkFD4vRdFhPSLN8qxoGGO3iL0nmMZyTXPloFNs9akvhMVVsOVZ0ssEIu1tFbXjvWiFkTQ==`

| 验证 | 结果 |
|---|---|
| 新锁 fresh install 的维护副本 `check-personal` | 321/321，context report 完成 |
| runtime verifier + historical external-group | 55/55；旧 baseline 从精确 hash 的 `.2` 归档提取，不再取当前默认 installed source |
| release build / 实际 tgz 审计 | PASS；隔离 HOME/cache、fresh install，未复制维护 node_modules |
| 新版实际 npm bin（macOS / Linux VM） | 两平台均通过六场景：wait、persistent、drain、deferred、native resume、mixed/foreground |
| default/full public runtime smoke（macOS / Linux） | 两平台各 2/2，无默认 owned scope、无真实模型调用 |
| **已切换的 PATH 命令** | 实际 deferred wait / writer / close 全链路通过；foreign-bin 负对照在创建 store/writer 前拒绝 |
| 独立 prefix `.owned-flat.7` → alpha.1 → 卸载 | PASS；安装外 v3 marker SHA256 不变，read-only inspect 的 recoveryAuthorized 为 false |
| auditor unit | 10/10 |

以上模型请求均为 local faux/loopback SSE，零远端模型调用；不代替真实业务效果、Windows、GUI/Chrome 绑定迁移或活跃 session 升级测试。Linux 只使用独立 `rotom-owned-verify` profile；安装缺缓存时仅安装进程使用已有无凭据代理，运行验证不继承代理。

### 保留的失败，不用 PASS 抹去

- 首次日常门 318/321：external fixture 还期待 `.2` 的 observed / same-group residual。新默认已包含 group hardening，实际返回 unknown。改用既有更严格的 group 路径，断言真实 group close、unknown reason、缺失 status 下仍拒绝恢复，以及受控同组子进程不再残留；未放宽 runtime，也未声称任意 descendant 已关闭。
- 随后 321/321 但 context report 失败：隔离 Git 副本没有 HEAD。给该测试副本建立 fixture commit 后完整命令通过；不是产品回归。
- macOS 产品验收第一次缺私有 evidence 目录，随后按脚本合同创建；六场景通过后手写的 Pi 路径遇到合法 npm hoisting，改用产品 resolver，两个 smoke 通过。没有全局 Pi 回退。
- Linux 首次选错缓存；选择已有缓存后安装成功。首次裸 fixture 缺显式维护版本参数，在 writer 前拒绝；补正确参数后六场景全过。smoke 工具源目录没有依赖，安装工具依赖时又遇到缺缓存；新目录按锁安装后两个 smoke 通过。失败日志与最终日志分别保留。

本机 `/tmp/rotom-default-root` 指向私有证据根：`check-personal*.log`、`extra-tests.log`、`pack.log`、`product-cli*.log`、`smoke-*.log`、`default-cli.log`、`activation.json`、`old-install-hashes.json`、`upgrade-*.log`、`artifact-audit.json`、`linux-evidence.tar.gz`。实际发行仍为 private，未发布、未 push。
