# REVIEW-26 M1：helper 升级闭环修复与历史审计范围澄清

本次只修复候选 `claude/computer-use-v2.1-main-candidate`，基线为 `c2922e79b3ca0fec928afd1876a2f2f283113b86`；不合入 main，不发布，不操作日常安装或 helper。产品仍为 **0.1.27**，`0.2.0 / latest` 的发布元数据继续留到合入后的独立提交。

## 升级行为

- `rotom helper update` 检测到目标被占用时，只在交互终端询问是否停止，**默认否**，提醒其他使用它的 rotom 会话会失去 Computer Use。拒绝或非交互环境不发送 socket 命令、不建更新锁、不签名、不替换。
- 同意后验证发行源，再读取所选 socket 的 diagnostics，核对可执行文件和已观察到的 PID，只发送一次 `shutdown`。收到确认后轮询可执行文件占用；观察到无占用才继续，替换前再次检查。只读占用检查有 5 秒轮询窗口，单次进程探测另受原有命令超时约束。
- socket 目标不符、关闭结果未知、探测失败或仍被占用都阻止替换。不强杀进程，不自动重发 shutdown，也不启动 helper。
- 会话协议不匹配的确认改为“停止旧 helper，以便运行 rotom helper update”。同意后只 shutdown；拒绝、无 UI、关闭失败或关闭完成均要求显式更新后新开会话。同一客户端实例后续调用直接报告该不匹配，不再探测并重新启动旧二进制；取消后的确认不派发 shutdown。
- 错误文案、当前状态、领域合同和发布说明第 2 步统一为“运行 `rotom helper update`（它会询问是否停止旧 helper）”。保留原有签名保护、失败备份、路径检查及 permission readiness；未改 App 授权卡的默认选择。

实现主要位于组件的 `scripts/helper-update.mjs`、`src/platform/macos/helper.ts`、`helper-path.mjs`、`permissions.ts` 和集中式文案。共享 socket 路径模块同时进入产品资源声明、更新器 canonical/regular-file 检查及符号链接拒绝测试。

## 验证

Node **24.18.0**，独立 HOME/TMPDIR/cache；没有启动原生 helper、真实模型或桌面输入。

| 检查 | 本轮结果 |
| --- | --- |
| 组件 `npm test`，含完整 TypeScript 检查 | **325/325**，0 fail / 0 skip |
| helper updater / protocol 定向测试 | **29/29**；覆盖同意、默认否、拒绝、无交互、错 socket 目标、关闭丢确认、仍被占用、取消和禁止重启 |
| 实际 `rotom helper update` CLI | 隔离 PTY 同意：exit 0，diagnostics → shutdown 各一次，安装内容与实际归档相同；PTY 回车默认否、非交互：均 exit 1，socket 零命令，旧文件不变 |
| 两个单点负对照 | 在独立源码副本恢复“遇忙直接拒绝”和“会话调用 restart”，对应新正向测试分别失败；修复版本通过 |
| `rotom/bin/check-personal` | 完整入口 exit 0；**597/597** 产品测试、**99/99** Goal 测试，Provider 离线门和 default runtime/context 精确合同 PASS |
| 最终入口/维护检查 | **16/16**；包含最终 usage 文案断言、资源拒绝、章程和真实 commit hook；ledger **78 条**校验通过 |
| 日常 helper 只读回验 | 可执行文件 SHA、PID、启动时间与本轮开始记录相同 |
| 组件归档内容 | 144 个文件；136 个非 prebuilt 文件与当前源码相同；8 个 prebuilt 文件与 `c2922e7` 归档逐字节相同 |

PTY 检查使用本轮安装到维护 clone 的真实组件和 launcher、真实终端输入及 `lsof`，但 Unix socket 服务是 disposable fixture：它只持有并释放隔离 HOME 中的旧文件。未运行 Mach-O helper。该检查证明 CLI 确认和更新链路，不冒充受管 Mac 原生 helper 的升级、启动或 diagnostics 验收。夹具被清理，日志与负对照副本保留在仓库外。

完整产品入口通过后，自审补齐公开 helper 子命令的 usage 文案，并补跑受影响的入口和维护检查（16/16）；没有再改变组件归档。开发中的短时限初跑曾被外层工具中止（组件 120 秒、产品入口 300 秒、维护检查 60 秒），未当作通过。确认进程已结束、核对此前约 209 / 420 / 63 秒的基线后，以足够时限完成重跑；上表采用成功日志。

### 更新后的未发布组件归档

文件：`rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.4.tgz`。没有升级产品版本或重建原生文件；该未发布 `.4` 的 source repack 与 lock、product integrity pin 和 vendor 清单同步。

- 压缩：**6,442,530 bytes**；解包：**18,399,944 bytes**。
- SHA-256：`75bc044da5c9c211fc05825e2441a4ab6ba5bbf81ccb0e2bc9579b8f2645ee9f`
- SHA-512 SRI：`sha512-K26Kt2JfBLq9vjCEAUGX1/y2v6Em1hey40Qx5E5ZjkkS7wmX1KVDT/VoWpEFRxvBPZGIuLxK/1gwnvBmrPon7w==`

原阶段报告中的 `591566…` 摘要仅对应 `c2922e7`，不是本轮产物。

## 更正“544 个提交历史审计 0 项”的范围

原结果确实可复现，但我把它称为“完整公开历史”不准确；**它不是整个 origin 的所有分支通过审计**。

原命令是在独立候选 clone 根目录执行：

```sh
python3 scripts/audit-public.py --root . --history
```

没有传 `--history-range` 或 `--record-audited-archives`。规则来自 `c2922e7` 的脚本及同目录模块；本轮未修改审计代码、精确例外、历史归档记录或任何已有历史。该 clone 的配置/范围为：

```text
remote.origin.fetch = +refs/heads/main:refs/remotes/origin/main
is-shallow-repository = false
rev-list --count c2922e7 = 544
rev-list --count 1fbb1a3 = 543
rev-list --count --all = 544  # 本轮提交之前
```

当时 refs 为本地 main、候选、origin/main 和已有 release tags，均落在这 544 个提交内；未跟踪审核/开发等其他远端分支。`--history` 实现使用 `git log --all` 和 `git rev-list --objects --all`，并非只扫描 HEAD。复核原范围仍得到 **31,504 文件、544 提交、0 findings**。报告还明确记录：**317 个已审计归档被跳过重复展开、117 个精确公共示例验证通过**；现有规则含精确 GitHub service committer / Anthropic agent noreply 例外。因此 0 项是既有规则下的结果，不是无任意秘密的证明。

### 全远端分支对照

另建审计专用 clone，保留相同候选树和审计规则，读取全部 **18 个远端分支**：

```sh
git fetch --no-tags origin '+refs/heads/*:refs/remotes/origin/*'
python3 scripts/audit-public.py --root . --history
```

该只读诊断为 **BLOCKED：1,067 提交、107 findings**（70 personal-home-path、3 credential-shape、34 non-noreply-committer）。没有把这些结果隐藏、豁免或通过改写历史清除；规则命中也不等于确认存在真实凭据。

按 finding 对应的 Git object / commit ID 与 `git rev-list --objects 1fbb1a3` 比较，这 107 项均不属于该 main 可达历史。因此，不能仅凭“在 main 和候选 checkout 下得到相同结果”就断言命中来自 main：`--all` 在切换 HEAD 后仍会扫描相同的其他 refs。

### 审核端的 482 / 244

本轮没有精确复现这组数，不能把 107 冒充为 244 的解释或复现。可以确定：

1. 完整 `c2922e7` 祖先有 544 个提交；审核端报告 482，说明历史可达范围不同，不能直接比较。
2. 审核分支 `84dfac9` 中的审计脚本与候选版本不同；规则、公共示例、归档记录从**脚本所在目录**加载，不由 `--root` 自动切换。
3. 在同一 refs 集合中切换 main/候选，`--all` 扫描结果可以不变；“候选新增 0”应另用显式增量范围证明。

本轮提交后会再执行 `--history-range 1fbb1a3..HEAD` 和候选 clone 的 `--history`，并在交付时报告结果。请审核者复核时附上以下只读信息，才能精确对齐 244：

```sh
git rev-parse HEAD
git rev-parse --is-shallow-repository
git rev-list --count HEAD
git for-each-ref --format='%(refname) %(objectname)'
git hash-object scripts/audit-public.py
```

同时提供实际命令及规则模块、公共示例和历史归档记录的版本。无需提供任何命中的敏感原文。本任务不授权清理其他分支或改写公开历史。

## 留给审核与发布验收

- 请对本候选的新提交复审 M1，之后再决定是否合 main；本轮不推 main。
- 日常 helper 未停止、更新或重启，日常安装与用户证书未操作；真实升级仍未验收。
- L2 **0 成功 / 5 失败**、pid 无真机成功、B1–B6 未通过等边界保持不变。
- 最终 `0.2.0` 产品 tgz 的受管 Mac helper 启动与 diagnostics 仍是发布前门禁，不能以本轮 fixture 代替。
