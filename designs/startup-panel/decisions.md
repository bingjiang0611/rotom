# rotom startup panel

## D-ROTOM-STARTUP-07 · 启动关键路径与 resources 首屏（需求确认；成品待审）
- Scope / status：project:`dev-agent` / confirmed（用户要求优化 rotom 启动速度，并指出右栏 `Loading resources…` 长时间不消失）；保留 D-06 已确认的 Heat Rotom 造型、分栏尺寸和三组资源信息结构。
- Root cause：资源主发现其实在 TUI 创建前已完成，但 `RotomHeader` 仍以 `undefined` 首绘，并把后续 fd/rg 与 extension `session_start` 等待统称为 “Loading resources”；实测主要阻塞来自 Qoder TUI `session_start` 的账号目录网络刷新。launcher 默认路径还用独立 Node 进程先解析 bundled Pi，再起 verifier，形成一次可消除的进程冷启动。
- Applied：`interactive-mode.ts` 首屏直接绑定已完成的 resource-loader 快照，extension `resources_discover` 完成后仍做 authoritative refresh，并为 header rebind 主动请求 render；新增 opt-in `PI_TIMING=1` 的首屏、资源快照、managed tools、session bind、ready 阶段记录。Qoder TUI 改为首屏完成后沿用 Pi 既有后台 provider refresh，`PI_OFFLINE=1` 不联网；print/RPC 仍同步发现，推理前的目录过期、账号、模型、上下文和 effort gate 不放松。launcher 的 bundled resolve + runtime verify 合并进同一 Node preflight，仍完整校验 archive/lock/installed identity、资源和公开 SDK capability。
- Evidence：2026-09-13 在同一机器、同一 cwd、`PI_STARTUP_BENCHMARK=1 PI_TIMING=1 PI_OFFLINE=1 ROTOM_OBSERVABILITY=0 HERDR_ENV=0 --no-session --no-approve` 下交替运行已安装 alpha.13 与源码候选各 3 次；总启动中位数 **6094ms → 3748ms（约 -38%）**，候选 `interactive.sessionBind` 为 8–9ms，首屏不再出现 `Loading resources`。独立正常 PTY smoke 在 4.048s 看到 Context / Skills / Extensions，未出现 loading，单次 `/quit` 正常退出。`--version` 交替各 5 次中位数 **1273ms → 869ms（约 -32%）**。这些是本机相对样本，不外推为所有设备的固定收益。
- Verification / install：Pi fork 完整 offline build 的 11 个 focused 文件 **154 passed / 2 skipped**；Qoder **237 passed**，6 组 offline maintenance smoke 与全部 **17** 个 catalog key 通过，runtime verifier **34 passed**，distribution **23 passed**，builder attestation、`check:pi`、`check-personal` 和 `git diff --check` 通过。`pack:release` 产物为 53,354,416 bytes / 17,915 files，SRI `sha512-c+mKJ5jIBuErSoOnsnPXPAObtpfIgho+Xr2wSBXSlKFIg5DhzMrcMnyePXmfl9a+vMJ5KzznaDt3ugHuPJsF8g==`，未发布。隔离安装并切换到 `~/.local/share/rotom/releases/0.1.0-alpha.13-startup-optimized`；installed default/full smoke 均为 5 extensions / 0 lifecycle errors，最终 installed PTY 在 3.847s 显示三组资源、无 loading，`/quit` exit 0。旧 alpha.13 目录保留，未覆盖存活会话。
- Preserve / boundary：不延迟 runtime trust verifier、不允许未绑定 extension 时提交请求、不改变工具面、默认模型、会话格式、Qoder 单次推理/不回退与 unknown 边界；后台目录刷新不代表网络成功，真实账号/模型请求未执行。自动测试、PTY 与用户桌面视觉验收分开。
- Acceptance：代码、发行包与真实 PTY 已验证并安装；用户当前终端中的最终体感/视觉仍待确认。没有新增跨项目审美偏好或可复用 UI 组件。
- Revisit：若后台 refresh 与首条 Qoder 请求竞态、print/RPC 目录时序、非 baseline 模型选择或真实终端 loading 回归，则回到本条并核对 timing 阶段，不以放松 pre-dispatch gate 换取速度。

## D-ROTOM-STARTUP-06 · Heat Rotom 描摩版 + 饱和调色（用户已看预览图并确认）
- Scope / status：用户看到 D-05 的 19×14 实渲染后仍“不像”，并提供 Frost Rotom 参考图提醒“电器形态的辨识结构”。递交前将候选保存为 `~/Desktop/heat-rotom-proposed.png`（官方 vs 终端渲染对照），用户确认“可以,装上去”。本条取代 D-05。
- Root cause：（1）旧版把身体画成圆形橙色球、手臂成了小侧翅，而 Heat Rotom 的辨识主体是**顶部两大红色等离子手臂（带白色火焰）+ 中心橙色脸部**；（2）旧调色板 `#ef7058/#f8ab59` 偏粉偏淡，与官方饱和红橙差距大。
- Reference：R-HEAT-ROTOM，https://pokemondb.net/sprites/rotom ，按 https://img.pokemondb.net/sprites/scarlet-violet/normal/rotom-heat.png 的轮廓/比例/配色逐像素重描（先将官方图降采样到调色板作参照，再手工清理）。终端像素为原创手绘，不把图片带入运行时；宝可梦 IP 未授权，private/UNLICENSED 不变。
- Applied：`ROTOM_PIXELS` 改为 **21×14 像素 / 21×7 字符**（调色板键仍 `[.robwg]`）；`renderRotomSprite` 的 hex 改为饱和版 r=#d83a22、o=#f28a2b、w=#fff1d8、b=#242228、g=#8dabb4。`rotom-header.ts` 的 `leftWidth` 20→22，分栏阈值 40→46 列（21 宽徽标无法与资源列共享 40 列行；<46 列回退纯文本），右栏起始列 22→24。`compact-preview/render.py` 的 `MINI` 同步。对应更新 `test/rotom-startup.test.ts`（列宽 21、分栏宽度用例 40→46、label indexOf 24；行数 14 / 渲染 7 行 / ▀▄ 7 / 总行数 11 不变）。
- 验证/安装：见下文提交与安装记录。旧版 heatv2/heatv3/integrated 保留可回滚；未迁移会话/凭据/浏览器绑定。桌面目视验收：用户已对预览图确认；实际终端字体/主题下的最终观感仍依启动后为准。

## D-ROTOM-STARTUP-05 · Heat Rotom 像素加宽加大（已被 D-06 取代：19×14 仍被用户判“不像”）
- Scope / status：用户看到 D-04 的 11×10 实渲染后反馈“差得很多”；在方向选择中明确选“加宽加大像素吉祥物（推荐）”，接受启动面板变高。本条取代 D-04（不再以 D-03/B 的“尽量小”为硬约束）。
- Root cause：11 像素宽下，身体占据中间，手臂无法向两侧横张——Heat Rotom 最关键的辨识点（两条向两侧张开的红色等离子手臂 + 扁圆烤箱体）在该尺寸下本质上画不出来。
- Reference：R-HEAT-ROTOM，https://pokemondb.net/sprites/rotom ，核对 https://img.pokemondb.net/sprites/scarlet-violet/normal/rotom-heat.png 。终端像素为原创手绘，不把网页/图片带入运行时；宝可梦 IP 未授权，private/UNLICENSED 边界不变。
- Applied：`ROTOM_PIXELS` 改为 **19×14 像素 / 19×7 字符**（调色板仍 `[.robwg]`）：尖角、自动红描边的圆润烤箱体、两只奶白眼睛、宽炉门+浅灰屏、小脚，以及两侧向外张开、内嵌白色火焰高光的红色等离子手臂。`rotom-header.ts` 的 `leftWidth` 13→20（分栏阈值仍 40 列，右栏起始列 15→22）；`compact-preview/render.py` 的 `MINI` 同步。对应更新 `test/rotom-startup.test.ts`（行数 14、列宽 19、渲染 7 行、▀▄ 行数 7、label indexOf 22；总行数仍 11）。
- 验证：`build:pi` 完整离线构建，11 个 focused 文件 **153 passed / 2 skipped**（含 `rotom-startup.test.ts`）；fork source SHA-256 `3e1df5fe4ccc28a217d695361aa98c4800780134f8da5fcb5fcc7c5f36443bf8`，各 attestation/vendor/`product-config.mjs` 随之更新；`check:pi` 通过。`pack:release` 产出 tgz（integrity `sha512-mAWsAmkWEEXv7C1ohdLWFHsOWQ6JTcP3CQ5lpl8q3G0ZqyYzpRq+OgWvieLcMO/EgemVnDDyr+KmT0YWxsHXKg==`，53,343,751 bytes / 17,915 files，隐私审计通过）。
- 安装/切换：离线装入新隔离目录 `0.1.0-alpha.11-heatv3-3e1df5fe`，校验新 19×14 网格已进编译 dist、旧 11 宽网格已消失；原子切换默认 `rotom` symlink 为该目录。旧版 `...-heatv2-12d30486` 与 `...-integrated-6188c3d` 保留可回滚；未迁移会话/凭据/浏览器绑定。桌面目视验收仍待用户；构建/单测 PASS ≠ 目视验收。
- 边界：19 宽吉祥物在 40 列终端会占揉一半宽度（右栏 18 列），属可接受边缘情形；<40 列仍单栏、不显吉祥物。不加载图片协议/不下载素材的约束不变。

## D-ROTOM-STARTUP-04 · Heat Rotom 像素高度还原（已被 D-05 取代：11×10 终端实渲染被用户否定）
- Scope / status：用户要求“在 rotom 中高度还原 Heat Rotom”，附 pokemondb 截图（Gen9/Scarlet-Violet 形态）。沿用 D-03/B 选定的紧凑 11×10 像素 / 11×5 字符尺寸与既有调色板（`[.robwg]`），只重绘像素网格，不放大吉祥物、不加载图片协议、不下载素材、不改工具/模型/会话合同。
- Reference：R-HEAT-ROTOM，https://pokemondb.net/sprites/rotom，核对 https://img.pokemondb.net/sprites/scarlet-violet/normal/rotom-heat.png 。仅借鉴橙色烤箱体、深色炉门+浅色屏、短尖角、红色等离子手臂与白色火焰；终端像素为原创手绘，不把网页/图片带入运行时。宝可梦 IP 未获授权，private/UNLICENSED 边界不变。
- Rule/reason：旧网格的手臂读作四角悬浮红/白方块（白色像误画的第二对眼睛）。新网格改为：中央尖角、两侧红色等离子手臂向上外张并带白色火焰高光、圆润红描边烤箱体、奶白色眼睛、更宽的深色炉门+浅色屏、底部小脚。silhouette 与官方 SV sprite 明显更接近。
- Applied：`rotom-header.ts` 的 `ROTOM_PIXELS` 替换为 v3 网格并更新注释；`compact-preview/render.py` 的 `MINI` 同步为同一网格（设计预览工具，非产品）。未重写 D-03 已冻结的 `b-52.png`/对照图或其 SHA，不冒充新的用户验收。
- 验证：`npm --prefix rotom run build:pi` 完整离线 workspace 构建通过，11 个 focused 文件 **153 passed / 2 skipped**（含 `test/rotom-startup.test.ts`；测试仍只断言 10 行×11 列、`[.robwg]` 调色板与 5 行渲染宽度，未锁定精确 silhouette）。fork source SHA-256 重生成为 `12d304866c9292567457b3a084d4b33548a3fa9ad1465446b178444e902a5ea3`，`fork-build.json`/`package-lock.json`/vendor tgz/`product-config.mjs`（`DISTRIBUTION_PI_BUILD_SHA256=a2d5c1c8…`）随之更新；`npm --prefix rotom run check:pi` 通过。
- 边界：**未重打包、未安装、未切换 live release**，也未迁移活跃会话/凭据/浏览器绑定。当前 `$HOME/.local/share/rotom/releases/0.1.0-alpha.11-integrated-6188c3d` 仍是旧网格；新造型需重新 `pack:release` + 安装或用户本机重建后才可见。桌面视觉验收仍待用户确认；构建/单测 PASS 不等于用户目视验收。

## D-ROTOM-STARTUP-03 · Compact resources / B（已实现、已安装）
- Scope / status：本项目需求与 B 方向 confirmed；D-02 成品被明确否定。B 已实现并安装，生产成品仍待用户本机体验。
- Feedback：2026-09-12 用户：“这太丑了吧 优化下 并且小一点”“右侧换成这些”，配图指向巨大字符 Heat Rotom 和 Context / Skills / Extensions 三组真实资源；随后在 A/B 对照中明确选择“B · 极简侧栏 (Recommended)”。不是授权更换终端，也不升级为跨项目偏好。
- Rule / reason：缩小吉祥物，去掉复杂侧面阴影和夸张嘴部，右侧从 Quick start / Session 改为当前资源；较窄窗口也应尽量保留分栏，不在面板下重复资源列表。保留诊断、quietStartup、Ctrl+O、实际版本/更新与活跃会话边界。
- 约束澄清：D-01 的“纯字符”来自实现选择；当前会话环境标识为 Apple Terminal，故本轮仍采用字符兼容路径。不拿支持图像协议的高清 PNG 示意冒充该终端的可实现效果。
- 选定基线：[brief / 边界](compact-preview/README.md)、[52 列 A/B 对照](compact-preview/compare-52.png)、[80 列 A/B 对照](compact-preview/compare-80.png)，提交 `e394f37`。B 的 `b-52.png` SHA-256 为 `1f5505a1bcffb75bb7883006226934dca4c7fc57f434b3e776b247126cb1e1fa`；A 未被选择，保留作探索历史。生产像素网格已逐行与 B 的 MINI 网格比对一致。
- Applied：`rotom-header.ts` 使用 11×10 像素 / 11×5 字符小图标，无大边框。40 列及以上分栏，较小窗口省略图标；Ctrl+O 的完整路径/帮助使用全宽。模型与目录沿用原底栏，无模型时保留 `/login` / `/model` 指引。
- 资源接入：复用 `showLoadedResources` 已有的 Context / Skills / Extensions 组件，通过 `RotomHeader.setResources` 放入右侧；没有第二套发现/硬编码名单。自定义 header 时同一组件回到原资源区，恢复时不重复；主题、reload 与换会话更新/清除资源；新绑定组件同步 owner 的展开状态，自定义 header 隐藏 owner 时仍保持该状态，避免重绑意外展开/折叠。Prompts、Themes 和诊断仍在独立资源区，quietStartup 不吞诊断；standalone Pi 维持原路径。
- 构建 / L1：完整 offline workspace build；11 个 focused 文件 **153 passed / 2 真实模型测试 skipped**，覆盖字符尺寸、宽窄/CJK/emoji、ANSI-256、空/加载、展开、自定义 header、重绑/换会话与原 Pi 资源显示。4 个 TS 文件 Biome、fork attestation / builder test、distribution **23 passed**、runtime **33 passed**、tracked tree / 实际 tgz privacy audit、离线无脚本安装全部通过。
- 实际 launcher PTY：实际安装包的 **100×36 dark、52×32 dark、40×36 light / ANSI-256、32×36 tiny、80×24 quiet、80×32 quiet + skill conflict** 六种场景通过；宽屏场景还执行 Ctrl+O、实时 resize 到 52×32、修改测试 skill 后 `/reload`、`/changelog`、`/quit`。资源名称真实来自隔离 fixture 的 loader，不重复；quiet 的诊断仍可见。
- 补充 installed-fork PTY：通过原生 fork CLI 显式加载一个隔离测试扩展，验证真实自定义 header → 展开 → dark/light 重绑 → 恢复 → 折叠，以及 reload。**这不是常规 launcher 允许追加扩展的证明**：常规资源门禁保持不变。实际产品 default/full SDK smoke 均为 5 extensions、0 lifecycle errors；没有真实模型请求或用户凭据读写。
- 验证修正：首次构建的两个测试假设不成立（theme 是 Proxy、Text 会补齐行尾空格），修正测试后重建通过。首次 PTY fixture 未被显式资源 launcher 加载，测试命令被当成无凭据输入拒绝；改用上述独立 native-fork UI 场景，不放宽产品门禁。补充 PTY 的短暂主题通知按该动作后立即回读，不能要求它在后续折叠通知覆盖后仍保留；最终 launcher 六种场景与 supplemental fork UI 场景分别重跑通过。失败尝试不计 PASS，测试专用 bridge 按精确 PID/fixture 路径停止。
- 实际预览：[100 列](preview-compact.png)、[52 列](preview-compact-narrow.png)、[40 列浅色 / ANSI-256](preview-compact-narrow-light.png)。来自最终安装包的完整 PTY 输出，经 xterm-headless 解析后栅格化、仅裁剪 header；为无账号 fixture，非用户桌面截图。浅色默认背景为栅格化设置，不声称 App 修改了终端背景。
- 整体交付授权：用户确认另一会话已提交 Browser `868bb45`，要求“整体打包安装 推送”。最终冻结维护快照 `6188c3d`，纳入已提交 Browser，不再排除该功能。2416 个 tracked 文件导入独立公开副本，Git tree 与维护快照完全一致；保留公开 main 历史，使用 noreply 身份提交，不导入维护私有历史、不 force push。
- 许可决定：用户明确选择“按维护仓移除根 MIT 后推送”；同步更新 README / 用法 / 素材说明，保留此前已授予的 MIT 权利与上游、第三方许可证。没有把源码推送扩大为 npm 发布或第三方 IP 授权。
- 安装：整体包已离线、无脚本安装到新目录，并原子切换默认 `rotom` 到 `$HOME/.local/share/rotom/releases/0.1.0-alpha.11-integrated-6188c3d/node_modules/rotom/bin/rotom`。包内产品源码逐项与冻结树核对一致；切换前核对旧链接未漂移，目标、fresh zsh 解析与 `--version` 回读通过。旧 Heat / compact 安装和活跃会话均保留，不迁移凭据/模型/浏览器绑定。
- 身份：产品仍为 `0.1.0-alpha.11`，`--version` 仍为 fork `0.85.1-rotom.1`。fork source SHA-256 `08d8ac30904d87cc6a7793bd5a776751a2f33f4155af7c17b2acf7ad70eee793`；整体 tgz SRI `sha512-J8lCn2zKx85ucHvX17AlckOArfxPTYfRI+A1/ad171jJGaYkLtvce+cCF7HBQQek031UbhHvjMD/DZKB6EeDBA==`，53,339,707 bytes / 17,915 files。仅 GitHub 源码推送获授权，没有 npm publish 或创建 Release。
- 整体复验：`check-personal` 413 项中首次 411 passed，既有 process-tree timeout 用例及父级失败（返回 unavailable）；单独复核该文件 **5/5 passed**，未修改进程合同或放宽产品 deadline。eval adapter **18 passed**；实际整体包 default/full SDK **5 extensions / 0 lifecycle errors**。维护面 footprint 的 runtimeContractGate、deterministicGate 均 PASS；referenceObservationGate 为 DRIFT，不声明前后性能收益。
- 整体终端复验：上述六种 launcher 场景及 supplemental fork UI **7/7 passed**，宽屏还回读 `/browser help` 与 `/browser status`。状态来自隔离 HOME，没有安装 native host、加载真实 Chrome 扩展或执行浏览器任务；不能据此声称真实 Chrome L3 已通过。三张实际预览已重新从该整体包生成。
- 交付过程修正：公开副本预检最初未规范化 macOS 的 `/tmp` 路径，旧树试包未交付；修正为 canonical 路径、失败即停及 Git tree 相等断言后重新打包。footprint reporter 依赖维护面 smoke 文件，不能把它当成发行包文件调用；修正参数后通过。首次整体 PTY 在 `/reload` 仍显示 Reloading 时过早断言，改成单次提交后等待资源更新再取证；没有重放同一命令，也未改产品来迎合等待。失败尝试不计 PASS。
- Acceptance：B 原型方向已选；本轮构建/PTY 与用户桌面视觉验收分开。R-HEAT-ROTOM 仅复用烤箱与火焰辨识要素，旧手绘细节被否定；用户改变尺寸/造型、终端能力或资源显示要求时复核。
- Discovery：更新已可由 `P-ROTOM-STARTUP` / `Compact resources` 检索；共享索引已重建。全库 check 仍因既有 `P-PI-MODEL-SELECTOR` 源路径不存在而失败，不把本次可检索等同于全库通过。

## D-ROTOM-STARTUP-02 · Heat Rotom（成品被用户否定，后续见 D-03）
- Scope / status：本项目吉祥物形态 confirmed；成品于 D-03 反馈中被明确否定。此条取代 D-01 的普通洛托姆造型，保留分栏、提示、模型状态与 rotom 更新逻辑。
- Feedback：用户在授权安装后补充“参考这里的 … heat rotom”，提供 Pokémon Database 链接与 Generation 9 / Heat Rotom 截图；不是通用像素风偏好，也不表示旧造型已获认可。
- Reference / Uses：R-HEAT-ROTOM，https://pokemondb.net/sprites/rotom；核对 [Scarlet/Violet 形态](https://img.pokemondb.net/sprites/scarlet-violet/normal/rotom-heat.png) 与同页 [Black/White 像素形态](https://img.pokemondb.net/sprites/black-white/normal/rotom-heat.png)。借鉴橙色烤箱、深色炉门、短尖角、红色等离子手臂及白色火焰；重新手绘终端像素，不把网页/图片带入运行时。
- 约束变化：普通形态的青色闪电/菱形身体改为 Heat Rotom；像素网格 31×22（终端 31×11），面板增高一行。仍不加载图片协议、不在启动时下载素材，不改工具/模型/会话/更新合同。宝可梦相关 IP 未获官方授权，private / UNLICENSED 边界不变。
- Applied：`rotom-header.ts` 的静态像素/色板与轮廓宽高回归；原 D-01 预览与验证作为历史保留，不冒充 Heat Rotom 验收。
- 安装边界：旧版本安装操作被用户中断；只读复核无遗留 npm install 进程，默认链接仍指向原 alpha.11，未切到不完整的新目录。新造型验证后才继续安装，不重放被中断的安装。
- 预览：[100 列深色 Heat Rotom](preview-heat.png)、[40 列浅色](preview-heat-narrow-light.png)。来自实际安装包完成启动后的 PTY 输出，经 xterm-headless 解析栅格化并裁剪启动面板；不是桌面截图，用户视觉验收仍待确认。
- 验证：完整 offline workspace build；9 个 focused 文件 **101 passed / 2 真实模型测试 skipped**；2 个 TS 文件 Biome 通过；fork source/builder attestation 与 distribution **22 passed**；实际 tgz privacy audit、全新 prefix 的离线无脚本安装通过；最终 installed default/full runtime smoke 均为 5 extensions、0 lifecycle errors。新目录真实 PTY 的 100×32 dark / 40×32 light / 80×24 quiet、Ctrl+O、`/changelog`、`/quit` 均通过，无真实模型请求。
- 验证修正：隔离 worktree 不带维护 node_modules，最初从该 worktree 调用 smoke harness 时在导入 `typebox` 之前失败；核对 harness 源码相同后，改从有维护依赖的主仓运行 harness，目标仍为全新实际安装的产品目录，两套 smoke 重跑通过。不把缺依赖的 harness 失败算成产品回归，也未将维护依赖复制进产品。
- 构建隔离：发行验证在独立 worktree 中进行，基点为已提交的 `8a9fedf`；仅叠加本次 Heat 源码/测试和重建 fork 合同，不带入其他会话未提交的工作。
- 安装：已按用户前一条“执行吧”的授权安装本次 Heat 构建，并原子切换默认 `rotom` 链接；回读目标为 `$HOME/.local/share/rotom/releases/0.1.0-alpha.11-heat-d73da243/node_modules/rotom/bin/rotom`。新 shell 的命令解析和 `--version` 回读通过；旧 alpha.11 目录/当前会话未替换，无凭据、模型默认值或浏览器绑定迁移。三个测试专用 bridge 按精确 PID/fixture 路径停止。
- 版本/身份：仍为产品 `0.1.0-alpha.11` 的本地新构建，目录后缀用于隔离而非新的发布版本；fork source SHA-256 为 `d73da243407113cf9a5b0889fec1ea7c7c15020eb1030f389571d8a5ca013be2`，tgz SRI 为 `sha512-8e1+PsTCzVEZOUiVBuPYEh7yAZH0e7tlVSeBBtnWgH5+nUoBGzCtLqUzw+4xmcvjoEAAZxcQkt0UsGIpYf57wg==`。没有推送或公开发布。

## D-ROTOM-STARTUP-01（普通形态，已被 D-02 替代）
- Scope / status：rotom 启动 TUI；需求 confirmed，成品待用户目视验收。
- Feedback：用户要求“像 omp 这样，进来可以看到像素风的 rotom pokemon”，并把 Pi 更新提示换成 rotom 更新。
- Reference：本轮用户提供的 OMP 启动截图与 Pi Update Available 截图（R-OMP-STARTUP、R-PI-UPDATE，本任务内引用；不把其中会话正文复制进仓库）。共享库未找到可复用的 rotom 启动组件；旧 Pi model-selector 记录路径已失效。
- 方向：已明确选择 OMP 式分栏，不再为同一布局另造多套配色。左侧原创手绘洛托姆像素图，右侧 Quick start 与真实 Session 信息；保留输入框、底栏、资源折叠与快捷键。省略 rotom 未启用的 LSP、Python 和后台 fork 提示。
- 硬约束：纯终端字符，不依赖图片协议/远程素材；不更换上游 npm identity；不改模型或会话格式；quietStartup 仍生效；只使用当前产品版本；不通过 Pi 自更新替换 fork；不覆盖活跃安装。
- 更新：GitHub rotom Releases 单次有界只读请求，最多比较本页 20 条，版本标签接受 `<semver>` 或 `v<semver>`，不宣称遍历全部历史。Alpha 可看到较新预发布/正式版，正式版不自动进入预发布。无 release、限流、离线或网络失败不显示虚假的新版本。当前公开 releases 返回空数组，不代表“已完成发布”。`/changelog` 指向 rotom Releases；不将上游 Pi changelog cursor/安装遥测当作 rotom 更新状态。
- 非目标：新增自动安装器、npm 发布、会话内容预览、工具能力扩张、第三方宝可梦素材下载。手绘形象不代表商标/IP 授权，现有 private / UNLICENSED 边界不变。
- 尺寸/状态：72 列及以上分栏（最大 108 列占位），33–71 列单栏像素图，小于 33 列文本；dark/light、长 CJK/emoji 标签、无模型、恢复会话、Ctrl+O 展开、主题/模型变化均列入 focused tests。
- 源码/API：`packages/rotom-pi/packages/coding-agent/src/modes/interactive/components/rotom-header.ts`，`RotomHeader(getState, expanded)`，消费当前模型/目录/思考档位与原生帮助，不拥有业务状态。
- 验证：PASS（下表所列范围）；自动测试、构建、CLI/PTY 与桌面视觉验收分别记录。未替换用户的默认命令；成品仍待用户验收。
- 预览：[100 列深色](preview.png)、[40 列浅色](preview-narrow-light.png)。来自最终发行包、隔离无账号 HOME 的真实 PTY 输出，经 xterm-headless 解析并栅格化，仅裁剪启动面板；不是 HTML 设计稿，也不是桌面终端截图。完整资源/无账号警告/输入框保留在原始测试输出中。
- Revisit：用户视觉反馈、启动信息密度、发行渠道或原生 TUI 合同变化时重新核对；不升级为跨项目像素风偏好。

## 验证记录 · 2026-09-12

| 检查 | 实际结果 |
| --- | --- |
| `npm --prefix rotom run build:pi` | 完整 offline workspace build 通过；9 个 focused 文件 100 passed / 2 个真实模型测试 skipped。覆盖布局、更新过滤/离线/错误、上游 Pi 兼容及相邻启动输入/模型路径 |
| 定向 Biome check（5 个 TS 文件） | PASS；未对整仓做格式清理 |
| `npm --prefix rotom run check:pi`、`node --test rotom/scripts/build-pi-fork.test.mjs` | PASS；来源/构建器摘要、归档与 lock/product-config 同步 |
| `node --test --test-concurrency=1 rotom/runtime/verify-pi-runtime.test.mjs` | 33 passed；测试进程清除继承的 Subagent scope/store 环境变量。包含新产品版本覆盖继承值、cwd/argv 与 version probe |
| `npm --prefix rotom run test:distribution` | 22 passed |
| `npm --prefix rotom run pack:release -- <独立输出目录>` | PASS；tracked tree 与实际 tgz privacy audit 通过；17,916 files / 53,347,353 bytes；没有 npm publish |
| 实际 tgz 的空 HOME/cache、无全局 Pi PATH 安装 | `npm install --offline --ignore-scripts` 通过；仅安装一个产品包。最终 installed `--version` 仍为 fork identity `0.85.1-rotom.1` |
| 最终 installed default/full runtime smoke | 两套均通过；5 extensions、真实 `createAgentSession`、0 lifecycle errors；没有真实模型请求 |
| 最终 installed PTY | 100×32 dark、40×32 light、80×24 quietStartup 均通过；先等初始化完成的无模型警告，再断言像素图/产品版本/无模型指引、Ctrl+O 展开/折叠、`/changelog` rotom URL、`/quit` 正常退出。quiet 隐藏面板。不是桌面视觉验收 |
| 本地视觉检查 | 已检查上述两张源自最终 PTY 的栅格图；边框、像素图和宽窄排版可读。实际用户终端字体/主题与用户验收未验证 |

### 过程中发现并修复

- 两次直连隔离 `npm ci` 超时，大型原生依赖下载缓慢；检查无并行安装争用，等待/结束测试专用 npm，原 staging 由构建器清理。改用临时 npm wrapper 转发本机已有的无凭据 loopback 代理后构建恢复；HOME/cache/lock 隔离和 300s cap 未改变，wrapper 不进入源码/发行包。
- 第一次编译发现 `erasableSyntaxOnly` 不允许 constructor parameter properties，已改为显式字段；定向 lint/format 问题已修复。
- 真实无账号启动暴露 agent-core 的 `unknown` model placeholder；已映射为“无模型 + /login”指引，避免把占位符当真实模型。最终重新构建、打包并重新安装验证。
- 早期 PTY 截图可能发生在扩展初始化完成前；最终 harness 改为等待明确启动完成指标后再截图/操作。仅最终这组作为上述 PTY PASS 证据。
- PTY 退出后 Computer Use 留下的测试专用 bridge 已按精确 PID/fixture 路径停止；未关闭用户 App/会话。

### 交付边界

- 最终 fork source SHA-256：`4e5a02b8724342877c30f0af6d2861a019568b9993923156212086186152b293`。
- 最终 tgz SRI：`sha512-lwt70pJOfa8Nq1b+sIGDSLQlDJVvHhahER2idPk1i0tN4W3lHemXo+ALzyaEhG21bMYUtc4pA2dG6P37RrpEvg==`。
- 本次不升产品版本、不发布、不推送、不替换默认安装、不迁移活跃会话。新版本通知通过合成 release 测试；真实 GitHub 尚无 Release，不能将它写成真实更新可用验证。
- 设计库登记 `P-ROTOM-STARTUP`，搜索 `rotom startup` 可命中本记录；只登记项目需求/产物，不宣称新增全局审美偏好或用户已认可成品。共享索引已生成，但全库 check 仍被既有 `P-PI-MODEL-SELECTOR` 失效路径阻断；未擅自修理其他项目的记录。
