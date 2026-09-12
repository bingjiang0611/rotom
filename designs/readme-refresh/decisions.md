# rotom README 视觉刷新

## D-20260912-readme-svg

- Scope / status：仓库首页 `README.md` 首版；入口与信息结构已由 `D-20260912-readme-single-entry` 替代，SVG 封面保留。
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
