# 阶段 3 / 4：文档与 clean-main 候选

> 本文记录 `c2922e7` 的阶段 3–4 快照，不代表后续 M1 修复产物。原“完整公开历史”表述过宽：当时只审计该 clone 的 main/tags 可达历史，不含所有 origin 分支。升级修复、精确审计范围与新产物见 [REVIEW-26 M1 报告](STATUS-5-upgrade-m1.md)。

## 来源与范围

- 阶段 2 审核：`claude/dazzling-mccarthy-lf6mz2` 的 `f06cbb6` / REVIEW-25。
- 已批准的实现来源：`claude/computer-use-v2.1`，`7eea8321b82fff0d8636d1d3dc31fb01b9c5f7d1`。
- 最初公开基线：`37e53dd244402caf2b88b24da52c1616a885b9be`。工作期间 main 拆分 CLAUDE 为章程和领域合同，候选同步到 **`1fbb1a37e2c8de4d3638e95e1bec0e85bb71ea2e`** 后继续验证。
- 从公开 main 建独立 single-branch clone；只生成并重放源分支相对共同基线的文件补丁，没有 fetch 源分支提交到候选仓库。候选提交只以公开 main 为父提交，使用 GitHub noreply 身份。临时 stash 只属于本次候选，解决冲突后已删除；不把旧分支历史带入候选。
- 只交付 `claude/computer-use-v2.1-main-candidate`。不推 main、不发布、不登录 npm，不操作日常安装或 helper。

## 阶段 3 文档

- 根 `CLAUDE.md` 明确首参 `helper` 由 launcher 处理，`rotom helper update` 不透传 Pi、不启动 AgentSession。
- 根章程保留紧凑的 Computer Use 证据表与协议 11 / 2；详细签名/更新边界放在 `contracts/pi-runtime.md` 与 `contracts/local-execution.md`，不恢复旧版长章程。章程的大小、版本与合同引用检查不放宽。
- `STATUS.md` 和领域合同保留 HANDOFF-6 的完整证据等级：用户报告的真机路径、O1 细节未留存、L2 真机 0 成功 / 5 失败、pid 无成功记录、其余指定能力仅 L1、B1–B6 未通过。协作式仲裁不升级为 OS 隔离保证。
- [0.2.0 发布说明草稿](../../releases/computer-use-v2-draft.md) 以 `latest` 的升级警告和步骤开头，说明旧 helper 不更新会报协议不匹配，包含十项行为变化、ScreenCaptureKit 每月确认弹窗和已知限制。
- `d6c17a6` 的 HANDOFF-6 记录用户已授权未来 `0.2.0` / `latest`；**产品 manifest 仍为 `0.1.27`**。功能合入 main 后，才单独冻结发布元数据。

## 冲突与兼容性处置

首次三方补丁有 9 个文本冲突；随后同步最新 main 时另有根 CLAUDE 冲突。没有用整棵功能分支覆盖 main。

| 文件或领域 | 处置 |
|---|---|
| 组件 README、UPSTREAM、package.json | 采用未发布的 `.rotom.4`；补充 main 合并来源与重新打包说明 |
| 组件 `src/constants/copy.ts` | 合并更新命令提示与 main 的 `helperUnavailableGuidance`、`helperRestartCopy`；保留 takeover/broker/O1 文案 |
| third-party manifest、lock、product-config | 只将 Computer Use `.rotom.3` 换成 `.rotom.4` 及新 SRI；其他包保持 main 版本与摘要 |
| THIRD_PARTY_NOTICES、vendor README | 更新 Computer Use 的版本/摘要；保留 main 的其他组件记录与旧 `.2`、`.3` 归档 |
| 根 CLAUDE 的后续冲突 | 以最新 main 的短章程为底，增加本次子命令和精简证据表，详细合同同步到新拆分文件 |
| main 的非冲突 Computer Use 修复 | 保留 `helper.ts` 的传输错误/显式重启确认/同实例单次提示；保留 `permissions.ts` 的 readiness 检查；保留 broker 并发测试对生成子进程的收尾与 `helper-protocol.test.ts` |
| Ask 2.15.0 | 保留 main 版本。审批继续复用 `loadQuestionnaireSession`，不调用 model-only Ask 工具、不改授权默认项。其构造器新增必填参数，补入原生 `fullRowBudget`、`DEFAULT_NOTES_KEY` 和 `canReopenWhileHidden:false`，并补齐资源声明 |

Ask 未适配时，真实问卷渲染的 3 个回归用例报 `rowBudget is not a function`；补齐 row budget 后又暴露 `notesKey is not iterable`。读取完整构造合同后一起补齐三个必填字段，原有 11 个回归用例通过，并增加终端行预算断言。没有删除、跳过或放宽原断言；这些是离线真实组件渲染检查，不是本轮终端人工验收。

保持 main 的 Pi `1.4.0-rotom.4`、Ask `2.15.0`、Subagent `.rotom.15`、Goal `.rotom.11`、Context View `0.8.3`、SoL-Pi `0.1.1-rotom.7`，没有带回旧依赖。依赖从锁文件在隔离 HOME/cache 安装，全部禁用 install scripts，没有复制维护者 node_modules。

## 提交门要求的职责拆分

main 的 staged-file 门检查完整文件，不豁免既有大文件。首次检查发现历史 `STATUS-2-typecheck.md`、安装器 `setup-helper.mjs`、broker `core.ts` 超过 20,000 bytes，另有一个测试文件的 EOF 空行。

- 历史类型报告只将完整诊断按实现/测试路径拆到两个附录，不删除或改写诊断。
- 安装器将共享路径与 I/O、release 下载、签名分别移入 `setup-helper-common.mjs`、`setup-helper-release.mjs`、`setup-helper-signing.mjs`。从拆分前实际归档比较，7 个迁移函数组在只去掉 export 修饰后逐字相同；旧的三个具名导出仍指向同一函数，包根解析仍为 `.rotom.4`。真实归档安装回归又发现拆分时漏保留主文件仍用的 `fsConstants`（同时检查并恢复 `createHash`）；恢复原 import 后，同一实际归档的禁止静默覆盖测试通过。默认签名策略和显式 updater 的不创建证书边界不变。
- broker 的 ping/可信 helper 活动报告处理移入已有 `user-control.ts`，沿用同一 broker 状态、时钟、role 检查和响应。
- 三个 installer 依赖同步加入组件 files 清单、产品资源声明与 updater regular-file/canonical 检查，扩展符号链接拒绝回归；不跳过资源门。未加 files 清单的中间归档在真实模块导入时以缺 `setup-helper-common.mjs` 失败，作为负对照保留；最终归档明确检查三个依赖都存在，不能仅用“已有成员与源码相同”替代完整性。
- 新 updater 与 Ask approval 测试加入统一 `check-personal` 入口，不只依赖临时手动命令。
- 移除测试文件末尾多余空行；不提高文件预算或修改其检查逻辑。

## 重新打包的组件归档

main 有源码修复，不能把旧归档当作合并源码。当前未发布的 `.rotom.4` 由合并后的源码重新 pack；native 源码没有额外变化，因此复用审核归档中已构建的原生字节，不重新签个人身份或启动 helper。

| 项目 | 候选结果 |
|---|---|
| 路径 | `rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.4.tgz` |
| SHA-256 | `591566a595a1591004414ec8584676cd94f3dfbb55d8e0c42a79a338868e6abd` |
| SRI | `sha512-4RQL4B1vLz0+iPe2Z9A8if5WL/OTHT5IC6kCZTfJnMPL0tcSyXMoFeayXJCPdhApLlseQXWTHVtjkgUtOVjpDA==` |
| 文件 / 大小 | 144 文件；压缩 6,440,544 字节；解包 18,394,242 字节 |
| 源码一致性 | 136 个非 prebuilt 文件与合并后的组件源码逐字节相同 |
| native 一致性 | 8 个 prebuilt 文件与审核 `.4` 逐字节相同，包括全部 macOS、Windows、Linux 产物 |

阶段 2 文档的 `d3af…` 摘要是当时审核分支的历史产物，不是本候选。此次不是已经公开 npm 版本的覆盖，也不是 `0.2.0` 产品发布 tgz。

## 上下文合同：先隔离 main 既有漂移，再校准候选

完整 `check-personal` 的产品测试 584 项、Provider 离线检查和 Goal 测试 99 项通过后，最后的 schema 字节合同报错。为区分来源，从同一公开 `1fbb1a3` 建立未修改的 control 仓库，按 main 锁文件安装 `.rotom.3` 与同一 Pi/Ask；control 也触发同一合同失败。不是本候选把工具数量或 guideline 无意扩大。

| 实测模式 | 未修改 main：工具数 / 规范化 schema bytes / guideline bytes | 候选：工具数 / 规范化 schema bytes / guideline bytes |
|---|---|---|
| default | 26 / 31,448 / 9,939 | 26 / 31,720 / 9,939 |
| full、unscoped | 33 / 47,546 / 11,855 | 33 / 48,359 / 11,855 |
| full、owned scope | 33 / 46,770 / 12,490 | 33 / 47,583 / 12,490 |

旧 current 常量尚为 default 29,684；full 为 27 工具、37,656 schema bytes；owned full 为 36,880 schema bytes。候选集成时需要更新当前合同，而不是继续把已存在的 main 工具面当成旧值。

独立用真实 Pi loader 加载两个实际组件归档的工具定义，仅有两项 schema 变化：`act_ui` 的 AXOpen 新分支 **+272 bytes**，`cu_session` 的显式接管目标字段 **+541 bytes**。默认常驻面只增加前者；full 增加合计 813 bytes。工具数和 guideline bytes 相对同一 main 均不变。所有 footprint smoke 均为 faux provider，真实模型调用为 0；这些是静态字节，不是 provider token 或成本收益。

因此只校准 `report-context-footprint.mjs` 中的三个 current 精确值和过时的 deferred 分组说明；不改历史 `REFERENCE_CONTEXT_FOOTPRINT_V1`，不改变测量、比较逻辑或容差。原有“多 1 byte 即失败”、缺工具、缺 Goal schema 等负例保留。owned 模式第一次因隔离环境尚无 execution-store anchor 而被拒绝；随后通过 launcher 同一 `initializeExecutionStore` API 在本次临时目录初始化空 store 再测，没有采用日常 store、没有伪造 marker 或创建子任务。

## 验证范围与审核门

最终代码和归档完成后，在 Node 24.18.0、隔离 HOME/TMPDIR/cache、禁用 Computer Use broker 的维护环境顺序执行；不并发重度测试。`ROTOM_PI` 使用当前安装的 Pi 1.4.0-rotom.4 的 canonical 绝对路径。

| 检查 | 最终结果 |
|---|---|
| 组件 `npm test`（含完整 typecheck） | 315/315；0 skip |
| `rotom/bin/check-personal` 产品/分发/归档/新 updater/Ask 等 | 597/597；0 skip；完整脚本 exit 0 |
| 同一入口的 Provider 离线门 | 282 个 Qoder + 98 个 Pi AI 测试、7 个 smoke，全 PASS；无真实模型调用 |
| 同一入口的 Goal | 99/99；0 skip |
| `report-context-footprint.mjs` | default、full、full+Context Layers off、owned full 的真实 SDK faux-provider smoke 和精确合同均 PASS |
| `cu-v2-script-dry-run.mjs` | 38 pass、0 fail、3 real-machine skip（L2、helper crash isolation、HID 前台恢复） |
| 章程与 ledger hook 测试 | 14/14；完整 ledger schema/source 校验 77 条通过 |
| 原生签名 | arm64、x64、universal 三个产物 `codesign --verify --strict` 通过；与已审核归档逐字节相同 |
| 内容保留 | 212 个不与 main 重叠的已批准源文件逐字节保留；11 个差异均为本文说明的文档、Ask、职责拆分、归档和 updater 检查；main-only 只改两个领域合同、统一测试入口和 footprint current 值 |
| 隐私扫描 | 当前树 8,977 文件 / 0 findings；实际组件 tgz 145 扫描项 / 0 findings；提交前本 clone refs 可达历史 543 commits / 0 findings（main/tags，非全部 origin 分支） |
| 日常 helper 只读回验 | 可执行文件 SHA、PID、启动时间与本轮开始时完全一致 |

命令：`python3 scripts/audit-public.py --root .`、同命令加 `--artifact <component-tgz>`、加 `--history`。归档检查项包括 tgz 自身与 144 个成员。历史扫描在提交后还要再跑；最终 SHA、提交后审计数和远端确认在交付报告中给出。扫描是启发式文本检查，不证明任意秘密、OCR 内容或代码所有权。

早期失败保留为诊断证据：干净 clone 缺源码测试依赖；`/tmp` 非 canonical 的 Pi 路径被 identity gate 拒绝；main 已存在的 footprint 漂移；历史协议句式不匹配；上述安装器拆分遗漏。分别按锁文件补齐、改用 canonical 路径、对照实测校准、修正文档、恢复依赖/导入后，才取得本表最终结果；没有放宽断言或重试失败外部写入。

这些检查不运行日常 helper，也不执行真实 Finder、L2/HID、ScreenCaptureKit 授权或真实个人证书签名。helper 的最终产品安装/启动/diagnostics 仍留到发布 artifact 验收；不能用本轮离线检查代替。

候选推送成功后等待审核。若本会话推送失败，按用户要求停止并交接精确命令，不尝试其他传输或 API 重建提交。
