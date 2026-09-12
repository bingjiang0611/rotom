# rotom · architecture

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 术语

- **公开名称**：产品与仓库名均为全小写 `rotom`，项目仓库为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)；路径以实际 checkout 为准，运行时目录为 `rotom/`，npm 公开入口为 `rotom`。源码已公开，npm 仍为 private alpha；兼容性标识的保留项见根指南。
- **维护面**：仓库根的 `CLAUDE.md`、eval 和设计资源；不随 launcher 注入业务 session。
- **运行时产品**：`rotom/` 下 launcher、runtime contract、extensions 和 skills；不包含 bundled prompt templates。
- **launcher**：公开 `rotom/bin/rotom` 只解析 npm bin symlink 并 exec 内部 `rotom/bin/rotom-launcher`；后者解析 Node/Pi、验证资源并启动 Pi。
- **resource contract**：`product-config.mjs` 中 extension/skill/prompt 的声明、必需文件和第三方 identity。
- **composition root**：把锁定第三方能力组合成产品工具面的 `extensions/third-party/index.ts`。
- **deferred tools**：通过 `search_tools` 按 capability group additive 激活的 specialized 工具。
- **reviewed startup set**：默认启动工具合同；headless Ask 或用户 tools policy 可能进一步改变实际 active set。
- **L1 / L2 / L3**：静态合同与单测 / 真实 Pi loader 或本机 runtime smoke / 真实外部对象、登录态或写后回读。
- **unknown**：外部副作用结果无法证明，既不是成功也不是可安全重试的失败。
- **paired eval**：固定 candidate/baseline、明确判分合同和保留 artifact 的有界 A/B，不是全局质量证明。

## 架构与启动数据流

```text
业务项目 cwd + 用户 argv
  -> rotom (npm bin) -> rotom/bin/rotom-launcher
  -> canonical Node / product-owned Pi fork resolution (explicit ROTOM_PI override allowed)
  -> verify-pi-runtime.mjs
       -> Pi package/exports/bin identity
       -> resource path/no-symlink contract
       -> exact third-party package/lock/installed identity
  -> 按固定顺序加载 extension
       observability -> browser -> coding-policy -> third-party -> qoder（provider 默认启用，可 opt-out）
  -> 加载 1 skill + Claude Code skill bridge（不加载 bundled prompt templates）
  -> Pi session（仍以业务 cwd 为项目上下文）
  -> deferred loader 按需 additive 激活 specialized tools
```

运行时复杂度应停留在边界：

- launcher 只做 executable/resource trust、参数透传和资源声明；
- runtime 提供跨 extension 的小而稳定合同，不成为第二个 framework；
- extension 提供确定性工具与生命周期接入；
- skill 提供领域知识与多步编排，不复制工具实现；
- 第三方 package 保持锁定，产品差异在 composition wrapper 中吸收；
- 当前能力事实以 runtime contract、实现和测试为准；`CLAUDE.md` 统一维护工作约定与证据边界。

状态恢复、Subagent 异步结果与工具面测量的当前合同/回归证据见 [Harness hardening](harness-hardening.md)。其中 live tree 保持 additive；replacement 从选中分支恢复，不另建 session authority。

## 启动与依赖入口

发行包用户只需安装 tgz，Pi fork 与第三方扩展依赖均已随包携带；无需全局 Pi、本地编译、二次 npm ci 或安装期脚本。完整打包/验收步骤见 [npm 分发](distribution.md)。

源码维护环境从仓内 `packages/rotom-pi/` 构建 Pi fork，再安装独立锁定的 runtime 和扩展（不改存活安装）：

```bash
cd rotom
npm run build:pi
cd runtime/pi
npm ci --ignore-scripts --bin-links=false --registry=https://registry.npmjs.org --replace-registry-host=never
cd ../../extensions/third-party
npm ci --ignore-scripts --omit=optional --legacy-peer-deps \
  --registry=https://registry.npmjs.org --replace-registry-host=never
```

Subagent 使用仓库内 `extensions/third-party/vendor/` 的精确归档，不依赖维护者 HOME。不要对运行时安装使用 `--replace-registry-host=always`：它会把本地 tarball URL 错写成 npm registry URL。归档来源、许可证与完整性见 [vendor 说明](../../rotom/extensions/third-party/vendor/README.md)。

从真实业务项目启动，不能先切回维护仓根：

```bash
cd /path/to/business-project
/absolute/path/to/rotom/rotom/bin/rotom-launcher
```

Node 过低或需要固定旁路 Pi 时，分别设置绝对 executable：

```bash
ROTOM_NODE=/absolute/path/to/node \
  /absolute/path/to/rotom/rotom/bin/rotom-launcher --version
ROTOM_PI=/absolute/path/to/pi \
  /absolute/path/to/rotom/rotom/bin/rotom-launcher --version
```

Browser relay 安装入口是 `node rotom/extensions/browser/install-chrome-relay.mjs install`；Chrome 中加载/重载 extension 仍由用户显式完成。

Browser 路由为 Relay-first：先 `browser_inspect/browser_interact`，只有当前运行未派发 Relay 页面请求且本机 socket 缺失/拒绝连接的类型化错误，才给 `launch_browser` 一次启动许可。错误回执与启动提示会说明独立 profile 不继承原 Chrome 的 Cookie/登录态。登录页、空列表、stale、超时/unknown、取消、权限与协议错误不授权回退；已派发请求后的断线不能靠重连失败取得许可，也不跨浏览器重放写操作。许可在启动 preflight 消费（启动失败也不重发），新用户运行、session/tree/fork/reload 后不继承；不主动改变 active tools，显式排除 Relay 的调用方保留原选择。回退后使用新 CDP stateId，不复用 Relay ref。实现位于 Browser extension 与自有 Computer Use wrapper，不修改第三方 installed source 或 Chrome protocol。本次仅本地确定性测试；真实 Chrome L2/L3 未验证，安装版本升级并启动新 session 后才会加载此策略。

Browser 源码新增 ref-bound `keypress`（protocol 17 / `targeted-keypress`）：`browser_interact({operation:"execute", tabName:"form", action:"keypress", targetRef:"<最新 snapshot_visible 的输入框 ref>", key:"Enter", expect:"value=empty"})`。`Enter` 对应 Return，用于回调地址等标签输入确认；另支持 `Tab` / `Escape`，不支持组合键或无目标按键。普通 `type` 不自动提交，按键先核验原目标焦点，再后台 CDP 派发并回读；输入框清空不等于业务成功，仍要检查标签或页面状态。未知结果禁止重发。升级后需用户在 `chrome://extensions` 重载 Relay，并重启 Pi session 更新工具 schema；旧 relay 会明确要求重载。该路径的确定性 L1 已覆盖，真实 Chrome L2 / Cloudflare L3 尚待显式授权验证，不能宣称现场问题已解决。

## 代码地图

- `rotom/package.json` / `npm-shrinkwrap.json`：npm 产品元数据、公开 bin 和显式发行文件清单；不再声明官方 Pi dependency，`private: true` 防止未授权发布。
- `packages/rotom-pi/`：仓内 Pi 源码 fork、上游来源与 MIT 许可证、锁定公开模型目录；`rotom/scripts/build-pi-fork.mjs` 隔离构建六个 CLI/SDK runtime 归档。
- `rotom/runtime/pi/`：fork package/lock、源码/构建器摘要和归档；发行包中按锁新安装 node_modules，不依赖维护 checkout。
- `rotom/scripts/pack-release.mjs`：隔离 staging、锁定 npm ci、资源验证、打包清单检查；不使用维护者 node_modules、不运行 install hooks。
- `rotom/bin/rotom`：薄 npm 入口，保留 cwd/argv/environment/exit status。
- `rotom/runtime/resolve-installed-pi.mjs`：固定 fork 来源摘要、六包 version/integrity/installed identity 与 canonical 路径校验，仅解析产品 `runtime/pi/node_modules`，不搜索 ancestor/PATH/global modules。
- `rotom/bin/rotom-launcher`：唯一内部 launcher、Node/Pi 解析、Claude Skill bridge、resource declaration、Subagent 默认 budget、Computer Use 默认后台投递（`PI_COMPUTER_USE_HEADLESS=1`，仅在用户既没给环境变量、也没在 `<agentDir>/extensions/pi-computer-use.json` 或 `<cwd>/.pi/computer-use.json` 显式写 `headless` 时注入）。
- `rotom/bin/check-personal`：日常串行产品 gate 与 context footprint 报告。
- `rotom/runtime/product-config.mjs`：最低 Node、Pi package、第三方 package identity 与 resource descriptors。
- `rotom/runtime/verify-pi-runtime.mjs`：package/exports/path/symlink/integrity verifier。
- `rotom/runtime/process-tree.ts`：进程树、取消、超时与输出预算。
- `rotom/runtime/context-*.mjs`：工具面、Skill 和项目上下文 footprint/discovery；工具 description/parameter bytes 与重复 guideline metadata 的有界用途说明。
- `rotom/extensions/observability/`：metadata trace、dashboard 与测试；公开工具 metadata 的有界 digest/bytes 采样、独立 dispatch/verification/business/process/content 证据，不把 absent 当 false 或 public metadata 当 provider wire。
- `rotom/extensions/browser/`：Pi tools、relay、Chrome MV3、Native Host、installer 与 smoke。
- `rotom/extensions/coding-policy/`：只在 coding tools 激活时追加执行卫生约束；另外为 `read`/`edit` 错误追加证据式修复线索（`repair-hints.ts`），并把会话运行期间 pi bundle 被重建导致的 lazy chunk 缺失改写为可归因结论（`pi-runtime-drift.ts`）。两者都只附加信息，不改变成功/失败判定。
- `rotom/extensions/qoder/`：默认启用的原生直连 provider，`ROTOM_QODER=0` 可显式关闭；默认认证模式为 `browser`，接入 Pi 原生 OAuth 与独立凭据存储，不读写 CLI 凭据；显式 `ROTOM_QODER_AUTH=qodercli` 才使用只读 CLI 兼容模式。browser 的一次性刷新摘要记录防止 unknown 重放（隔离独立登录与串行真实刷新已通过，未等待自然到期）。`catalog.mjs` / `catalog-auth.mjs` 通过固定 COSY 目录和 Pi 公开 refresh/publication 合同提供账号隔离、仅内存的模型发现；只注册已验证 key 与 enabled 目录交集。会话绑定不迁移，当前 Default 目录 17 条路线已分项实测，13 条 reasoning，其中八条按实测白名单与当前目录交集开放 effort，其余固定 enabled；兼容版本头 1.1.45 获取 Sonus 的真实 key。Ultimate 旧双字段与新 COSY 三字段、Sonus 的不同加密 item 通过独立 Pi signature 保留；`legacy.mjs` 为十条 key（含 Ultimate）明确选择 COSY 单次推理，不作自动回退。仅 Ultimate/Kimi-K3/DeepSeek-V4-Flash 的图片与 272K 管理窗口（与 Codex 声明对齐）取实测白名单和当前目录交集，固定 400K selector，输出≤4096；其余保持文本/≤32K。`transport.mjs` 统一原生图片与 post-hook 的编码/大小边界；不通过绕过 Pi 原生预算来增加容量。`credits.mjs` 收集完整流的 allowlisted Credit，按原会话归属持久化非上下文观察；无计量/未完成保持 unknown。额度命令仅 UI 通知，不把账户余额带入正常、压缩或分支上下文；Credit、余额与 USD 分开。不是未来任意目录、Enterprise 或 Qoder 官方支持承诺。
- `rotom/extensions/third-party/index.ts`：四个 package 的唯一 composition root。
- `rotom/extensions/third-party/deferred-tools/register.ts`：capability map、additive activation 和 session state。
- `rotom/extensions/third-party/subagent/policy.ts`：model-visible action/command 收窄、`mission:false`、publication lease 与结果证据投影；启动回执/任务结果不证明所有 child 或远端副作用已完成。
- `rotom/skills/pi-subagents/SKILL.md`：产品自有精简指南；只覆盖当前工具面，不加载上游完整指南及其 references。独立于 extension 目录，避免触发 Pi 的 package 目录发现规则而改变扩展加载。
- `rotom/evals/`：有界 host/container eval harness、profiles、judge、artifact 与 benchmark adapter。
- `CLAUDE.md`：仓库维护、产品边界、验证和交付的唯一根指南。
