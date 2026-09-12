# rotom 发布评测：零模型准备记录

> **历史准备记录**：以下“本轮/当前”和未发布结论属于该次零模型准备，不代表现有安装。项目仓库现为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)，npm 包现通过 `@bingjiang0611/rotom` 公开分发。后续产品身份/Browser 协议已改名，内化组件和 scoped 默认见 [当前默认](subagent-owned-default.md)，版本与资源以 `rotom/package.json` / `rotom/runtime/product-config.mjs` 为准。保留旧归档、arm 与测试结果，不将历史证据改写成当前版本验收。

## 范围与结论

本轮用户选择 **只做零模型准备，并讨论命名**。后续意向模型为 `luna`、effort `high`，规划上限 $20 / 2 小时；这不是本轮付费授权。

- **PASS：准备代码和本机确定性验证。** 没有调用真实模型，没有真实 Chrome/业务页面操作，没有启动容器服务、推送或发布。
- **BLOCKED：正式评测与公开发布。** 容器服务、模型认证/计量、预算控制、最终源码/环境指纹、真实 Browser 验收、名称的商标/IP 审查及许可证仍有未完成项。
- 没有成功率、成本优势或对 Pi/Maka 的优越性结论。安装与 dry-run 通过不是 benchmark 通过。

## 已落地

### 1. 可移植的锁定依赖

`pi-subagents@0.52.1-dev-agent-followthrough.2` 保持原版本与 SHA-512，不改已安装源码、不重新打包。原先 lockfile 指向维护者 HOME 的归档，现改为仓库内 `extensions/third-party/vendor/` 的同字节归档。

- 归档来源、MIT 版权通知与已知产品边界见 [vendor 说明](../../rotom/extensions/third-party/vendor/README.md)。
- `product-config.mjs` 同时固定 archive source、version、integrity，并将归档列为 required resource。
- verifier 拒绝归档缺失、内容漂移、source 漂移、文件/父目录 symlink，以及超出大小上限。
- Harbor product bundle 必须携带归档，仍不复制 `node_modules` 或宿主 HOME。
- 干净安装发现 npm 11 的 `--replace-registry-host=always` 会把本地归档 URL 改成 registry URL，产生 HTTP 404。改用 `--replace-registry-host=never` 后通过；失败尝试未算通过。

这解决的是依赖分发，不是对整个第三方包完成安全审计，也不激活包中已退出产品面的工具/模板/skills。

### 2. 正确锁定 Terminal-Bench 2.1

从 Maka 的[实验配置](https://github.com/apache/maka/blob/main/packages/eval/experiments/terminal-bench-2.1-deepseek-v4-flash-eight-arm.json)核对到：

- Repository：`https://github.com/harbor-framework/terminal-bench-2-1`
- Commit：`d49e28f1e4ddd13d289e85a5f312a66750951932`
- Tasks subtree：`2f0f5fdc68f0befd9b4745386eb8698264b00d8a`
- 89 个唯一任务，路径均为 `tasks/<id>`；通过仓库 Git tree API 和本机 Harbor registry parser 核对。

[本地 registry](../../rotom/evals/profiles/terminal-bench-2.1.registry.json)只固定任务引用，不复制题目正文、答案或修改 verifier。原 Terminal-Bench 2.0 入口仍独立保留。

本机 Harbor 是 0.22.0；Maka 对应实验配置是 0.20.0，且模型、网络等条件不同。共享任务 commit **不等于**可直接拼接双方分数或宣称复现 Maka 实验。

### 3. 两臂配置与显式 thinking

增加 `--arm=native-pi|dev-agent`、`--pi-version`、`--thinking`：

- NativePi 保留 Harbor Pi 的 run/CLI 行为，不安装产品资源或 product shim。
- DevAgentPi 复用同一安装器，再加载产品 bundle；两臂共用 Node major 24 和显式 Pi 版本，不拿 Harbor 默认 Node 22 来比较。
- 本次规划指定 Pi 0.85.1。公开 npm 包可安装，观察到的包 SRI 写入 preparation JSON；正式运行仍需核验实际产物与 Node patch/image identity。
- `thinking=high` 已通过真实 Harbor adapter 的 CLI flag 构造测试。没有发 provider 请求，因此不把 flag 构造当成 provider 接受证据。
- 当前已认证 Pi 的 `--list-models luna` 将名称解析到 `openai-codex/gpt-5.6-luna`。独立 HOME 没有登录凭证，模型不可用是预期结果；没有复制宿主 OAuth/auth 文件。

[release-smoke.txt](../../rotom/evals/profiles/release-smoke.txt)预选 10 个任务，覆盖构建、异步、服务、调试、恢复、安全修复、Git、大编辑、跨语言和查询。已生成两组各 10 题的 dry-run argv；实际模型任务数为 0。选题只是链路 smoke，不是代表性发布分数。

[release-preparation.json](../../rotom/evals/profiles/release-preparation.json)是**不可冒充执行授权的规划记录**：`liveExecutionAuthorized:false`，候选源码指纹仍为 null。预算值只是后续意向，当前 runner 没有累计美元熔断器，不可直接删掉 dry-run 就运行批量任务。

## 实际验证

| 检查 | 结果与范围 |
|---|---|
| 独立 HOME/cache、禁用个人 npm 配置的 runtime `npm ci` | PASS；使用仓库内归档和公共 registry，未复用源项目 node_modules |
| 公共 npm Pi 0.85.1 安装 | PASS；`--ignore-scripts`，临时前缀，无宿主凭据复制 |
| 新安装 Pi + staged 产品 + 独立 HOME 的 default/full public-runtime smoke | PASS；4 extensions / 1 bundled skill / 0 templates；lifecycle errors=0 |
| 仓库外临时 Git 项目中的 staged launcher `--version` | PASS，0.85.1；不是业务模型运行 |
| `node --experimental-strip-types --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs rotom/runtime/third-party-archive.test.mjs` | 38 passed，0 skipped；约 295 秒 |
| `ROTOM_PI=<verified executable> rotom/bin/check-personal` | 105 passed，0 skipped；default footprint PASS |
| full `report-context-footprint.mjs` | PASS；静态 bytes，不是模型 token/成本 |
| `cd rotom/evals && npm run typecheck` | PASS |
| `npm run test:benchmark-adapters` | 9 passed；fake environment，只生成/检查命令 |
| `npm test` | 87 passed / 1 skipped；既有可选 sidecar 未配置；不运行 `*.eval.ts` |
| `harbor datasets list --registry-path <registry> --legacy` | PASS；确认 `terminal-bench@2.1` / 89 tasks，不下载镜像 |
| 两臂 release-smoke 的 `--dry-run` | PASS；固定 Pi 0.85.1、luna/high、10 explicit tasks、1 attempt、1 concurrency |
| `npm run benchmark:doctor` | BLOCKED：Apple container apiserver 未运行且未注册到 launchd；未擅自启动服务 |
| `git diff --check` | PASS |

以上 clean install 是**同一台 Mac 上的独立目录/HOME**，不是干净 VM，也不证明 Linux/Windows 或真实 Computer Use 可用。

原始安装、验证及失败日志只在本机私有留存，不公开临时目录或会话坐标，也不作为永久发布 artifact 提交。未来真实 run 需独立的私有留存与公开 metadata 投影。

## 下一阶段门禁

1. 用户确认容器环境并允许启动/探测；固定架构、Node patch、镜像 digest、任务 timeout 与 verifier。不把 Rosetta 是否可用写成已验证。
2. 确认 `openai-codex/gpt-5.6-luna` 在容器中的授权接入方式，显式决定凭据传递范围。订阅额度、目录等价成本和实际账单分开，不假造缺失 usage。
3. 补齐总费用/时长的 admission 与中止测试：$20 / 7200s，停止接纳新任务；在途/unknown 单列，不因取消而抹掉费用。没有可靠计量时禁止宣称硬美元上限已生效。
4. 固定源码/依赖/镜像/任务指纹、网络与 benchmark-contamination 限制、顺序、重试口径。最终 patch 后才能冻结 candidate；不使用维护者全局 skills/prompts 作为隐藏加成。
5. 第一次真实执行仍从链路预跑开始，不能把本次选择解读为 89 题或三轮授权。未来报告列出逐题 pass/fail、timeout、人工介入、错误完成声明、usage/耗时/成本缺失，不筛掉失败或只保留最佳尝试。
6. 真实 Browser 的 Enter 标签确认、全文完整性、stale/unknown 不重放需单独 local-fixture 验收；Chrome extension 重载由用户执行。终端 benchmark 不替代 Browser/Computer Use L3。
7. 公开发布前确定根产品许可证、第三方分发通知、安装说明和支持矩阵。当前不是 sandbox，也不宣传统一权限确认层或可靠 orphan termination。

## 当时的命名决定：rotom，尚未迁移运行时身份

用户已确认采用宝可梦洛托姆命名，产品名与计划仓库名统一为全小写 **rotom**，不使用先前候选 Tavlo 或 `rotom-agent` 仓库名。

| 层次 | 该次准备阶段的决定（后续变更见页首） |
|---|---|
| 产品公开名称 | `rotom` |
| 计划仓库名 | `rotom`；当时没有配置远端，该轮未创建或推送 |
| 本地目录 | 保留 `dev-agent`，不影响存活会话和绝对路径绑定 |
| 当前启动入口 | npm 产品入口为 `rotom`，exec 内部 `rotom/bin/rotom-launcher`；本轮只在隔离 prefix 安装验收，不更改维护者全局命令 |
| 内部 ID / 环境变量 / 协议 | 保留现状，包括 `dev-agent`、`ROTOM_*`、native-host/resource identity |
| 历史评测标识 | 保留 `dev-agent` arm、`DevAgentPi` adapter 和既有 artifact schema |

本轮按用户选择只确定公开名称，未注册 npm/GitHub/域名，也未使用官方宝可梦角色素材。rotom 的重名、商标/IP 使用以及根项目许可证仍需发布前审查；名称确认不等于获得官方授权或具备发布条件。

后续已授权实现 npm 安装产物，详见 [npm 分发准备](distribution.md)。只新增公开 `rotom` 命令并接入固定 Pi 依赖，不迁移本地目录、Chrome/native-host 绑定或活跃会话；没有模型评测和公开发布授权。
