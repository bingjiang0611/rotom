# Qoder：三模型图片与大上下文验证

> 本页逐阶段记录至 alpha.5 的产物与安装证据；当前产品版本可能更新，以 `rotom/package.json` 为准，认证默认值以 [产品说明](../../rotom/README.md) 为准。旧版本的通过、失败和授权不等于最新产物已重新验收。

## 范围与状态

仅 `ultimate`（Ultimate）、`kmodel_latest`（Kimi-K3）、`dfmodel`（DeepSeek-V4-Flash）。用户授权图片、至少 272,000 tokens 上下文，以及 Ultimate 固定 COSY 调研；沿用原私有 ledger，不清零；原1500次维护自限在最终安装复验阶段调至1700，授权范围不变，不是货币预算。输出上限仍为 4096。

**源码、候选包与实际全局入口均已验收；`rotom@0.1.0-alpha.4` 已交付。** 验收期间发现公开 `rotom` 入口已不是原 npm global package，而是另一任务当时正在交付的 `~/.local/share/rotom/releases/<version>` 安装（alpha.1 → alpha.3）。待对方任务结束并经维护者确认后，本任务才按同一发布机制交付 alpha.4，未覆盖任何旧发布目录或用户状态。

- 三模型声明 **272,000 管理窗口**（维护者要求与 Codex `gpt-6-astra` 的 272,000 对齐，好让同一 `reserveTokens` 得到同一压缩百分比），固定使用已实测的 **400,000 COSY selector**。
- **窗口口径变更的后果，按 Pi 实际公式 `available = 窗口 − 上下文 − 4096` 记录**：要拿满 4096 输出，单请求输入须 ≤ 窗口 − 8192 = **263,808**。因此 **≥272K 单请求输入自本版起是已实测的上游能力，不再是产品窗口容量**；早期 278K–282K 的产品用例按 250K 口径重跑，旧结果保留但不再代表当前默认。无法压缩的超大单轮会被削减回答预算，而不是报错。
- 日常由 Pi 原生自动压缩兜住：默认 `reserveTokens` 16384 → 255,616 触发；本机配置 27200 → 244,800（90%）触发。产品不改 Pi 预算、不抬 4096 输出上限。
- 272K/图片必须与当前绑定账号目录交集：有效 `400K.token_count=400000` 才扩展容量，`is_vl=true` 才开放图片；缺失/失效不继承旧能力。启动声明携带三模型已验证上限，供 Pi 在 `session_start` 前解析显式/恢复模型；未发现目录时可用集合仍仅 baseline，派发重验当前目录，收窄时拒绝 stale maxima，不通过主动 setModel 改用户选择。
- 支持 inline canonical base64 的 PNG/JPEG/WebP；单图 ≤4 MiB、历史图片合计 ≤6 MiB、≤32 张，最终 COSY body ≤24 MiB。只验证格式头和有界编码，不冒充完整图片解码器。远程 URL、其他格式/角色/别名及 hook 注入在认证前拒绝。
- 其余 14 项保持文本、≤32K。Ultimate 改为单一 COSY POST：总计十条 COSY、七条 direct；没有失败后回退、CLI/WASM 或远程 agent。
- 保留旧 `rotom-qoder-ultimate-v1` 双字段 item；新 `rotom-qoder-ultimate-cosy-v1` 完整封装 `{id,encrypted_content,target_hash}`。不冒用 Sonus 格式、不解密或重算 hash、不放过未知字段。旧 direct 的特殊 index 重用规则未扩大到 COSY。
- Ultimate COSY 的现代 `tool_calls` + `function_call` 终止只在该固定协议规范化；完整参数、usage、DONE/精确 metrics、EOF 与迟到错误门禁保留。

## 检查器

- `vision-capacity-smoke.mjs --offline|--research|--product <key>`：真实 Pi serializer/parser，四张彼此不同、带像素噪声的合成网格；首轮同时识别 PNG/JPEG、工具返回 WebP、再次恢复后识别新 PNG。三轮、两次原生磁盘恢复，精确坐标和 marker，逐请求检查全部图片及已观察 opaque 原样回传。工具仅返回合成图片/marker。
- `large-context-probe.mjs --live <key> <rows> 272000`：随机记录，八个相距很远的位置；工具仅返回新 marker，不返回数据答案。磁盘恢复后查另八条；Ultimate 观察到 opaque 后再恢复并查第三组。真实服务 input usage 必须 ≥272K；产品用例同时断言实际 `max_tokens=4096`、selector=400K。
- `ROTOM_QODER_PROBE_PRODUCT_ROOT` 选择实际 Provider；未设置时为显式研究 adapter。`ROTOM_QODER_OLD_PRODUCT_ROOT` 允许小型旧版 direct→COSY 桥接；它不是产品自动路由策略。
- `input-budget-smoke.mjs`：真实原生 SDK、假上游、零网络，覆盖三模型在 272K 历史后的原生输出预算。
- `long-cli-smoke.mjs --capacity`：实际安装的 `bin/rotom`，不传维护 Pi 覆盖；≥272K 图片请求、独立 recent turn、原生手动压缩、相同 session 进程重启、新图片与原 anchor 精确恢复。复用原 RPC/进程组清理，不降低 native safety/reserve。
- `long-session-smoke.mjs` 的 COSY 离线 fixture 使用真实 envelope、独立工具 index 和新三字段 signature；旧 direct 重复 index 仍有单独严格回归。
- 图片/记录均为私有合成数据，不重放用户业务历史；诊断仅字段类型、长度、计数、固定状态，不保存原始 HTTP、图片、工具参数或 opaque 值。原生合成 session 单独私有保存。

## 已完成的研究与源码证据

| 层级 / 模型 | 服务 input tokens | 结果 |
|---|---|---|
| 研究 Kimi-K3 / 14554 rows | 282850 / 283468 | 两组检索、工具、磁盘 PASS |
| 研究 DeepSeek Flash / 14266 rows | 282718 / 283320 | 两组检索、工具、磁盘 PASS |
| 研究 Ultimate COSY / 15000 rows | 294125 / 294455 / 294722 | 三组检索、两次恢复、新 opaque replay PASS |
| 最终 300K 源码 Ultimate / 14200 rows | 278465 / 278784 / 279056 | 三组精确检索、opaque 与两次恢复 PASS |
| 最终 300K 源码 Kimi-K3 / 14200 rows | 275886 / 276487 | 两组精确检索、工具/恢复 PASS |
| 最终 300K 源码 DeepSeek Flash / 14200 rows | 281527 / 282126 | 两组精确检索、工具/恢复 PASS |

三模型图片：研究与初轮源码 Provider 各三轮 PASS；每例四张 PNG/JPEG/WebP/PNG，两个初始附件、一个工具附件、一个新用户附件；单图约 0.1–0.47 MB，两次磁盘恢复，图片与坐标精确断言。源码 Ultimate 混合大输入另有279226 /279662 /280056 PASS，ledger1339；其余混合覆盖直接在最终安装包完成。

旧版隔离安装产生真实双字段 signature 后，接入 COSY 研究 adapter：三轮全部精确，旧、新两种 item 在同一历史完整回传；3 模型 +1 目录请求 PASS。最终实际 Provider 桥接见下。

Ultimate 源码五档各两轮 native SDK/工具/磁盘 PASS，精确 effort 和 COSY 三处状态一致；这些简短档位案例未观察到 opaque，不能虚构回传次数，也不证明内部计算强度或 token/延迟单调。

图片源验证前后、各大输入用例均检查隔离凭据未变。研究、源码与安装各层分开记账，全部沿用同一 ledger。

## 保留的失败与预算修正

- Ultimate direct：小输入约 63K 可用，但约 210K/283K、split、1M selector 和大空白请求得到 HTTP 500；gzip 得到 400。不能断言仅为 token 或字节限制，不作失败后回退。用户另行授权固定 COSY。
- 曾误套 CLI gRPC 的字符串 metadata selector；核对 HTTP serializer 后恢复 numeric root `context_length`，保留失败与回归。
- Ultimate COSY 首例拒绝 `function_call`；随后三字段 opaque 被旧双字段 normalizer 拒绝。根据有界类型/长度证据引入独立新格式，未删字段绕过。
- 初轮源码 Kimi 267109、DeepSeek 271881 未达 272K：**覆盖失败**，没有降低输入断言。
- 旧候选将 Pi 总窗口也写成 272K。Kimi 在 291560/292179、276137/276743 输入的第二轮返回 `length`；Ultimate 约 294K 的第三组查询也未通过，细分差异未保存，仍保留 FAIL。
- 原生 SDK 离线重放确认：272K 总窗口 +272K 以上历史，会把请求的 4096 压成 **1**。这是总窗口与输入目标混淆，不是通过增加输出上限修复。改为 300K 总窗口，保留 Pi 原生 safety/reserve/clamp，后端 selector 仍为 400K；真实三模型新例均断言线上的 4096。
- 初版发行包 SDK/20轮 AgentSession 通过，但真实 CLI 启动仍持有32K/纯文本声明；该容量前置检查失败，0模型请求。只读RPC再次确认此metadata。修正三模型启动的已验证上限声明，保留未发现目录时仅baseline可用、当前目录派发门禁与收窄拒绝；不主动setModel、不修改Pi或用户thinking。已重新 fresh 构建、安装并取得 CLI PASS。
- 本地旧版桥接首次错用 Provider 方法路径，只有 1 次目录、0 次模型；修正后独立案例通过。离线 long fixture 的旧 direct envelope/index 不适用于 COSY，已修正 fixture，没有扩大产品 index 容错。

- 初版 CLI 容量修正后，首个278536输入图片已识别准确，但单个巨大 user turn 不存在合法压缩切点，返回 `compaction_not_eligible`。补一个正常、超过 keepRecentTokens 的 recent turn 后独立用例通过；未更改压缩内部规则。
- 新声明下旧离线 long catalog 缺少400K selector，按预期在0模型派发处拒绝 `catalog_changed_select_again`。正例 fixture 更新为当前已测目录；收窄负例仍独立保留。
- 最终安装 DeepSeek 混合例首次282321输入：工具数量/字段与nonce正确，但两图四个坐标均错，严格 oracle FAIL。独立新图/新数据的同约束 case2 三轮 PASS；未改图、降输入或放宽断言，也未把首例重标成功。能力支持不代表视觉/业务答案总是正确。

## 最终发行包与安装验收

任务隔离分支基于 `4c8e31f`，没有混入后来 Subagent 主分支改动。第二个发行包才是最终候选；首包的启动声明失败保留。

- `rotom-0.1.0-alpha.0.tgz`：9,301,927 bytes，3797 files，Pi0.85.1，`private:true`，未发布。
- SRI：`sha512-6RzUh3Q8e4aM3ZHdBjJla/mDywzr92/AqGPPAMoWUpU0R1AJbZxUvWJ1TO1iyMIA78mV/1Syt23NFc8HGtRTZQ==`。
- `pack:release` 在隔离 HOME/cache 中重新按锁安装，未复制维护 node_modules。tree/tgz audit、分发门禁通过。安装逐文件3797项匹配，只有 README 与4个Qoder运行时模块不同于已交付基线，未发现依赖目录外额外文件。
- 最终定向192、`check-personal`333、资源/分发48、Qoder TypeScript、语法及 diff 检查通过。
- 实际安装 SDK 的17路离线回放、三模型272K历史输出预算、20轮离线、default/CLI/browser/full 四种真实资源 profile 通过，离线检查阻断网络。

| 最终安装 / 模型 | 服务 input tokens | 精确验证 / ledger |
|---|---|---|
| 文本大输入 Ultimate | 278403 /278720 /278997 | 三组不同检索、两次恢复、2个opaque保留 /1440 |
| 文本大输入 Kimi-K3 | 276320 /276932 | 两组不同检索、工具/恢复 /1443 |
| 文本大输入 DeepSeek Flash | 281413 /282033 | 两组不同检索、工具/恢复 /1446 |
| 图片+大输入 Ultimate | 279181 /279620 /280014 | 四图、两次恢复、全部图片与opaque回传 /1426 |
| 图片+大输入 Kimi-K3 | 276757 /277323 /277783 | 四图、两次恢复、全部图片回传 /1430 |
| 图片+大输入 DeepSeek Flash case2 | 281891 /282334 /282665 | 四图、两次恢复、全部图片回传；另有上列FAIL /1436 |

以上大输入产品请求均逐请求验证固定400K selector和4096输出预算。

- Ultimate 五档各两轮：10模型+1目录、5次精确工具结果回传 PASS，ledger1457。本组未观察opaque，不能算加密回传证据；catalog报告off但产品仍排除off。
- **旧已交付安装 → 新实际 Provider**：首轮旧 direct 产生真实双字段 signature，后两轮固定 COSY；21579 /20553 /20828 input，三组检索、两次恢复、旧新2个item共同保留、2次完整回传；3模型+2目录 PASS，ledger1462。
- 最终 Ultimate AgentSession：20轮、20读+20检查+20写、3次手动压缩、1次磁盘恢复、五档；峰值22416，69模型+2目录、无模型错误/协议诊断，PASS，ledger1533。原生reserve16384，fixture keepRecent64、每6轮手动压缩；不冒充默认自动压缩策略验证。
- 实际 launcher/RPC `--capacity`：启动声明300K/图片、3用户轮、峰值284402、1次压缩+1次进程重启；两张不同图和压缩后anchor均精确；6请求，两次空闲终止均0进程残留。前置 `--preflight` 仅1目录、0模型，五档设置可用。
- 各 live fixture 的隔离源/副本凭据比较均未变；这不是长时间窗内全部全局 auth 目录未变的证明。

私有证据目录 `rotom-image-context.Cnvw2G`：`output-2/`、`installed-2/{mixed,large,efforts.json,old-new-bridge.json,long-ultimate.json,cli-capacity-2.json}`、离线/profile/audit日志。最终 ledger **1533** /维护自限1700。

## 基于当前发布版的重做验收

按维护者选择，把本任务单一提交 rebase 到当前主线 `2404bba`（`0.1.0-alpha.3`，已含另一任务的 Subagent 内部化与 scoped 默认），无冲突，仍为同一 26 文件 610/70。

- 重做后首次 `check-personal` **失败 6 项**：工作区第三方依赖仍为旧锁 `pi-subagents 0.52.1-dev-agent-followthrough.2`，与新合约 `0.52.1-rotom.1` 不匹配。按新锁在隔离 HOME/cache 重新 `npm ci` 后通过；未改合约或绕过身份校验。
- 重做候选：`rotom-0.1.0-alpha.3.tgz`，9,368,415 bytes，3805 files，Pi0.85.1，SRI `sha512-2c1/zrCLr/3f5driXdsgCrUoZG2tupHfPPeA8Hq1i81Drbv8BhwODu/ptCzsVHSIMazI0pbK5UBig3eSG6k0kQ==`，`private:true`，未发布。
- 定向 192、`check-personal` 333、资源/分发 49、Qoder TypeScript、tree audit 与 diff 检查通过。安装逐文件 3805 项与 tgz 一致；与用户当前 alpha.3 安装相比，只有 README 与四个 Qoder 模块属于本任务，另有一份对方 lane 在 `2404bba` 才改的 vendor 说明（已逐字节证明来自对方提交，非本任务修改）。
- 四个 Qoder 运行时模块与已完成全量 live 验收的 alpha.0 候选包**逐字节相同**，Pi 入口相同；`bin/rotom-launcher`、`product-config.mjs`、README 不同。因此重做后按风险重跑 launcher/产品路径，不重复全量模型矩阵；不把 alpha.0 的 live 结果当作本包直接证据。
- 重做安装离线：17 路 SDK 回放、三模型 272K 历史输出预算、20 轮 Ultimate 长会话、default/CLI/browser/full 四种资源 profile 全部通过。
- 重做安装 live：实际 launcher/RPC `--preflight` 1 目录/0 模型；`--capacity` 声明 300K/图片、峰值 **284445**、3 轮、1 次压缩 +1 次进程重启、两张不同图与 anchor 精确；0 进程残留。Ultimate 图片+大输入 279023 /279456 /279851 三轮 PASS，含全部图片与 opaque 回传。
- Kimi 重做大输入首例 276032：流完整、单工具、协议无错，但首轮检索值不符，**保留 FAIL**（模型检索准确率，不是容量/协议回退）。独立新数据 case2 为 276020 /276479 两组精确检索 + 磁盘恢复 PASS；未降输入、未放宽断言、未重标首例。
- 重做阶段 ledger 1533 → **1549**（预检 1534、CLI 1540、Ultimate 混合 1544、Kimi FAIL 1546、case2 1549），隔离凭据未变。证据在 `output-3/`、`installed-3/`、`rebase-*.log`。

## 全局交付阻塞

## 窗口口径对齐 272K（本轮最后一次变更）

维护者在 alpha.4 交付后要求把三模型窗口从 300,000 改为 **272,000**，与 Codex 声明及其 `reserveTokens=27200`（90%）对齐。我先明确反对过一次：这会使 ≥272K 单请求输入不可用；维护者在知情后仍要求执行，故按下述口径变更，而不是悄悄保留旧断言。

- 产品：`inputCapabilities` 与启动声明改为 272,000，selector 仍固定 400,000，输出仍 ≤4096，能力仍须与当前账号目录交集。
- 检查器：`input-budget-smoke.mjs` 现同时断言 **244,000 历史仍得 4096** 与 **272,000 历史被压成 1**（悬崖显式化）；`large-context-probe.mjs` 断言窗口 272,000 且最低输入不得超过窗口−8192；`vision-capacity-smoke.mjs` padded 口径降为 ≥250,000；`long-cli-smoke --capacity` 改为 12,600 行、峰值 ≥250,000。
- 离线复验（真实 SDK/无网络）：三模型预算用例 PASS（`fullOutputInputCeiling` 263,808）；三模型图片+大输入 PASS；`large-context-probe --offline` PASS；20 轮 Ultimate 长会话 PASS；`check-personal` 334、资源/分发 49、Qoder TypeScript PASS。

### 272K 窗口的安装与交付验收（alpha.5）

包 `rotom-0.1.0-alpha.5.tgz`：9,369,381 bytes / 3805 files / Pi0.85.1，SRI `sha512-FKa6Uc67OKpjsS8pXxS4WHGKaCeHcQDOUQI222cUMsbyLxVw40vlY4evqfMUXaGv4Xgc4vDWZReCEf/8IrjWoQ==`，`private:true` 未发布。

| 安装验收 | 结果 |
|---|---|
| 离线 17 路 SDK / default+full 资源 profile | PASS |
| 三模型输出预算（真实 SDK/假上游） | 窗口 272000；244K 历史保 4096，272K 历史压成 1，`fullOutputInputCeiling` 263,808 |
| 真实 launcher/RPC `--capacity` | PASS：声明 272000/图片、峰值 **261,065**、3 轮、1 次压缩 +1 次进程重启、两张不同图与 anchor 精确、0 残留（ledger 1564）|
| 图片+大输入 Ultimate | PASS 255573 /256015 /256415，四图、两次磁盘恢复、opaque 回传（1570）|
| 图片+大输入 Kimi-K3 | PASS 253620 /254193 /254656（1574）|
| 图片+大输入 DeepSeek Flash | 首例 258214 **FAIL**（工具/协议正常，两图坐标不符）；独立 case2 258231 /258694 /258997 PASS（1576 / 1580）|

口径下调后保留的两处 coverage FAIL：CLI 12,600 行只到 247,406、混合 12,600 行只到 247,745，均低于 250,000 阈值；改为 13,000 行后通过，未降低断言。最终 ledger **1580**。

## 全局交付

对方 lane 结束后经维护者确认才执行。因它的 alpha.3 已占用同名发布目录，本次把产品版本从 `0.1.0-alpha.3` 升到 **`0.1.0-alpha.4`** 并重新构建，而不是用同版号覆写它的归档。

### 最终交付（alpha.5，272K 窗口）

**两处如实记录**：交付的 alpha.5 构建自主线 `db36375`，因此仍包含主线随后 revert（`efbed4b`，其自身 A/B 结论为无行为改变）的 coding-policy prompt；为去掉它而重打的 alpha.6 连续四次 `npm ETIMEDOUT` 未产出归档，故未交付，也未手改已安装目录绕过归档一致性。窗口口径变更本身不受影响。

alpha.4 交付后按维护者要求改窗口，故再发一版并重新回读：新建 `releases/0.1.0-alpha.5/`、离线 `npm install --prefix`、rename 原子切换 symlink（旧目标 alpha.4 已记录 inode）。

- 回读：安装 3805 文件与归档逐字节一致，入口指向 alpha.5，`package.json` 版本 alpha.5；**12 项**保护坐标全部未变（新增 alpha.4 发布目录）。
- 真实全局入口 `--preflight`：声明 **272000 / [text,image]**、五档可设、1 目录 0 模型请求，隔离凭据未变。最终 ledger **1581**。
- `pack:release` 的第二次独立复算构建因 npm 拉取 ETIMEDOUT 失败并保留；交付用的是已实测安装验收过的同一 fresh-lockfile 归档，其后改动只涉及未打包的报告与检查器。

- 交付包 `rotom-0.1.0-alpha.4.tgz`：9,368,414 bytes / 3805 files / Pi0.85.1，SRI `sha512-dN/0OL9lmhT6rY+G19wP/72Bs2gN7vPkS4LaacaSaB6fIrvTVRRcZFoM6VOcaN7FxqmzLrDOfP7qifgK+agCZw==`；仍 `private:true`、未发布。
- 版本升级后重跑：定向 180、`check-personal` 333、资源/分发 49、tree audit、安装逐文件 3805 项；与用户原 alpha.3 安装相比，差异仅为本任务的 README/四个 Qoder 模块 + 版本两个清单文件，另一份 vendor 说明已证明来自对方提交。
- 离线重验：17 路 SDK、三模型 272K 输出预算、20 轮长会话、四种资源 profile 全部通过。
- 安装方式沿用对方已文档化的机制：新建 `releases/0.1.0-alpha.4/`、离线 `npm install --prefix`，然后用 rename 原子切换 `bin/rotom` symlink（旧目标 alpha.3 已记录）。
- 交付后 readback：安装 3805 文件与归档逐字节一致、入口指向 alpha.4、`package.json` 版本为 alpha.4；11 项保护坐标均未变（shell、原生/CLI 凭据、scoped manifest、历史 bin、旧全局 npm package、退役 profile、alpha.1/2/3 发布目录、subagent store）。
- 真实全局入口验收（不传维护 `ROTOM_PI`）：`--preflight` 1 目录/0 模型；`--capacity` 声明 300K/图片、峰值 **284798**、3 轮、1 次压缩 +1 次进程重启、两张不同图与 anchor 精确、0 工具/错误/进程残留，源与子进程凭据均未变。最终 ledger **1556**。
- 已存活进程仍持旧路径，需重启才用新包；交付不迁移、不升级、不回放任何现有会话，Qoder 仍为 `ROTOM_QODER=1` 显式 opt-in。

已交付包基于本任务提交与其当时的父提交 `2404bba` 构建。合入前主线又出现一条 coding-policy 提交，其 `extensions/coding-policy/index.ts` **不在** alpha.4 包内；该改动由对应任务自行交付，本任务未代为发布或验证它。

未验证：本包的 Linux/Windows、真实桌面 TUI 渲染、业务效果与 npm 发布。

不覆盖：其余模型图片/大容量、完整 400K/1M、其他格式/模态、任意业务检索准确率、自然到期刷新或桌面视觉验收。Credit 与 USD 区分；新路由不假定与旧 direct 同价，未报告的消费仍为 unknown。
