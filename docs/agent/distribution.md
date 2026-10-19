# rotom · npm 分发合同

发行包身份和源码版本以 [`rotom/package.json`](../../rotom/package.json) 为准；维护源码版本不等于当前 PATH 安装或 registry `latest`。不要从旧实验的测试计数、临时路径或 dist-tag 快照推断现在的状态。旧发布流水可从 Git 历史追溯；最新已核验发布见 [npm-0.1.26.md](npm-0.1.26.md)，上一版记录见 [npm-0.1.25.md](npm-0.1.25.md)。

## 包与源码边界

- 产品包为 `@bingjiang0611/rotom`，保留 `UNLICENSED`、第三方归属及 [THIRD_PARTY_NOTICES.md](../../rotom/THIRD_PARTY_NOTICES.md)。公开 npm access 不代表开放新增代码的再分发授权。
- 产品的 Pi fork、内化 Subagent、Goal、Computer Use 和其他资源以固定发行 identity、lockfile 与 [`product-config.mjs`](../../rotom/runtime/product-config.mjs) 为准。不把维护目录或本机已安装内容当作发布产物。
- 发行为一次冻结的 tgz。记录源码 revision、完整依赖身份、文件列表、integrity/shasum 与产物摘要；构建后验证同一个产物，不能重新打包后沿用旧 gate。
- 公开 tree/history 与归档须通过隐私审计。不得上传公司信息、真实凭据、私有 HOME、原始会话、模型评测日志或本机临时目录；公开测试向量仅按明确白名单处理。

## 构建与验证

从仓库根目录使用 `rotom/package.json` 中的实际入口：

```sh
npm --prefix rotom run pack:release
npm --prefix rotom run audit:public
npm --prefix rotom run test:distribution
npm --prefix rotom run check:pi
```

完整门禁和授权范围见 [verification.md](verification.md)。在隔离 prefix/私有 HOME 中验证 tgz 的全新安装、升级、启动、default/full runtime smoke 和卸载；不能覆盖维护者当前安装，不能以复用依赖的检查代替冷安装。

- 检查实际 npm bin、内置组件、资源选择和源码字节，而不只看 `--version` 文本。
- 未使用真实模型、浏览器或跨平台时如实记录，不能把 synthetic/loopback 结果外推为账号、费用或业务验收。
- 对历史 helper 或兼容 fixture，先核对全部输入；缺少旧 preimage 时不能在当前树恢复旧框架、解除未知任务或改写验收线。
- 新 session 的默认 scope 与不迁移边界见 [subagent-owned-default.md](subagent-owned-default.md)。安装包不迁移活跃会话，也不授权 replay。

## 发布必须由维护者在前台执行

Agent 负责源码、确定性检查、唯一 tgz、隔离验证和只读回验。维护者本人负责 npm login、网页/OTP、不可逆 publish 和本机安装切换。不要用后台 shell、AppleScript 或浏览器工具触发发布或等待不可见的 2FA。

构建完成后，生成绑定绝对 tgz、version、tag 和摘要的命令单：

```sh
node scripts/npm-release-handoff.mjs commands '/absolute/output/bingjiang0611-rotom-<version>.tgz' latest
```

在同一个前台终端按输出顺序逐段执行，不整块无脑粘贴：

1. `preflight` 只读证明精确版本不存在；已有版本或未知结果不授权再次 publish。
2. 使用本次发布专用的私有 npm config/cache，清除环境 token，由用户登录。
3. `npm publish` 只执行一次。出现 `EOTP` 时，先处理该前台命令的官方 challenge，再执行 `verify`；不根据错误文本重复发布。
4. `verify` 要求 version、dist-tag、integrity、shasum 和下载 tarball 字节全部等于冻结产物。CLI 的接收/处理中提示不证明成功。
5. 仅在 `verified: true` 后执行命令单给出的 `install-release.sh`；由 Agent 只读回验 registry、`rotom --version --verbose`、活动路径和内置组件。
6. 最后由用户执行命令单中的 logout、`npm whoami` 失败回读和临时认证目录清理。

该 helper 不登录、不发布、不安装、不退出登录，也不读取 npm 凭据。`commands` 无网络，`preflight`/`verify` 只访问固定 npm registry；它不能替代构建、隐私、distribution、runtime smoke 或升级/卸载门禁。

## 当前安装与验收记录

发布、下载一致、安装切换、当前运行、卸载和真实业务是不同结果，分别记录。失败、超时和 unknown 必须保留，不能由后续 PASS 抹去或默认成功。这里只定义发行流程，不声称执行了新的发布、安装、付费请求或完整跨平台验收。
