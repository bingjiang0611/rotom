# Qoder 长会话与 thinking controls 验收

> 本页为长会话阶段的历史结果，text-only/32K 与 alpha.0 产物不代表当前能力；后续三模型图片/272K 管理窗口及 Ultimate 固定 COSY 见 [图片与大上下文](IMAGE-CONTEXT-VERIFICATION.md)，当前使用合同见 [产品说明](../../rotom/README.md)。不复用旧账本授权，也不回填历史结果。

用户在 `f3bd84c` 全局修复后仍报告 Ultimate `invalid_tool_id`，明确要求多组长会话与真实 thinking-level 切换通过后再交付。源码及实际安装验收已完成；全局更新状态见文末，不把候选源码/短用例通过当交付。

## 范围与验收原则

- 沿用独立账号、仅合成数据、共享池消费授权；不购买、不 push/publish、不复用业务命令。
- 累计 ledger 从 315 继续，不清零。为源与实际安装的重复压缩/档位验收，将维护自限由 1000 提高到 1500；不是用户费用上限或剩余 Credit。
- 主会话实施与最终验证；两条只读 scout 检索 native 控制映射和工具 ID 语义，没有 Qoder 调用或源码写入。
- 真正长测使用产品 provider 与 Pi 原生 AgentSession、私有 fixture 文件、严格读/检查/单次记录工具；不是任意 shell 沙箱，也不冒充真实桌面交互。
- 每组目标 20 个用户轮次、60 次已完成工具执行、多个手动压缩、磁盘重开、精确 marker 工具参数与文件 readback、实际输入峰值至少 16K tokens。逐轮切换已声明档位并核对实际请求参数。关闭自动 retry；失败/未知保留，不回滚已验证的 fixture 写入。
- 早期测试对最后一段 prose 的格式限制过严。最终 oracle 是严格的工具参数、唯一记录和文件 readback；允许叙述提到旧 checkpoint，但必须包含当前 marker，且不能捏造 marker。旧失败不追认为 PASS。

## 定位与候选修复

1. Ultimate 实测同批串行工具会反复使用显式 index 0，新的完整 ID 与函数名出现在前一个 JSON 参数完整之后。只对该模型/路由的已证实边界分配新原生 index；保留完整原 ID，拒绝未完成、重入、重复、前缀疑似碎片、未知函数等情况。不是照抄 native Pi 的任意 ID alias 行为。
2. 长测观察到 SSE 字段前缀本身被物理换行拆开。候选只在同一 frame 中拼回已有字节组成的精确 `data:`，不添加语法、不跨空行边界，不丢错误或迟到数据。全部 prefix 切点有离线正反回归。
3. reasoning 请求使用 180 秒有界总 deadline，仍支持立即原生取消；非 reasoning 保持 60 秒。Sonus 第二次压缩曾精确在 60 秒被终止并记 aborted/unknown，旧请求没有重放。
4. 档位由静态实测白名单与当前账号 catalog 的 thinking 配置求交；simple/raw API、native serializer、post-hook transport 与 COSY 三处模式字段保持一致，不在 legacy 层强制重写 high。未知、混用 API 选项、预算或 hook 替换 effort 在 auth/dispatch 前拒绝。
5. 候选控件：Ultimate/Sonus 的 low/medium/high/xhigh/max；Qwen3.8-Max 的 off/low/medium/xhigh；Qwen3.8-Flash 的 low/medium/xhigh；Kimi-K3/DeepSeek-Flash 的 low/high/max；GLM-5.3-Flash/DeepSeek-Pro 的 high/max。源码和实际安装的 27 档/54 模型调用矩阵均通过。 GLM-5.3 high 研究用例有一次 invalid_sse_json，暂不进入可调白名单；无强度目录的路由不捏造强度。Ultimate、Flash、DeepSeek 的若干 advertised off 实测仍产生 reasoning，不开放这些 off。
6. thinking 参数可精确转发且完成调用，不证明不同档位必然有单调 token/耗时差异，也不证明上游内部计算量。

## 已保留证据与失败

- `long-ultimate-before`：真实 read/write 已执行，但最初叙述格式断言失败；不是协议失败。
- `long-ultimate-batches`：无工具执行，复现 invalid_tool_id；新 ID/函数名、重复显式 index 0 的结构证据保留。
- `tool-batch-fixed`：三个工具执行成功，但旧重复 marker 叙述断言失败。
- 原始 Ultimate effort 研究首批含不合适的算术+严格尾文 oracle；错误不清零。随后新 prompt 的独立模式矩阵再验证。
- `long-ultimate-controls-1` 与首批产品 high 档：unexpected_sse_field，未交付。
- `ultimate-tail-diagnostic`：旧历史 marker 叙述断言失败，不判作协议错误。
- `long-ultimate-controls-2`：6 轮/18 工具、25,062 token 峰值，首次压缩遇到字段前缀片段；失败保留。
- `long-ultimate-controls-3`：20 轮/60 工具、3 压缩/1 重开、28,271 token 峰值、五档轮换 PASS。该批观察到 20 个原工具 ID collector 会拒绝的批次。当时 fixture reserve 仍为 1024（摘要上限 819），不是最终默认配置验收。
- `long-sonus-controls-1`：12 轮/36 工具、1 压缩/1 重开、22,264 token 峰值，第二次压缩在 60 秒 aborted，Credit unknown；有时间戳与计量 metadata 证明。
- `long-sonus-controls-2`：180 秒 deadline 后，独立 20 轮/60 工具、3 压缩/1 重开、22,710 token 峰值、五档轮换 PASS；同样是早期 reserve 配置。
- `long-qwen-controls-1`：手动每六轮压缩太晚，实际输入到 31,375 tokens 后 length；未提高产品容量。
- `long-qwen-controls-2`：提前压缩后输入峰值 17,565，但第二次摘要 length。查明 fixture reserve=1024 导致 Pi `min(0.8*reserve, model.maxTokens)` 只允许 819 输出。恢复 native reserve 默认，不改产品 4096 上限；独立 `long-qwen-controls-3` 通过 20 轮/60 工具、6 压缩/1 重开、19,244 token 峰值。

当前可读私有证据在既有 capabilities workspace，逐例 summary 指向自己的 `qoder-long-session-*` / `qoder-efforts-*` 目录。只保留结构诊断、请求档位与 token metadata；原生磁盘历史仅包含合成内容，opaque 保持原生保存/回传，不进入诊断正文。完整终止、实际安装和 TUI 状态分别验收，见下文。

## 最终安装包验收

从已安装的 `f3bd84c` 基线与本次文件建立无私有 Git history 的隔离源码索引，不夹带并行 Subagent 工作（构建时维护 HEAD 为 `8fdfcfc`，随后并行提交 `07719f8` 也未进入此包）。两次 npm ci 分别在第三方依赖、Pi 依赖阶段 ETIMEDOUT，均无 artifact/残留构建进程；没有复制维护者 node_modules。第三次仅通过私有 npm wrapper 加 `--maxsockets=1 --fetch-timeout=120000 --fetch-retries=1`，仍执行原 `pack:release`、新 HOME/cache、锁文件安装和全部门禁，成功。

- tgz：`rotom-0.1.0-alpha.0.tgz`，**9,299,590 bytes / 3,797 files / Pi 0.85.1**。
- SRI：`sha512-cEHWLfmq1SO0YiJBRc7exsQ8LxnplSD6LxxBTDy8Fn2zpXfVuSJb8gTvbx87ey650R22msmP+4Hb8VFkE8lp+w==`。
- 与前一全局 tgz 全文件比较：仅 README 与 Qoder 的 `catalog.mjs` / `legacy.mjs` / `provider.mjs` / `transport.mjs` 不同；四个运行时文件与受测源码 byte-match。
- 本轮 **190 targeted tests、321 check-personal、48 resource/distribution tests、Qoder TypeScript 检查**通过。新 off 负例最初漏写 legacy `statusCodeValue`，修正 fixture 后通过；未放松产品验证。
- 源码 17 个 SDK/disk 离线用例与四基础 smoke；实际安装 17 个 SDK/disk、迟到尾帧拒绝、20 轮离线 AgentSession、default/CLI/browser/full 四资源 profile 通过。冷源码快照的 profile helper 首次缺 typebox；确认 14 个 helper/合同源码文件 byte-equivalent 后，使用维护 helper 加载实际安装资源，通过。不是修改 installed source。
- 真实 API 档位矩阵：**8 模型、27 档、54 个模型调用**，实际安装版本逐请求验证 direct/COSY 的 effort/enable_thinking，27 次工具结果精确 wire replay；观察到的 5 次 opaque 全部精确 replay，其余不伪造 opaque 观察。每档独立 native 磁盘恢复。

### 实际安装的完整 AgentSession

全部使用打包安装的 provider 与其真实 Pi dependency，输出含 11 个 Qoder 模块 digest、canonical Pi entry/SDK 路径；不指向相邻开发版 Pi。默认 native reserve=16384，retry/自动压缩关闭，手动控制压缩；不抬高 32K/4096 上限。

| 模型 | 用户轮次 / 工具执行 | 手动压缩 / 磁盘重开 | 输入峰值 tokens | 模型 / 目录 dispatch | 结果 |
|---|---:|---:|---:|---:|---|
| Ultimate | 20 / 60 | 5 / 1 | 20,443 | 75 / 2 | PASS |
| Sonus | 20 / 60 | 4 / 1 | 19,328 | 72 / 2 | PASS |
| Qwen3.8-Max | 20 / 60 | 6 / 1 | 18,503 | 78 / 2 | PASS |

分别每 4/5/3 轮压缩。每轮切换对应原生档位，Qwen 包括同一历史里的 off↔on。所有步骤的 read/inspect/record 参数、顺序、唯一写入、文件 readback、压缩 anchor 召回均通过，无模型错误，凭据 hash 不变。Ultimate 真实观察到 209 次 JSON 续行和 **3 次字段前缀续行恢复**，原 collector 会拒绝的串行工具批次也实际覆盖；不是只有离线样例。

Sonus 安装首例虽完成全部 20 轮/60 工具与恢复，输入峰值仅 15,729，未达预定 ≥16K 覆盖门槛，保留为 FAIL/coverage，不计入上表。独立改为每五轮压缩的案例达到门槛，不降低断言。

### 真正 launcher / packaged Pi / RPC

`long-cli-smoke.mjs` 直接运行安装包 `bin/rotom`，**不设置维护用 ROTOM_PI**，隔离 HOME/agent/project，`--no-tools` 与空 allowlist，不执行任何模型工具。原生 RPC 无模型预检通过五档切换；另外 **20 用户轮、5 手动压缩、1 次真实进程重启/同 session 恢复**通过，输入峰值 **19,181 tokens**。初始 anchor 只提供一次，后续压缩不重新提供其值，严格召回通过。

CLI 首例四轮后压缩在模型 dispatch 前失败：手动压缩时保留原默认的大 recent window，不适合该受控短间隔测试。明确设置本 fixture 的 keepRecentTokens=1024 后独立重跑；没有扩大产品容量或写入用户配置。两次进程均在 idle 后正常按 SIGTERM 终止（143），剩余 owned process group 进程为 0；stderr 0、工具事件 0，两份隔离凭据均不变。该例 **37 dispatch = 35 模型（含 split-turn 的两段摘要）+2 目录**。不把 RPC/终端内容验证冒充桌面视觉批准。

## 交付状态与边界

- 本轮累计 ledger 到 **1235**（包括此前认证/Credit/图片研究及本阶段失败，未清零）；旧 30/21/87 ledger 仍分开。维护自限 1500，不是费用预算；unknown Credit 不算免费。
- 验收结束后仅卸载本轮私有 prefix 内的 rotom；tgz、JSON 结果和原生合成历史保留，不清理项目运行时目录或用户会话。
- 实际包/私有安装证据：`/private/tmp/rotom-long-release.HpccPy`，其中 `artifact-comparison.json`、`installed-efforts/`、`installed-long/`、`cli-long-2.json`、`runtime-*-2.json` 可读。
- **全局已更新**：先确认旧全局包全部 3797 文件仍匹配 f3bd84c artifact、普通 zsh 的 rotom function/PATH/Pi version 未变；再以空 npm 配置/隔离 HOME、offline/ignore-scripts 安装。新包全部 3797 文件与 tgz 匹配，bin symlink 正确。`.zshrc`、原生 auth、CLI auth 目录、旧 scoped manifest 和历史 bin 的摘要均保持一致；这是指定坐标/本次窗口，不是整个 HOME 或永续不变证明。
- 更新后在隔离配置下，对**实际全局 launcher** 再做一次禁止模型 dispatch 的 RPC 预检：五档切换/目录可用、凭据不变、idle 终止/owned group 0 残留均 PASS（1 目录 dispatch）。`global-before.json`、`global-result.json`、`global-cli-preflight.json` 为证据。已有进程不会热替换已加载模块，用户需重启再 `rotom --resume`。未 push、未发布。
- 限定结论：本轮合成场景通过，不保证任意业务永不报错；未验证所有模型的长会话、默认自动压缩策略、上游内部 effort 的量化差异、桌面视觉、自然到期刷新、图片或更大容量。仍 text-only、32K/4096，Enterprise/BYOK 不开放。
