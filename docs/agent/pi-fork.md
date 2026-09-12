# 仓内 Pi fork 与 alpha.11 本机接入

## 当前合同

- 源码：`packages/rotom-pi/`，上游 revision 和导入差异见 `FORK.json`，维护流程见 `ROTOM-FORK.md`。不复制上游 Git 历史或维护者安装；录制会话 fixture 已替换/省略。
- runtime：`rotom/runtime/pi/`，六包版本 `0.85.1-rotom.1`，来源摘要与各归档 integrity 见 `fork-build.json`，由 product config 锚定。保留上游包名、公开 API、配置/会话格式与 MIT 许可证。
- 构建：`cd rotom && npm run build:pi`，从 Git 可见源码清单复制到隔离 staging，按 lock 新安装并 offline build；不复制 ignored state、node_modules 或旁边的 Pi checkout。fork 内部包从本地归档安装，其他依赖锁定公共 registry。
- 打包：`npm run check:pi && npm run test:distribution`，再 `npm run pack:release -- /absolute/output-directory`。源码/构建器漂移需重建；archive/lock/source/version/installed identity 或 canonical 路径漂移均阻断，不回退官方/全局/旁路 Pi。
- 安装：用 `scripts/install-release.sh` 安装新版本目录并只切换命令链接。升级走新的 rotom 发行包；不要用 Pi 自更新命令替换内置 fork。`ROTOM_PI` 仍为显式维护覆盖。
- 产品源码在 `rotom/`，Pi **维护源码**在仓库的 `packages/rotom-pi/`；npm 产品只携带构建后的独立 runtime，不要求用户编译。

## 本轮验证（macOS arm64，Node 24.18.0 / npm 11.16.0）

| 检查 | 实际结果 |
|---|---|
| `npm run build:pi` | 隔离锁定安装与全部 upstream offline workspace build 通过；只分发六包 CLI/SDK runtime |
| builder 内的五个 focused test 文件 | 59 passed，2 个需要真实模型的测试 skipped；没有模型请求 |
| `npm run test:distribution` | 22 passed，包括来源/归档/版本/链接/越界/缺失/隐藏官方副本/不回退测试 |
| `node --test rotom/scripts/build-pi-fork.test.mjs` | 1 passed，源码/构建器摘要与 symlink 负向检查 |
| `verify-pi-runtime.test.mjs` | 33 passed；清除测试进程继承的 Subagent store/scope 环境后运行 |
| `rotom/bin/check-personal`，显式选择实际隔离安装的 fork | 390 passed，default runtimeContractGate PASS；旧测试路径已更新，默认 Pi 解析改走产品 resolver |
| privacy auditor | 13 passed；tracked tree 与实际 tgz 递归扫描通过，公开上游误报精确绑定，详见 `privacy-release.md` |
| 最终 `pack:release` | PASS；17,908 个文件，53,319,370 bytes；无 npm publish |
| 实际 tgz，空 HOME/cache、PATH 无全局 Pi、`npm install --offline --ignore-scripts` | PASS，仅安装 1 个产品包；证明无需从 registry 拉取官方 Pi |
| installed CLI/API | `--version` = `0.85.1-rotom.1`，`--help`、fork 的 `AgentSession.getThinkingLevelForModel` 存在；resolver 指向安装包内部 |
| installed default/full public-runtime smoke | 均 PASS；真实 SDK/extension loader，无真实 provider 推理 |
| 本机版本目录安装与 fresh zsh | alpha.11 链接、包内 resolver 和 `rotom --version` 回读通过；`rotom()` 不再设置旧 `PI_AGENT_PI`，保留 Qoder opt-in 偏好 |

最终 tgz SRI：

```text
sha512-8EyCwd4UCyzyozbaPWIRCm8JUPUtU8b/n9D+ZWaO0JuAZv9dzIRiEZekLFQD+vSWJ5ZVmyxM9C5xxl0oaMLqeA==
```

## 未掩盖的失败与限制

- 最终来源基点为公开的 `da840b6216578c2a571d0374ac6a2091a83f9d91`。导入 checkout 的 HEAD 另有一条仅修改未导入 `AGENTS.md` 的本地提交；最终元数据/许可证链接已指向真实公开基点。已安装的试验 alpha.10 保留，最终另装 alpha.11，不原地覆盖。
- 网络安装曾出现 registry read timeout，以及一次隔离 fork `npm ci` 的 300s timeout；检查进程和网络后单次干净重跑通过，没有放宽安装 timeout 或复用维护者 node_modules。
- 旧 runtime fixture 递归复制了约 1.3 GiB 的本地 eval 目录并超时；改为排除不属于产品的 `evals/`。另一次测试因继承宿主 Subagent store 与 fixture HOME 不一致失败；清除测试环境变量后完整 suite 通过，不改产品 scope 语义。
- 实际安装的 100×32 PTY 中，模型名称、medium→high、Enter 应用和 Escape 丢弃后仍为 high 的断言已走过；独立读取确认全局默认仍为 medium。但 PTY harness 收尾超时，整体状态为 **INCONCLUSIVE**，不将其标为 PASS 或桌面视觉验收。两次试验遗留的测试专用 bridge 进程已按 PID/fixture 路径停止；未关闭用户 App/旧会话。
- 导入源码保留上游十个文件的既有 whitespace（含历史 `.diff` patch 上下文）；不为 `git diff --check` 改写这些历史资料。本次自有集成 diff 与 fork 新增/修改代码无新增 whitespace 错误。
- alpha.11 的 fresh zsh `rotom --version` 首次回读通过；最终重复 shell 检查在 30s 截止时没有输出，未记为 PASS。之后未发现该检查的残留进程；只读复核确认命令链接仍指向 alpha.11、包内 resolver 正常。未扩大到真实模型来绕过该 shell 超时。
- 未验证 Linux/其他 CPU 的新内置 Pi 依赖闭包、真实模型费用/效果、真实 Chrome relay 或存活会话迁移。没有推送、公开 npm 发布或许可证批准。旧安装及旁边 Pi 仓库保持原状，只有新启动使用新默认。
