# 任务 02a 执行报告 · 逐条提问的标注命令

已实现 `review`；定向验收、类型检查和仓外合成卡片的真实 PTY 冒烟通过。GitHub Actions 首次 push 已绿。没有对 bob 的真实卡片运行 review，没有代填真实标注。

## 改动文件

| 文件 | 改动 |
|---|---|
| `rotom/evals/scripts/session-cards.mjs` | 新增 review 路由、TTY 检查和可注入流的 reviewCards；复用路径检查、标注块解析和私有原子写入。readCard 增加 Buffer 读取方式，既有调用仍默认 UTF-8。 |
| `rotom/evals/scripts/session-cards.d.mts` | 声明 reviewCards 的输入流、输出流及计数返回值。 |
| `rotom/evals/scripts/review.mjs`、`review.d.mts` | 摘要提取、排序、交互和类型；文案集中在 review 模块。文件读写由已有边界层负责，交互通过注入的 writer 复用私有写入，没有循环 import。 |
| `rotom/evals/test/review.test.ts` | 新增 21 项合成测试；不读取或修改真实标注。 |
| `rotom/evals/README.md` | 增加 4 行 review 用法及空行；同步 CI 测试范围，区分 build/labels 的计数输出与 review 的私有摘要。 |
| `docs/agent/eval-system/tasks/02-label-sessions.md` | 改为 bob 先用 review 回答满意度、补原因，再导出 labels；保留手工编辑备选，分类交规划者。 |
| `.github/workflows/evals-l1.yml` | 仅在原测试过滤词后增加 review。 |
| `docs/agent/eval-system/README.md` | 仅将 02a 改为 in-review。 |
| `docs/agent/eval-system/reports/02a-interactive-review.md` | 本报告。 |

没有改卡片生成格式、规则条件、observability、依赖、secret 或编辑器集成，没有模型调用。

## 验收命令及结果

本地为 macOS arm64，Node `v24.18.0`、npm `12.2.0`、Vitest `4.1.9`。先 pull 至 `8f554841`，按 README → 任务 02a 顺序阅读，核对根目录合同。npm 命令在 `rotom/evals` 执行，审计和 Git 命令在仓库根执行。

| 命令 | 结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | PASS，安装 180 个包。8 项既有依赖漏洞（3 moderate、5 high），未执行 audit fix 或改锁文件。 |
| `npm test -- test/agreement.test.ts test/session-cards.test.ts test/review.test.ts` | PASS，3 个文件、79 项测试通过。 |
| `npm test -- session-cards trace-assertions agreement review` | PASS，4 个文件、112 项通过，分别为 40 / 33 / 18 / 21 项。 |
| `npm test` | exit 1；211 项：200 passed、10 failed、1 skipped。仅原有 4 个文件中的 10 项失败，没有新增失败。 |
| `npm run typecheck` | PASS，exit 0。 |
| `git diff --check origin/main...HEAD` | PASS；另检查工作区及暂存 diff，提交后再核对。 |
| `python3 scripts/audit-public.py --root .` | PASS，tracked-tree findingCount=0；最终报告也纳入审计。 |
| `node --check rotom/evals/scripts/review.mjs`、`node --check rotom/evals/scripts/session-cards.mjs` | PASS。 |
| `actionlint .github/workflows/evals-l1.yml` | 官方 actionlint 1.7.12，exit 0；下载归档 SHA-256 与任务 06 查证的官方归档一致。 |

全量既有失败：pi-harness 3、coding-hygiene-rule-ablation 3、product-runtime 2、tool-surface-ablation 2。均由第三方 identity/version gate 阻断；其中投影失败用例拿到的是这个先行错误。实读 installed computer-use 为 `0.5.1-rotom.0`，manifest 要求 `0.5.1-rotom.2`。没有覆盖存活运行时、降级 gate 或跳过测试。

### 新测试与负向证据

覆盖 y、n（有原因/空原因）、s、o、q、非法输入重问、已有 verdict 不出现、started 排序、limit/default 50、字段缺失、截断与逻辑行数、损坏标注块、结束统计、非 TTY 拒绝、Git 目录/工作树文件及别名拒绝、0700/0600、写失败不重试、EOF 和 Ctrl+C。

- 标签外的字节比较包含中文、emoji、CRLF 和非 UTF-8 字节；写回只替换末尾标注块，categories 为空。
- 实际 build 生成合成卡片后删除合成 session 目录，review 仍成功，随后 labels 能导出正确结果，证明没有重新读取 session。
- 自审补充“缺失正文小节时，不能把 note 中的 Markdown 标题当作请求/最终回复”的断言。修复前 20 passed / 1 failed，修复后 21 项全过；没有降低期望值。
- 开发初轮另有 2 项 fixture 对空 categories 尾空格的字面期望不一致，已按空字段合同修正 fixture；标签外逐字节比较与导出结果检查保留。

### 仓外合成卡片 PTY 冒烟

使用 Python 标准库创建真实 PTY，启动当前 Node CLI；全部输入和卡片为独立临时目录中的合成数据。验证 o 输出规范绝对路径、n 后原因保存、y 保存、进入下一张前已落盘、Ctrl+C 退出、未答卡片不变及权限。

最终计数：3 张合成卡片，pass 1 / fail 1 / remaining 1；退出码 0；已保存回答、标签外字节和 0600 检查通过。初版辅助脚本曾因路径别名断言及等待方式未完成；改为核对 canonical 路径、独立目录并持续消费 PTY 输出后通过，最终源码又重放通过。没有为让冒烟通过而改弱 CLI 的 TTY 门禁或保存检查。

这是 macOS 上的真实终端协议检查，不是 bob 的人工体验，也不是读取真实会话的冒烟。

## GitHub Actions

- [Evals L1 / 40197802638](https://github.com/bingjiang0611/rotom/actions/runs/40197802638)
- 实现提交/headSha：`099d6f1abb58920fecc472ff0446f6e5a594572c`，event=push，branch=eval/system。
- `gh run watch 40197802638 --repo bingjiang0611/rotom --exit-status --interval 15` exit 0；API 回读 status=completed、conclusion=success，各步骤 success。
- 定向读取远端日志确认 4 个文件、112 项通过，typecheck 成功，公开树审计 findingCount=0；不是只看派发状态。
- 实际环境：ubuntu-26.04、Node `v24.21.0`、npm `11.19.0`。job 用时 25 秒；安装/测试/typecheck/审计分别为 3/3/3/5 秒（GitHub 秒级时间戳，不含排队，不是费用）。

取得绿色运行后，报告和状态表单独提交。它们不匹配 workflow 的 paths，因此最终文档提交不会重复触发 CI；被验证的实现 SHA 明确如上，文档提交不冒充新的运行。没有 CI 失败重跑或修复提交。

## 与说明的差异、边界及未验证项

- 无功能范围偏离。摘要最多 4 个换行分隔的逻辑行，加首次提问共 5 行；重问不重复摘要。终端窄窗口的自动折行取决于列宽，不宣称所有终端都只有 5 个视觉行。
- started 按本机时区显示，分钟四舍五入；日期缺失或无效排最后，同时间按路径稳定排序。请求/最终回复按 Unicode 字符截为 120/160；去掉终端控制序列。
- `还剩` 包含跳过、退出及超过 limit 的有效未标注卡片；损坏卡片单独计数，不猜它是否已标注。n 后在原因问题上 EOF/Ctrl+C，不保存尚未完成的当前张，先前已保存回答保留。
- o 输出 JSON 引号包裹的规范绝对路径，保留路径中的空格并转义控制字符；不会启动编辑器。
- 未对 bob 的真实卡片运行 review，也未替 bob 标注或分类。下一步由 bob 按任务 02 在自己的交互终端使用，由规划者核验 02a；未验证 Windows 终端。
- 10 项全量环境失败和 8 项依赖漏洞留给独立维护任务；本次不扩大范围。
- 公开同步使用独立干净副本和 GitHub noreply 身份，仅 fast-forward 推 eval/system。额外全历史审计仍只有 `fc539150e67d` 的既有 author/committer 非 noreply 2 项（BLOCKED），新增 finding=0；不把它写成全历史 PASS，不改写公开历史。文本隐私审计不证明不存在任意秘密。
- 用户已有的未跟踪 `.idea/` 保留、不纳入提交。本次临时 clone、合成卡片、PTY 脚本及日志在确认交付后清理，不删除存活会话资源。

## 核验结论（规划者，2026-10-25）

结论：**accepted**。规划者重跑 eval 相关的 4 组测试，112/112 通过，typecheck 退出 0。`gh run list` 显示运行 40197802638（headSha `099d6f1`）为 success。已核对 `review.mjs`：只回写标注块前缀以外的部分、按字节保留卡片正文、提示文字和 8 行上限都符合要求，非 TTY 时拒绝运行。任务 02 的说明已同步改为用 `review`。
