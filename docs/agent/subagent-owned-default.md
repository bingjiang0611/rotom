# scoped 执行成为发行包默认

> 默认行为仍适用；下方安装路径、产物摘要与验证表记录 `alpha.3` 这一批，不是当前 PATH 状态或最新版本的重新验收。当前产品版本见 `rotom/package.json`。

## 当前状态

`rotom@0.1.0-alpha.3` 起，**scoped 执行是发行包默认**，不再需要外部 wrapper 或手工 opt-in：

- launcher 在启动 Pi 前选定 `PI_SUBAGENTS_EXECUTION_SCOPE=owned-process-groups-v2`，并在 `~/.local/state/rotom/subagent-store` 锚定 store。已存在的锚点直接复用，绝不替换。
- store 放在持久 state 目录而不是临时目录，避免 tmp 清理删掉活跃 store 锚点后使运行中的工作无法证明。
- 组件仍是 `pi-subagents@0.52.1-rotom.1`，213 个 TS 执行源码与已验证导入逐字节一致；本批只改 launcher 默认、启动测试、实际 CLI fixture 与文档。
- 之前的个人 wrapper（`~/.local/share/rotom/owned-default-1/rotom`）与仓库内 `scripts/owned-default-launcher.mjs` 已删除；`rotom` 命令直接指向产品 `bin/rotom`。旧 profile 目录只留 `RETIRED.md` 与旧 store 作为证据，不再使用。
- **切换默认不迁移、不升级、不回放任何既有会话或未知任务。** 存活进程保持原路径与原语义。

### 仍然保留的显式开关

去掉的是"必须手工配置才能用默认"，不是逃生阀。owned scope 会在启动前拒绝不支持的拓扑，没有退路会让人无法工作：

```sh
PI_SUBAGENTS_EXECUTION_SCOPE= rotom        # 显式空值：回到旧 scope，不创建/触碰 store
PI_SUBAGENTS_TEMP_ROOT=/absolute/path rotom # 自定 store 位置（绝对路径）
```

其他值、相对路径、空 store 路径、缺少 HOME、store 身份漂移或不可读，都在启动 Pi 前失败退出：不回退旧 scope、不重建锚点、不启动 writer。`--version` 探测不创建任何 store。

注意 store 锚点自身定义 store 身份，因此**改写锚点里的 `storeId` 不会被识别为漂移**；能被检测的是路径、device/inode 与解析失败。删除整个 base 是用户行为，会把旧记录围栏在外，但同样不授权恢复它们。

### 三个内置 agent

`worker`、`scout`、`reviewer` 显式声明空 extensions 与 `defaultContext: fresh`（`0.52.1-rotom.1` 起）。工具白名单、模型和 thinking 未扩大，用户/项目 `agentOverrides`（含显式 `fork`）仍优先。其他仍依赖 ambient extensions 或隐式工具的自定义 agent，在默认 scope 下会在 writer 前被拒绝，需自行补显式声明。

## 边界

- scoped 执行是**执行归属与资源关闭管理，不是安全沙箱**：工具仍以本机用户权限运行，显式 extensions 仍是受信任本地代码。
- 首个 scoped release 只接受已验证拓扑：单个 async Pi/external CLI 任务或 async workflow controller；nested/worktree/gate/review/fork/import/external job/独立 foreground 在 writer 前拒绝。
- 关闭证明只覆盖已登记的受控资源，`descendantCoverage` 与 `effectVerification` 仍为 `unverified`；capacity 释放不授权恢复或重放。
- 吞吐未测量。三对真实模型对照见 `experiments/subagent-owned-performance/README.md`：串行固定任务未见明显变慢，**不是性能等效或提速证明**。

## 门禁与实际证据

`/tmp/rotom-release-default-root` 指向本批私有证据根（上一批 wrapper 阶段在 `/tmp/rotom-owned-default-root`）。产品 `rotom-0.1.0-alpha.3.tgz`：9366320 bytes / 3805 files，SHA512 SRI `sha512-L/NvzepXpsaANpYDzWW8+tfqQ+ixNukDtN9QaMIP8HxMxuoVvTlAnbT/pAXV9jEhg8hGdqOVKWc2z7+g7fd9Nw==`；已安装内容与该归档逐字节一致（3805/3805）。

| 验证 | 结果 |
|---|---|
| launcher 启动契约 `verify-pi-runtime.test.mjs` | 33/33，含默认 scope/store 路径、锚点幂等复用、显式空值 opt-out、显式 base、非法 scope/相对或空 base/缺 HOME 在 Pi 启动前失败、路径/inode/解析漂移退出 1 且不重写锚点 |
| 新锁 fresh 副本 `check-personal` | 321/321 |
| `test:distribution` | 16/16 |
| 实际 npm bin 六场景 | PASS：wait、persistent、drain、deferred、native resume、mixed/foreground；fixture 不再注入 scope/store，由产品自建并核对 v3 锚点与只读 inspect |
| 三个内置 profile（产品默认 scope） | worker/scout/reviewer 各自 dispatch→read→wait→native resume→close，`ownedClosure.state=observed` |
| 已切换的 PATH 命令 | 实际链接完成同一 worker 全链路，`publicNpmBin:true` |
| default/full runtime smoke | 2/2 |
| 独立 prefix alpha.2 → alpha.3 → 卸载 | PASS；安装外 v3 marker SHA256 不变，`recoveryAuthorized:false` |
| 旁路安装保护 | 切换前后 56099 个旧安装/维护 runtime 文件 SHA256 不变（含保留的 alpha.1、alpha.2 与全局旧包） |

所有模型请求都是本地 faux/loopback SSE，零远端模型调用。

### 未验证与保留的失败

- **Linux 未复验**：本批只在 macOS 执行启动契约、实际 CLI 与 smoke。launcher 是 POSIX sh 且组件源码未变，但 Linux 上的新默认未实测。
- 未测试 Windows、GUI/Chrome 绑定、真实业务效果、活跃会话升级或发布。
- 第一次编写的漂移负例把"改写 `storeId`"当作漂移，实际被接受（锚点自定义身份），测试 32/33 失败。改为路径/inode/解析漂移后 33/33，并在上文明确该语义，而不是放宽运行时。
- 一次完整 `check-personal` 出现 319/321：`process-tree.test.ts` 的 `aborted` 分支返回 `unavailable`。单独重跑两次均 5/5，随后完整门 321/321。该用例与 Subagent scope 无关，属于时序敏感的既有波动，未追认为本次回归，也未用后续 PASS 抹去首次失败日志。
- 上一批 wrapper 阶段的证据、日志与已退休 profile 保留，不冒充本批结果。
