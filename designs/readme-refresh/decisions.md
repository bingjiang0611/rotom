# rotom README 视觉刷新

## D-20260912-readme-svg

- Scope / status：仓库首页 `README.md` 首版；入口与信息结构已由 `D-20260912-readme-single-entry` 替代，封面进一步由 `D-20260912-readme-heat-browser` 替代。
- Feedback：用户要求使用工作区 `beautify-github-readme` 优化 README，并选择“纯 SVG 技术风”。这是项目选择，不是全局视觉偏好。
- Route：现有首页的视觉刷新与内容减法，不做交互原型或新产品结构设计。保留身份、能力、上手、文档和许可信息；将长 Qoder 说明交给已有产品文档。
- Audience：希望在自己的代码仓库中使用本地终端 coding agent 的开发者。
- One-sentence value：将编码、浏览器操作与按需任务委派放进一个终端工作流。
- Primary proof：真实的仓内 Pi fork / 包内 runtime 路径，以及有边界的现有安装与 smoke 验证记录；不制造截图、性能数字或普遍通过的宣称。
- First successful action：获取本地 tgz → 安装 → 在业务目录运行 `rotom` → 登录并选择模型。
- Native material：`packages/rotom-pi/`、`rotom/runtime/pi/`、保留 cwd/argv 的工具调用路径；图示明确为结构示意，不冒充真实 UI。
- Palette：背景 `#101820`，前景 `#eef5f7`，强调 `#79e2cf`，辅助文字 `#aab9c2`，结构线 `#344853`。
- Typography：系统 sans-serif 中文正文 / monospace 路径与命令；大标题、必要图示标签优先，手机必需信息同时以 Markdown 提供。
- Shape / motif：20-unit 圆角、2-unit 线条、8-unit 间距基准；终端提示符和真实 source→runtime 路径；不使用官方角色素材、外部字体、脚本或动效。
- Applied：`assets/readme/hero.svg`、`assets/readme/workflow.svg` 与根 README；不修改 `rotom/README.md`、Pi 源码、发行包或已安装运行时。
- Reference / reuse：读取 beautify 的视觉、hero、SVG、GitHub canvas 与内容组织指南；从现行产品合同取材，无外部素材。
- Evidence：beautify README audit 通过（2 张本地 SVG）；22 个 Markdown 链接/锚点核对通过；SVG XML、title/desc、自包含与无脚本检查通过，合计 4,012 bytes。sips 实际渲染并查看 900/360px 的两张图及 hero 深/浅背景，无截字；手机图内辅助细节由相邻 Markdown 完整承载。marked 本地 HTML 生成与 loopback 回读一致；Chrome relay 不可用，未验证真实 GitHub 页面渲染。`git diff --check` 通过；纯文档任务，不运行产品构建、不升版本。
- Preview：根 README 与两张 SVG 是交付源；本地 PNG/HTML 预览位于临时目录，不作为持久化证据或发行资源。
- Acceptance：待用户查看；选择 SVG 实现不等于认可最终配色或版式。
- Revisit：用户视觉反馈、产品入口/工具面/发行状态变化时复核；不为纯文档改动构建产品或升版本。

## D-20260912-readme-single-entry

- Scope / status：项目 README 入口；confirmed（需求），成品待用户查看，不是全局审美偏好。
- Feedback：用户指向产品目录的 README，要求“只保留最外面的”“介绍怎么用，有哪些能力即可”。
- Rule：根 README 是唯一产品介绍入口；只保留快速上手、能力列表和必要提醒。安装、Qoder、费用、模型限制等细节进入 `docs/usage.md`，不以第二份 README 承载。
- Preserve：保留原 SVG 封面，不重画素材；详细说明按当前公开运行时版本完整迁移；不删除组件、评测和上游各自的 README。
- Applied：根 README 从 87 行减至 41 行；产品内层 README 移入 `docs/usage.md`；更新调用方文档链接和 npm files 清单，不在发行暂存区重新生成内层 README。
- Evidence：分发测试 23 passed，新增回归实际执行 release staging，确认不需要或重新生成内层 README；9 份改动文档的 41 个本地链接/锚点通过，README audit 通过（1 张既有 SVG）。未构建新版发行包、未更改启动逻辑。SVG 未变，原素材渲染证据不冒充本轮整页视觉验收。
- Acceptance：用户明确要求单入口与简明内容；新成品尚未获视觉认可。
- Revisit：首次使用路径或产品能力变化时复核；替代首版的双入口和长首页结构。

## D-20260912-readme-heat-browser

- Scope / status：README 局部更新；confirmed（需求），成品待用户查看。
- Feedback：用户要求把浏览器配置加入 README，并指定 Pokémon Database 的 Heat Rotom 形态作为标志。
- Applied：用 128px 静态 PNG 替换页首 SVG 横幅，保持单入口和简明结构；新增 macOS / Chrome 125+ 的注册、加载扩展、连通检查与升级路径说明。详细指南回链到首页，不另维护第二套配置步骤。
- Source：采用 Pokémon Bank / normal 的 Heat Rotom，姿态与用户参考一致；未修改原始字节，来源和权利说明在 `assets/readme/ATTRIBUTION.md`。它不属于仓库 MIT 授权，不进入 npm 产品运行时。
- Preserve：不修改启动界面、浏览器代码或用户本机注册；旧 SVG 只保留为历史设计源，不再作为首页标志。
- Evidence：已查看源图及 128px 深/浅背景预览；安装器的 macOS 限制、install/status 参数、输出 extensionDir 与 Chrome 最低版本均按当前源码核对。未运行真实安装、扩展重载或连接验收；status 的注册状态不冒充浏览器已连通。
- Acceptance：用户指出单独居中的图标“太突兀”；该布局由 `D-20260912-readme-inline-mark` 替代。Heat Rotom 形态与配置入口保留，不提升为全局偏好。

## D-20260912-readme-inline-mark

- Scope / status：README 页首局部修复；需求确认，成品待用户查看。
- Feedback：用户提供真实 GitHub 页面截图，指出图标“太突兀”。问题是原图透明画布与独立居中段落制造空白，图标和左对齐标题脱节；不是要求更换角色。
- Applied：裁去透明边缘，保留原像素；用 40 × 25 的图标与 `rotom` 同排、同一左对齐基线。移除独立居中区域，正文及浏览器配置完全不变。
- Assets：保留原图用于溯源，新增 `assets/readme/heat-rotom-mark.png`（82 × 51）；版权与裁切参数写入 `assets/readme/ATTRIBUTION.md`。
- Evidence：与原图对应裁切区域的像素比较差异为 0；查看了 900/360px、深/浅背景的头部组合预览，而不只检查孤立图标。预览是本地排版示意，不是真实 GitHub 截图；未更改或运行产品逻辑。
- Acceptance：保留用户指定角色，否定的是孤立居中布局；新组合尚待用户验收。
