# rotom · npm 分发准备

> 本页的验证表保留首次分发接入时的结果；安装命令与当前元数据已同步源码。项目仓库为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)，源码公开不等于 npm 发布。后续默认组件与 macOS/Linux 安装验证见 [Subagent 默认接入](subagent-default-integration.md)，发行包默认 scope 及其未复验项见 [scoped 默认](subagent-owned-default.md)。

当前 alpha.12 使用仓内 Pi fork；构建、隔离安装、本机切换及未验证项见 [Pi fork 接入](pi-fork.md)。本页底部“首次分发”表仍是历史上游 Pi 基线，不代表新 fork 的跨平台验收。

## 范围与结论

用户授权实现“安装 rotom 即自动获得 Pi 和产品扩展”的 npm 安装产物。本轮没有公开发布、推送、真实模型调用、Chrome 安装/重载或业务页面操作，也没有更改维护者全局 CLI 与本地仓库目录。

**PASS：本地打包、隔离安装和 L1/L2 验证。BLOCKED：公开发布及完整跨平台/真实业务验收。**

当前产品元数据位于 `rotom/package.json`：`@bingjiang0611/rotom@0.1.0-alpha.12`、公开 npm 包、`UNLICENSED`。包内包含完整 Pi 运行时。

## 分发与启动

```text
packages/rotom-pi/ -> npm run build:pi
  -> 六个 0.85.1-rotom.1 运行时归档 + 来源/源码/构建器摘要
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

- 当前分发基线是仓内 Pi fork；源码、上游 revision 与维护说明位于 `packages/rotom-pi/`。六个包保留 upstream identity，归档使用 `0.85.1-rotom.1` 后缀和来源摘要，不冒充官方发行。
- `runtime/pi/package-lock.json` 只允许六个明确声明的本地归档，其余传递依赖必须是公共 registry 且带 SHA-512；拒绝链接、隐藏的官方 Pi 副本和未知本地 URL。源码或构建器改动后须重建，pack gate 拒绝陈旧归档。
- 默认仅加载 `runtime/pi/node_modules/`；缺失、错误版本、symlink、来源或路径漂移即停止，不搜索全局 Pi、旁边的源码树或旧安装。
- `ROTOM_PI` 保留为显式维护覆盖；允许选择通过原有 capability gate 的兼容版本。这是非默认发行配置，评测时必须披露。
- `rotom --version` 保留 Pi 的版本输出（0.85.1-rotom.1），rotom 自身版本见产品 package.json。
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
