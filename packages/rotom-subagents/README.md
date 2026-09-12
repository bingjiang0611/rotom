# rotom-subagents

rotom 独立维护的 Subagent 组件，源码单源是本目录。它是 `pi-subagents` 的私有维护分支，**不是 Pi fork**。保留 npm/internal ID `pi-subagents`，避免无关协议与资源身份迁移；版本从 `0.52.1-rotom.0` 独立演进，不自动合并上游。

首次导入为已验证的 `0.52.1-dev-agent-owned-flat.7`：213 TS 文件逐字节保持不变。来源、版权和维护差异见 [UPSTREAM.md](UPSTREAM.md) / `IMPORT.json`，原始 README 保存在 [docs/upstream-readme.md](docs/upstream-readme.md)。历史八层 patch 仅用于旧版本比较，不是本组件的构建输入。

## 边界

- 只通过 Pi 公开 API/exports 接入；默认验证 Pi 0.85.1、Node 24.18.0。
- 修改 `src/`，不要修改任何 installed `node_modules`。
- 产品通过固定归档安装本组件；本目录不会被 launcher 自动发现或热加载。个人默认 scope 由新进程的启动环境选择，不迁移活跃会话。
- runtime 代码、exports、内置资源均先保持不变；保留源码中的上游能力不代表 rotom 暴露它们。
- 默认 scope 不变。新进程显式选择 `owned-process-groups-v2` 前先读 [执行范围](docs/owned-execution.md)。容量、历史关闭、恢复授权分开；unknown 不重放，不迁移存活会话。
- MIT 原始版权/许可证保留；`private:true`，不发布 npm。上游安全修复、许可证和 Pi/Node 兼容变化仍需人工关注。

## `0.52.1-rotom.1`：常用 agent 的 scoped 配置

`worker`、`scout`、`reviewer` 现在明确声明空 ambient extensions 与 `defaultContext: fresh`，工具白名单不扩大，仍保留模型/工具的原生用户与项目 overrides。只改这三个内置 profile，不自动修补自定义 agent、不替换显式 fork 请求、不移除 admission 拒绝规则。其他未适配 agent 在 owned scope 下可能拒绝启动。213 TS 执行代码保持原样。

## 开发

在本目录运行；依赖是固定版本及本目录 lockfile，勿复制维护者 node_modules：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test                 # 打包/路径/来源合同 + 19 项 wait/drain 边界
npm run test:sdk         # 本源码快照：真实进程、local faux、admission/owner loss
npm run test:compat      # 历史 reader/lease/capacity 等兼容回归
npm run typecheck        # --listFilesOnly 绑定当前快照，不使用旧 tsconfig
# 或 npm run test:all
```

当前源码的测试快照直接复制本目录，不应用补丁、不从旧归档抽取实现。`test:compat` 中旧 reader/对照版本仍由历史 fixtures 生成，这是比较证据，不是新源码的依赖。复用仓库的 verifier 与测试驱动，不另建 Pi 框架。无需私有 upstream checkout 或真实账号；测试使用隔离 HOME，无远端模型授权。

## 打包与独立产品接入

发行前用 `npm version --no-git-tag-version 0.52.1-rotom.N` 显式升版本（同步 lock），不重用已有归档身份。先跑上面的检查；`pack:release` 校验 lock、payload、实际 tgz 隐私扫描，不复制 dependencies、tests、脚本或运行记录，不覆盖旧产物：

```sh
OUT=$(mktemp -d "${TMPDIR:-/tmp}/rotom-subagents-output.XXXXXX")
OUT=$(cd "$OUT" && pwd -P)
npm run pack:release -- "$OUT"
```

生成 `pi-subagents-<version>.tgz` 与 `.tgz.json` receipt（源码摘要、完整性、审计）。下面在**新副本**同步 product manifest、lock/shrinkwrap、archive、product-config；不编辑当前仓库运行时声明或安装：

```sh
npm run stage:product -- \
  --archive "$OUT/pi-subagents-0.52.1-rotom.0.tgz" \
  --output "$OUT/product-source" --revision HEAD \
  --product-version 0.1.0-rotom-subagents.0
(cd "$OUT/product-source/rotom" && npm run pack:release -- "$OUT")
PREFIX="$OUT/install"
npm install --prefix "$PREFIX" --ignore-scripts --no-audit --no-fund \
  "$OUT/rotom-0.1.0-rotom-subagents.0.tgz"
mkdir -m 700 "$OUT/product-evidence"
npm run test:product -- "$PREFIX" "$OUT/product-evidence"
```

`--revision` 是固定的 committed 产品输入；dirty WIP 不混入。新组件版本/产品版本每次发行递增，示例版本仅对应首次导入。`test:product` 跑实际 npm bin 的六种本地 SSE 场景，证明 cwd/argv、等待/自动等待、native resume 和 mixed/foreground workflow，不冒充真实模型或业务效果验证。发布前还需按根维护门禁执行 distribution/default/full smoke、升级/卸载及对应 OS 验证；上述命令不自动升级存活安装。

## 后续维护

1. 在本目录改源码并补语义回归；不用更新 `IMPORT.json` 来掩盖与原始导入的差异。
2. 协议、scope、lease 与 resource identity 改动扩大验证，继续保留 unknown/取消/外部写不重放边界。
3. 先单独改行为，再另行删除不需要的旧能力；不要把初次内化与大规模裁剪绑在一起。
4. 上游只人工挑选必要修复，记录来源与许可证，独立测试；不追版本号自动覆盖本地实现。
