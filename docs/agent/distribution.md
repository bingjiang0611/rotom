# rotom · npm 分发

## 0.1.12 发布准备

预期 npm dist-tag 为 `latest`，包保持 `@bingjiang0611/rotom`、公开 access 与 `UNLICENSED`。本节是构建前发行说明，不表示版本已经发布；公开状态仍须由 registry 的精确 version/tag/digest 与最终 tgz 字节一致性证明。

- Goal 内化组件升级为 `0.54.4-rotom.5`：默认自动响应额度从 25 提升至 100，显式用户设置优先；展示剩余额度和最近声明的下一步计划。计划不是已验证进展，也不授权重放写入；原有预算、无进展暂停、显式续跑和完成审阅边界不变。
- 保留 session-efficiency 可重复评测及负结果。歧义 edit 预览和全局 context-efficiency 提示因未证明净收益而不进入运行时；不宣称一般 token 或成本下降。
- 同步已上线 Browser 查询/回退描述的精确 footprint 与 eval 断言，补齐默认 Qoder 资源列表，按实际 trace 字节数构造 fixture 并保留负向检查；不放宽身份或元数据校验。
- 修复 trace dashboard 在输出就绪 URL 后、注册信号处理器前收到 Ctrl+C 时不能正常退出的竞态。

仅发行已提交源码；不包含维护工作区未提交的 Pi retry 改动。活跃会话与浏览器绑定不热迁移，安装后须新开会话。

## 0.1.11 发布准备

本版修复交互会话退出提示错误显示 `pi --session ...`：launcher 现在在 Pi SDK 首次 import 前写入经过产品 manifest 校验的 rotom 版本，使 Pi 的 import-time 品牌常量稳定选择 `rotom`。回归测试显式注入伪造的父进程版本，并证明 SDK 在 import 时已看到当前产品版本；不改变底层进程兼容名称、session ID、session 目录或恢复语义。

发布目标为 `@bingjiang0611/rotom@0.1.11`、`latest`、public access、`UNLICENSED`。发布仍由维护者按 `npm-release-handoff.mjs` 输出在前台终端完成；准备阶段不修改活动安装或存活会话。

## 0.1.10 正式发布

`0.1.10` 于 2026-09-18 从公开 `main` 的 `5c7c397e2e621a9b0a0d03260f0dc5275b6e1ff7` 构建并发布，`latest=0.1.10`。registry 下载包与唯一最终 tgz 逐字节一致：17,918 个文件，53,399,660 bytes；SHA-256 `e736afd9a1844f2710816feb2463f386d374336c306a9849f8c1981bc9bb7cf1`，shasum `44e7465d20f2256f940e1e7aa3bc8a336e7578c0`，SRI `sha512-n7R9siL+GvWV9zSsih1xGbtxrt0kvIYUIAcLKxbc3mTGK3ajO02fZQj/OtLHjgGRsnTLYMn1WhsGN/x/XrUrRA==`。

本版汇总 Subagent Qoder provider 修复：当 reviewer/worker/scout 继承 `qoder/*` 模型时，隔离子进程显式加载已验证产品中的 Qoder provider，同时继续关闭 ambient extensions、保持原工具白名单和原模型选择。`ROTOM_QODER=0` 或 capability ceiling 禁止子扩展时在启动前拒绝，不自动换模型；其他自定义 provider 仍需显式 child 配置。组件升级为 `pi-subagents@0.52.1-rotom.3`，锁文件、归档、integrity 和产品资源合同同步。

最终 tgz 通过 pack gate、tree/history 与归档隐私审计、24 项 distribution、隔离安装、版本/帮助、default/full runtime smoke、`0.1.9`→`0.1.10` 升级和卸载；发布后 registry 字节回读及维护机版本化安装的 default/full smoke 再次通过。本机命令已切换至 `~/.local/share/rotom/releases/0.1.10`；旧的存活会话没有热加载或重放。离线真实 Pi CLI/RPC 回归只证明 `qoder/ultimate:high` 在禁用 ambient extensions 时可选择，没有发送真实 Qoder 推理，也不证明账号目录、额度或远端 reviewer 成功。

## 0.1.9 正式发布

`0.1.9` 于 2026-09-17 从公开 `main` 的 `c6b0d6302b7af0064ec4e7035214594ca259fee` 构建并发布，`publishConfig.access=public`，许可证保持 `UNLICENSED`。registry 确认精确版本、`latest=0.1.9`、integrity、shasum 与 tarball URL（`https://registry.npmjs.org/@bingjiang0611/rotom/-/rotom-0.1.9.tgz`）。下载 tarball 与唯一最终 tgz 逐字节一致：17,918 个文件，53,396,875 bytes；SHA-256 `c223707f4f08fa8189ff7c179d536e8583ff6b4f7fd90103640ff1a6f1d9f5f3`，shasum `f026d870cd295a649cff647af09f49d06cefc7e4`，SRI `sha512-3WPuEKGMvn3ENMPGJ9ml0DU0bSJsXh7q9ugmtmgK0AqHGt31IeitUF3V7FHozNpWNFP7qn5VglLvsgWEPtH4Cg==`。

发布前最终 tgz 通过 pack gate、tree/history 隐私审计、隔离安装、`rotom --version`（0.1.9）、CLI help 与 24 项 `test:distribution`；安装包不包含维护用 smoke 脚本，因此未将安装包外部 smoke 冒充为完整安装面 runtime smoke。npm 首次 publish 触发 EOTP，用户完成官方网页 2FA 后以同一命令和同一 tgz 完成发布；后续 registry 与字节核验通过。随后按用户要求将本机全局 npm 安装更新为 0.1.9，更新后版本回读通过。已安装 Browser Relay 组件与当前发行内容一致，Chrome 扩展此前已由用户手动重载；未自动重载存活会话。

本次版本包含 Browser Relay protocol 20 / Chrome extension 0.10.0 的 Relay 端定向 AX/text 查询；真实 Qoder Ultimate + Chrome 合成页面验收记录见 [Browser 查询验收](browser-query-verification-2026-09-17.md)。该真实验收不外推为任意网站或完整产品 L3。

> 当前 registry 稳定版是 [`@bingjiang0611/rotom@0.1.9`](https://www.npmjs.com/package/@bingjiang0611/rotom/v/0.1.9)，npm dist-tag 为 `latest`。

## 0.1.8 正式发布

`0.1.8` 于 2026-09-17 从公开 `main` 的 `521e18266b16ba644d933e7c7c89f1fdfb20eab8` 构建并发布，`publishConfig.access=public`，许可证保持 `UNLICENSED`。官方 Versions 页显示 Published；registry 确认精确版本、`latest=0.1.8`、integrity、shasum 与 tarball URL（`https://registry.npmjs.org/@bingjiang0611/rotom/-/rotom-0.1.8.tgz`）。下载包与唯一最终 tgz 逐字节一致：17,918 个文件，压缩后 53,394,623 bytes，解包后 168,675,221 bytes；SHA-256 `2fcc70673050f46493e28fd355b25807e63e80779feb0b5576a66ee191e647ce`，shasum `abee78ef37ac80c3fa23be18ebf908478f55aff4`，SRI `sha512-y9Ktr4fY8gXkgvLbfZSrBjbxzN9TQfQNWn42+tevnSl0ruNagcNC7YQkSr33Kp7Vm2xX9ako5CjkVJ8NQz+J8g==`。

最终 tgz 通过隐私审计、隔离 HOME/prefix 的全新安装、全部 17,918 个安装文件与归档内容比对、`rotom --version`、实际安装面 default/full smoke（23/24 tools、footprint PASS）、`0.1.7 → 0.1.8` 升级及卸载。最终产物依赖用于冻结源码的维护测试：`check-personal` 的 530 项产品测试、65 项 Goal 测试及 footprint 全部通过，无跳过；冻结前另通过 `check:pi`、`test:distribution` 和 tree/history 审计。首次安装面 smoke 因维护脚本静态导入缺少测试依赖而失败，补齐来自最终 tgz 的依赖后通过；未修改或重打产物。本轮不新增真实模型、Linux 或真实 Chrome 业务验收。

首次 publish 明确返回 EOTP，确认 registry 尚无该版本后，由用户完成官方网页写操作认证，再以私有短时 web OTP 重放同一命令和 tgz。CLI 接收后官方页面显示 Validating，按合同暂停；审核期间没有再次 publish。用户要求继续后完成上述 registry 与字节核验。临时 CLI 登录已 logout，`npm whoami` 失败回读，认证/challenge 文件已删除；本机活跃安装未更新。

- Goal 更新至 `0.54.4-rotom.4`：证据驱动的澄清/授权暂停；三轮仅限制 `goal_blocked`，不为凑次数重复工作；审阅拒绝区分真实缺陷与证据缺口，不以重放成功/unknown 外部写入换取批准。工具、状态与 reviewer 限额不变，不宣称硬性副作用拦截。实测及局限见 [Ultimate 复测](../../experiments/goal-review/RETRY-RETEST.md)。
- 包含 Qoder 大图片请求修复；不扩大模型、effort、图片格式或受管上下文合同。
- 提交身份已按用户授权改用 GitHub noreply，原/新 SHA 对照见 [身份修正记录](history-identity-repair.md)。未新增隐私审计例外。
- 保持 `publishConfig.access=public`、官方 npm registry 与 `UNLICENSED`；Pi fork 版本不变。不更新活跃安装，也不把先前测试替代最终 `0.1.8` tgz 安装验证。

> 当前 registry 稳定版是 [`@bingjiang0611/rotom@0.1.8`](https://www.npmjs.com/package/@bingjiang0611/rotom/v/0.1.8)，npm dist-tag 为 `latest`。后续默认组件与 macOS/Linux 安装验证见 [Subagent 默认接入](subagent-default-integration.md)，发行包默认 scope 及其未复验项见 [scoped 默认](subagent-owned-default.md)。

当前版本使用仓内 Pi fork；构建、隔离安装、本机切换及未验证项见 [Pi fork 接入](pi-fork.md)。本页底部“首次分发”表仍是历史上游 Pi 基线，不代表新 fork 的跨平台验收。

## 0.1.7 正式发布

`0.1.7` 于 2026-09-16 从公开 `main` 的 `a7f6e7be51e346a9910d8011f8ee044e37713841` 构建并发布，`publishConfig.access=public`，许可证保持 `UNLICENSED`。registry 回读确认精确版本与 `latest=0.1.7`、integrity、shasum 和 tarball URL；下载 tarball 与唯一最终产物逐字节一致：17,918 个文件，压缩后 53,387,390 bytes，解包后 168,663,097 bytes，SHA-256 为 `ee3e78f6f4f55625b79104ca35d191d2557b623eb8313e64c2abeda2ccd7fd0a`，npm shasum 为 `1258ae11034e66629627d4e35f66ce062063a231`，SRI 为 `sha512-YtQa6lFfeE9r3Y0oa7aFeJC30IOz/iRQwY2Ombmdds/Mv4VMkPlYga7ldB/6KDG8eHOXM7t02LF4S8b5vkVPEQ==`。

最终 tgz 通过归档隐私审计、隔离全新安装、从 `0.1.6` 升级、`rotom --version`、安装面 default/full runtime smoke、`check-personal` 和卸载检查；冻结前另通过 `check:pi`、24 项 `test:distribution`、242 项 Qoder 测试、5 项 ModelsStore 测试、Pi fork 的 181 项通过/2 项跳过、OAuth/catalog/Ultimate 冷启动恢复 smoke，以及公开 tree/history 审计。本次版本将 Qoder 账号目录接入 Pi 原生 model store：只持久化已验证模型元数据、能力字段与非敏感账号摘要，不存储凭据；新进程可恢复默认 Ultimate，过期缓存继续保持模型选择但在推理前刷新，账号 scope 不匹配时拒绝恢复。不存在推理失败回退或跨账号目录复用。

首次明确 `EOTP` 后确认版本不存在，再由用户完成 npm 官方网页写操作认证。CLI 接收后 registry 暂不可见，官方 Versions 页显示 `Validating`，按合同暂停；进入 `Validating` 后未重复 publish，用户要求继续后才完成上述 registry 元数据与 tarball 字节回读。随后应用户明确要求，将当前 Node 环境的标准 npm 全局安装由 `0.1.6` 更新为 `0.1.7`；版本、随包 Pi resolver、launcher help 及本机实际安装面 default/full runtime smoke 均通过。更新时有存活会话，旧会话须重启；本次未自动重载 Chrome extension，也未追加真实模型推理或真实 Chrome 业务验收。

## 0.1.6 正式发布

`0.1.6` 于 2026-09-16 从公开 `main` 的 `ac1a1c7625ca0de3388d95d610980448bc1d0e48` 构建并发布，`publishConfig.access=public`，许可证保持 `UNLICENSED`。registry 回读确认精确版本与 `latest=0.1.6`、integrity、shasum 和 tarball URL；下载 tarball 与唯一最终产物逐字节一致：17,918 个文件，压缩后 53,384,454 bytes，解包后 168,659,206 bytes，SHA-256 为 `aec0b8cca52183b95e238d28e9c226f9c5f61a1d3a3063aafbc639aa8681b5ba`，npm shasum 为 `3f6423affcab544313d00da6356b43eb9cb00638`，SRI 为 `sha512-/d5NZurimQmsJ3NbRn6FDrKKo0RJGGONrXKsJ6G+R8kr8U6HHu2z6cOkTJem1srOJYz2tFCz3ezxewInqKRk9w==`。

最终 tgz 通过归档隐私审计、隔离全新安装、从 `0.1.5` 升级、`rotom --version`、实际安装面 default/full SDK smoke 和卸载检查；发行产物依赖用于公开维护测试，`check-personal` 的 528 项产品测试、30 项 Goal 测试及 footprint gate 全部通过。冻结前另通过 `check:pi`、24 项 `test:distribution` 和 tree/history 隐私审计。安装面 smoke 最初误用非 canonical 路径及未随包分发的维护脚本路径，改为由维护脚本加载实际安装资源后通过；未修改或重新打包产物。

首次明确 `EOTP` 后确认版本不存在，再由用户完成原生 npm CLI 网页 2FA。CLI 接收后 registry 暂不可见，官方 Versions 页显示 `Validating`，按合同暂停且未重复 publish；用户要求继续后才完成上述 registry 字节回读。临时登录已 logout，`npm whoami` 的未认证失败证实撤销。随后应用户明确要求，将本机标准 npm 全局安装由 `0.1.4` 更新为 `0.1.6`，版本和本机实际安装面 default/full smoke 均通过；更新时用户知悉有存活会话，旧会话须重启。本次未自动重载 Chrome extension。

本次汇总已同步公开源码的更新：单 Node 进程启动、Relay socket/标签所有权修复、后台全文读取覆盖证据，以及模型输出层不变正文去重和 Computer Use 焦点合同澄清。不增加自动重放或调用预算，不宣称固定 fixture 字节下降等于实际 token/成本收益。Browser 全文合同为 protocol 19 / extension 0.9.2；从旧版本升级该部分需用户重载 Chrome extension，新提示需新 Rotom session。已有功能验证的范围与未通过场景见 [Browser 验收](browser-verification-2026-09-15.md) 和 [架构说明](architecture.md)。本次发行不追加真实模型、真实 Chrome 业务或跨平台验收。

## 0.1.5 正式发布

`0.1.5` 于 2026-09-15 从公开 `main` 的 `9b690144c49f7733e895c9089a5a265f92a8f80e` 构建并发布，`publishConfig.access=public`，许可证保持 `UNLICENSED`。registry 回读确认精确版本与 `latest=0.1.5`，下载 tarball 与唯一最终产物逐字节一致：17,917 个文件，压缩后 53,378,914 bytes，解包后 168,648,528 bytes，SHA-256 为 `137c8f7e3036e22f2625e3e23e0af7f309fd7afd930c800beeb1aed185fc501f`，npm shasum 为 `699b3a7bd478e76ec56bcdd79305791542df9828`，SRI 为 `sha512-XnWeSFog1OrQ46nQjqGWcy9YWwa3UPI8ngiwDfSQ9lEp3y0sXZ7HJd9Mz3r39QB/ZBZxdvsfRy9Y10ELR1SyyA==`。

最终 tgz 通过归档隐私审计、隔离全新安装、从 `0.1.4` 升级、`rotom --version`、安装面 default/full SDK smoke 和卸载检查；其依赖字节用于公开维护测试，最终 `check-personal` 的 475 项产品测试、30 项 Goal 测试及 footprint gate 全部通过。冻结前另通过 `check:pi`、24 项 `test:distribution` 与公开 tree/history 审计。前期检查遇到测试 scope 未初始化、维护脚本不在发行包中的调用路径错误，以及高负载下一次 Browser fixture 超时；修正验证环境并重跑后通过，未改产品代码、未重新打包。本轮未追加真实模型、真实 Chrome 功能或跨平台验证，也未更新维护者当前安装。

发布认证由用户完成；首次明确 `EOTP` 后确认版本不存在，才以相同产物和命令进入原生 CLI 网页 2FA。CLI 的接收/处理中提示不作为发布成功；上述 registry 元数据与下载字节回读才是最终证明。

本次发布已同步公开的 Goal 改进：默认显式 `goal_continue`、有界只读 completion reviewer、完整 objective 验收，以及 Ultimate 实测驱动的审阅协议和过程证据修复。组件版本为 `0.54.4-rotom.2`，保留未知不重放、控制调用不算新工作、混合控制批次拒绝及既有资源边界。19 个固定 Ultimate 场景各两次均达到预期；不外推为任意任务完成率或外部业务验收。结果及此前综合门的一次 Subagent `ps` 观测超时见 [Goal 实测报告](../../experiments/goal-review/RESULTS.md)；该历史记录与本次独立发行 gate 分开报告。

## 0.1.4 发布准备（历史记录）

已授权发布 `@bingjiang0611/rotom@0.1.4`，预期 dist-tag 为 `latest`，`publishConfig.access=public`，许可证仍为 `UNLICENSED`。本节是冻结元数据与发行说明，尚不代表 registry 已公开；完成最终 tgz 验证和 registry 字节回读后再记录正式结果。本次不更新维护者本机安装。

本次发布此前已同步公开源码的长会话改进：完成声明绑定验证场景与版本，区分完整解析/完整阅读/抽样；精确编辑首行失配时以有界的后续唯一整行定位重读，不自动修改或重放。离线回归证明提示投递与机制行为，不宣称真实模型遵从率或 token/耗时收益。额外加载的 SoL-Pi 召回修复属于独立 package，不随本次 rotom 发布打包。详情见 [长会话改进](long-session-hardening.md)。

## 0.1.3 正式发布

`0.1.3` 于 2026-09-15 从公开 `main` 的 `9f95411` 构建并发布。registry 回读确认 `latest=0.1.3`，下载 tarball 与发布前最终产物逐字节一致：17,916 个文件，压缩后 53,385,829 bytes，解包后 168,654,822 bytes，SHA-256 为 `2d7db73326e7be11eed05228416c123715aedc748149004d9610df8147ce5442`，npm shasum 为 `0f3e488d591455780a767e61bf9b826b658a1e70`，SRI 为 `sha512-1dbwWLsEiiAGMl9CuEKpNfu8QM76MQV4il78wRLQ8sOLsPK7R+iFbKrjNQuK0NkfSX0/ajbWnOEDoi05TaMjUg==`。

本次加入仅支持常规全局 npm 安装的 `rotom update` 产品升级命令，固定 npm 官方 registry 返回的精确 latest 版本，写入前要求确认其他会话已退出，并拒绝 npm link、错误 prefix、降级和 Node 24 以下运行时；扩展更新仍独立执行。footer 的 Qoder Credit 已知小计只显示三位数字，不追加 partial 后缀，统计行末显示 `sid:<sessionId>`。最终 tgz 通过 tree/history 与归档隐私审计、`test:distribution`、`check:pi`、隔离安装、default/full runtime smoke、`check-personal`、从 `0.1.2` 到 `0.1.3` 的隔离升级及卸载验证。未执行真实模型或真实 Chrome 操作，也未覆盖维护者当前安装。

## 0.1.2 正式发布

`0.1.2` 于 2026-09-14 从公开 `main` 的 `7606055` 构建并发布。registry 回读确认 `latest=0.1.2`，下载 tarball 与发布前最终产物逐字节一致：17,915 个文件，压缩后 53,378,708 bytes，解包后 168,644,009 bytes，SHA-256 为 `43270cd0a8a4be21a1d32382fa45ea8a40c1b5fbe21487600a99cd16f158e188`，npm shasum 为 `f227fd210bb8c214c2654a99e5792ca5e1f9051d`，SRI 为 `sha512-jfKywQCu8fO38tchU7xyj02ReBUCuDaB6fY30Fe3t2qcadmFhFs2q8gfSK38VpADh0i6qzQ138Rulbbx1UkdkA==`。

该版本汇总此前尚未正式发布的更新：恢复启动时已保存的动态 Qoder 默认模型，细分并脱敏 Qoder 上游与 transport 诊断，通过 npm `latest` 检查提示 rotom 更新，明确区分产品与 Pi fork 版本及 extension-triggered compaction 来源，修复 fresh HOME 下 Browser Relay 安装，并在 dashboard 显示 trace/session 存储大小；同时保留图片模型的既有有界上下文合同。最终 tgz 通过 tree/history 与归档隐私审计、`test:distribution`、`check:pi`、隔离安装、`rotom --version`、default/full runtime smoke、462 项 `check-personal`、从 `0.1.0-alpha.16` 隔离升级及卸载验证。未执行真实模型或真实 Chrome 操作，也未覆盖维护者当前安装。

## 0.1.0 正式发布

`0.1.0` 于 2026-09-14 从公开 `main` 的 `e121a6b` 构建并发布。registry 回读确认 `latest=0.1.0`，下载的 tarball 与发布前验证产物逐字节一致：17,915 个文件，压缩后 53,376,860 bytes，解包后 168,628,696 bytes，SHA-256 为 `4b9c47ee967e26b454a59ed684559dd23535f67d7cadcd80f3571e9a05f011aa`，SRI 为 `sha512-SacawKCkqOsayWV0Brvom6AKt+EpWdfaEH5U2l6Ff86rjbvY5KijkyC48LknMxiYqVxyImFjKZ+7ECcyaRH3XQ==`。

发布前实际 tgz 通过公开 tree/history 隐私审计、隔离安装、default/full runtime smoke、457 项 `check-personal`、从 `0.1.0-alpha.17` 升级及隔离卸载验证；`rotom --version` 输出内置 Pi fork 版本 `0.85.1-rotom.2`。没有调用真实模型、验证登录/计费、安装 Chrome relay 或操作真实业务页面，这些结果不能外推为完整跨平台或真实业务验收。

## 首次分发范围与结论

用户当时授权实现“安装 rotom 即自动获得 Pi 和产品扩展”的 npm 安装产物。该轮没有公开发布、推送、真实模型调用、Chrome 安装/重载或业务页面操作，也没有更改维护者全局 CLI 与本地仓库目录；后续正式发布结果以上一节为准。

**PASS：首次安装产物的本地打包、隔离安装与 L1/L2 验证。保留：完整跨平台/真实业务验收未执行。**

当前产品元数据位于 `rotom/package.json`：`@bingjiang0611/rotom@0.1.7`、公开 npm 包、`UNLICENSED`。包内包含完整 Pi 运行时。

## 分发与启动

```text
packages/rotom-pi/ -> npm run build:pi
  -> 六个 0.85.1-rotom.2 运行时归档 + 来源/源码/构建器摘要
npm run pack:release
  -> 按独立 lockfile 新安装 Pi fork 和扩展，随包携带
npm install <rotom.tgz>
  -> 解包 runtime/pi/node_modules（不再拉取官方 Pi）
  -> 解包已按独立 lockfile 安装的第三方扩展依赖
  -> 建立 rotom bin

业务 cwd + 用户 argv
  -> bin/rotom（解析 npm bin symlink，exec）
  -> bin/rotom-launcher（既有内部 launcher）
  -> Node executable 校验
  -> resolve-installed-pi.mjs
       runtime/pi/{package.json,package-lock.json,fork-build.json} + product-config.mjs
       精确 fork version / archive integrity / source identity，bin.pi 与公开 exports
       仅产品自有路径；不查 ancestor / PATH / NODE_PATH / 全局 module 目录
  -> 原有 resource / package / capability gate
  -> 仓内 fork Pi CLI + 5 extensions + 1 bundled skill
       Qoder provider 默认注册；ROTOM_QODER=0 显式关闭
```

- 当前分发基线是仓内 Pi fork；源码、上游 revision 与维护说明位于 `packages/rotom-pi/`。六个包保留 upstream identity，归档使用 `0.85.1-rotom.2` 后缀和来源摘要，不冒充官方发行。
- `runtime/pi/package-lock.json` 只允许六个明确声明的本地归档，其余传递依赖必须是公共 registry 且带 SHA-512；拒绝链接、隐藏的官方 Pi 副本和未知本地 URL。源码或构建器改动后须重建，pack gate 拒绝陈旧归档。
- 默认仅加载 `runtime/pi/node_modules/`；缺失、错误版本、symlink、来源或路径漂移即停止，不搜索全局 Pi、旁边的源码树或旧安装。
- `ROTOM_PI` 保留为显式维护覆盖；允许选择通过原有 capability gate 的兼容版本。这是非默认发行配置，评测时必须披露。
- `rotom --version` 输出 rotom 产品版本；`rotom --version --verbose` 同时输出 rotom、Pi fork 和更新 metadata 来源。两者均先完成 runtime/resource identity probe，但不启动 Pi runtime。
- npm 首次接入未迁移内部身份；后续品牌改名已将 Browser 协议与 native host 统一为 rotom。旧 Chrome relay 须由用户重装/重载并重跑 installer；活跃会话不迁移。上游配置、eval arm 与兼容性 schema 的保留项见 [CLAUDE.md](../../CLAUDE.md)。

### 为什么 runtime config 改为 `.mjs`

Node 的原生 TypeScript 类型剥离不支持 node_modules 中的 `.mts` 文件。原 `runtime/product-config.mts` 是数据声明，现直接改为 `.mjs` 并去掉仅编译期的 `as const`，不保留第二份配置或兼容壳。launcher、verifier、smoke、eval loader、维护 fixture 和文档路径已同步。

扩展 `.ts` 仍由 Pi 的公开 resource loader 加载；未换成自制 loader。已从实际 npm 安装路径运行 public-runtime smoke，不能只用源码目录的测试代表安装结果。

## 维护者打包

```sh
cd rotom
npm run build:pi  # fork 源码或构建器变化时；隔离安装/构建/定向测试
npm run check:pi
npm run test:distribution
npm run pack:release -- /absolute/output-directory
```

### npm 发布的人机交接

Agent 负责收口源码、确定性测试、构建唯一 tgz、隔离安装/升级/卸载与只读核验；维护者本人在前台终端负责 npm login、网页/OTP、不可逆 publish 和本机版本切换。Agent 不再通过后台 shell、AppleScript 或浏览器工具触发这些步骤，也不让不可见的 publish 进程等待 2FA。

构建完成后先生成绑定绝对 tgz、version、tag 和摘要的命令单：

```sh
node scripts/npm-release-handoff.mjs commands '/absolute/output/bingjiang0611-rotom-<version>.tgz' latest
```

在同一个前台终端中按输出顺序逐段执行，不要整块无脑粘贴。`preflight` 只读证明目标版本不存在；随后命令创建本次发布专用的私有 npm config/cache 并清除环境 token，用户在其中登录；`npm publish` 只执行一次。出现 `EOTP` 时先完成该前台命令展示的官方 challenge，再运行 `verify`，不得凭错误文本直接重复发布。`verify` 要求精确 version、dist-tag、integrity、shasum 和下载 tarball 字节全部等于冻结产物。只有 `verified: true` 后才执行输出中的 `install-release.sh`；Agent 随后只读回验 registry、`rotom --version --verbose`、活动路径和内置组件版本。最后仍由用户执行输出中的 logout、`npm whoami` 失败回读与临时认证目录删除命令。

该 helper 不登录、不发布、不安装、不退出登录，也不读取 npm 凭据；`commands` 模式无网络，`preflight`/`verify` 仅访问固定 npm registry。它不能替代 `pack:release`、tree/history 审计、distribution、default/full smoke 或升级/卸载门禁。

维护打包需要 Node 24+、npm、Python 3、Git、POSIX shell 和公共 npm registry 网络；用户安装/运行不需要 Python。输出目录必须在产品目录之外，已有同名 tgz 会被拒绝覆盖。

打包器 `scripts/pack-release.mjs`：

1. 以 package.json 的精确 `files` 列表为源文件白名单，拒绝越界和 symlink；不复制源项目 node_modules、evals、fixtures、私有报告或 `.pi`。
2. 在自有临时目录创建独立 HOME/npm config/cache，按原始 third-party lock 做 `npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never --bin-links=false`。
3. 保留 `extensions/third-party/node_modules` 与新增 `runtime/pi/node_modules` 的独立布局及许可证，拒绝非普通依赖文件；Pi 按 runtime lock 新安装并验证。没有 install/postinstall/prepare hook。
4. `npm pack` 的 dry-run 与实际清单均检查所有 required resource、直接第三方 LICENSE 及允许路径；打包前审计 tracked tree，打包后递归扫描实际 tgz（含 vendor 归档）。审计失败的输出不能交付；正式 pack 不等于 publish。
5. 仅清理自己创建的临时 staging，输出 tgz 留存；不会清理项目运行时目录。

**不要直接在维护工作树中 `npm pack` 后交付**：其 npm 文件清单会包含本机已安装的嵌套依赖，缺少“从锁文件新安装”的证明。受支持的产物必须经 `pack:release` 生成。Pi 与扩展的嵌套依赖作为显式 npm 文件携带；顶层没有外部 Pi dependency。完整 Pi 源码是维护面，不进入 npm 产品包。

## 用户本地安装

```sh
npm install -g --ignore-scripts @bingjiang0611/rotom
cd /path/to/business-project
rotom

# 后续先退出所有 rotom 会话，再更新产品和内置 Pi fork；写入前会再次确认
rotom update
```

用户不需预装 Pi，也不需二次 npm ci。模型登录/API key、Chrome 扩展安装与重载、系统权限仍需用户明确完成。

### 可复现的多版本安装（维护标准）

上面的 `npm install -g` 是最简形式，装进 npm global prefix。维护机使用**按版本隔离目录 + 单一 symlink 切换**，由仓库根 `scripts/install-release.sh` 固化安装布局；这不保证网络安装或链接切换具有事务性：

```sh
scripts/install-release.sh '/absolute/path/to/rotom-<version>.tgz'
# 先将 <version> 与绝对路径替换为实际产物；默认不覆盖同版本目录。
```

它把产物装到 `~/.local/share/rotom/releases/<version>/`（内含 tgz、`{"dependencies":{"rotom":"file:<tgz>"}}` 的 package.json、本地 `npm install` 得到的 `node_modules/rotom` 与其内置 Pi fork），再把当前 Node bin 目录下的 `rotom` symlink 指向该版本的 `bin/rotom`——这个 symlink 是唯一的“当前版本”选择器。版本号取自包内 `package.json`（非文件名），装前校验、装后回读 symlink 与安装版本；已存在同版本目录默认拒绝覆盖。`--force` 会先删除该版本整个目录，只有明确确认没有存活会话使用它时才可使用；它不是无损激活或回滚开关。脚本没有“仅激活已有版本”模式；回退需单独核对旧安装后显式重指命令 symlink，不要用 `--force` 冒充切换。

两种布局的卸载不同：`npm uninstall -g rotom` 仅适用于 npm global 安装，不能卸载按版本目录中的独立安装；后者没有自动卸载命令，移除前需确认无存活会话、核对当前 symlink 的目标。凭据/会话和 Chrome/native-host 注册不随 npm 卸载删除。后续独立 prefix 跨版本升级/卸载证据见页首链接，活跃会话迁移仍未验收。

Qoder 增量产品接入的验证另见 [Qoder 产品验收](../../experiments/qoder-provider/PRODUCT-VERIFICATION.md)；下面的 4-extension 数量属于首次分发的历史记录。

## 分发接入时的验证记录

以下是首次分发接入的本机验证，不是公开发布或模型效果证明。后续隐私清理的复检见 [公开前隐私检查](privacy-release.md)；原始临时路径、日志及旧安装包不作为公开下载材料。仅使用清理后重新构建的归档，SRI 以构建输出为准。

- 两次独立 HOME/cache/staging 的同工具链构建逐字节一致；不外推为跨 OS/npm 版本的普遍可复现性。
- 独立 HOME/config/cache/prefix，PATH 无全局 Pi，`rotom --version` 输出 0.85.1，`rotom --help` 正常退出。
- 新 prefix 安装及同版本产物替换重装通过，installed resolver 与源文件字节一致。
- 隔离卸载后 bin/package 均消失，临时 HOME 内预置的会话 sentinel 保留，没有卸载维护者全局安装。

| 验证 | 结果 |
|---|---|
| `npm run test:distribution` 对应 suite | 16 passed；独立运行及最终 check-personal 均通过，覆盖 nested/hoisted、缺失/漂移/symlink/越界、不回退 PATH、bin 透传和打包排除规则 |
| `rotom/bin/check-personal`，显式已验证 Pi 0.85.1 | 最终串行 121 passed；default footprint PASS |
| `node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs` | 32 passed，0 skipped |
| `cd rotom/evals && npm run typecheck` | PASS |
| `npm run test:benchmark-adapters` | 9 passed |
| `npm test`（eval 基础设施） | 87 passed / 1 skipped；既有可选 sidecar 未配置，不运行模型 eval |
| 最终 npm 安装目录 default/full `smoke-runtime.mjs` | PASS；Pi 0.85.1，4 extensions / 1 bundled skill / 0 templates，真实 createAgentSession 绑定，lifecycleErrors=0 |
| 将上述两份 installed smoke 输入 `buildContextFootprintReport` | default/full runtimeContractGate 均 PASS；静态 bytes 不是 provider token/成本 |
| `node --check` / `sh -n` / `git diff --check` | PASS |

一次并行维护检查中，未改动的 dashboard SIGINT 测试出现 `null !== 0`：测试收到 URL 后立即发信号，而原实现先输出 URL、后注册 SIGINT handler，存在时序窗口。单独复跑该测试及最终串行全 gate 均通过；原失败保留在本地私有日志中，未当作无效尝试抹除，也未顺手修改 dashboard。

原始运行日志保持本机私有，不写入公开仓库。npm 给出既有传递依赖 `node-domexception@1.0.0` deprecation 提示，不把本轮安装验证写成依赖安全审计。

## 首次分发验证的未完成边界

- 该批只在同一台 Mac 的隔离目录/HOME 验证，不是干净 VM；后续 macOS/Linux 验证及新默认未复验项见页首链接，不能将旧结果外推到每个版本。Windows 原生入口不受支持。
- 未调用模型、未验证登录/计费/预算熔断，未启动 benchmark 容器或运行 89 题。
- 未安装/重载 Chrome relay、未操作真实业务页面；Browser 新按键仍需真实 Chrome 验收。
- 根许可证、宝可梦名称 IP、npm 名称可用性、全量传递依赖分发通知和最终公开支持矩阵仍待确认。
- npm 发布必须使用 `@bingjiang0611/rotom` 作用域、公开 access 与精确版本；不宣传安全沙箱或统一权限确认层。
