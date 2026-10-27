# 任务 02 · 接入 rotom（`sol-pi@0.1.0-rotom.4`）

范围：`packages/rotom-sol-pi/` 的三处小修 + 版本与归档 + `rotom/` 接入 + 文档。模型调用：**无**。验证级别：L1 + 本地 L2（不调用真实模型）。报告写到 `docs/agent/compaction/reports/02-rotom-integration.md`。

前置：任务 01 已 accepted（`3c7c53d`）。

## A. 打包前先修三处（任务 01 核验意见）

1. **ledger / TUI 只是观测，不能改变决定。** 现在 `offload_defer_stale` 的 ledger 写失败会让「再次取消」变成跑原生摘要；`appendEntry` 成功后 `offload_defer` ledger 或 `showSolPiSavings` 失败，也会退回原生摘要。改成：这些写入各自 try/catch，失败只 `console.error` 一行（不带正文），推迟决定照旧。只有 `ensureStored` 失败和 `appendEntry` 抛错才退回原生摘要。相应更新 `tests/compaction-offload.test.ts` 里「ledger failure after append」用例：现在期望 `{ cancel: true }`，且这次推迟算确认过的。
2. **TUI 文案用英文。** SoL-Pi 其余 TUI 都是英文（例如 “context tokens avoided”）。`constants/copy.ts` 的 `deferred` 改成英文，例如 `compaction deferred, ~${n} context tokens offloaded`，数字沿用 `formatSavingsCount` 的格式。
3. **投影不要每次请求都重读重哈希。** 在 `createCompactionOffload` 内存里记一个已校验集合（键 `${root}\0${id}`），校验通过一次后同一进程内不再 `lstat` + `ensureStored`；`session_start` / `session_tree` 时清空。fail-open 行为不变。加一个用例：同一结果连续投影两次，第二次不触发文件读取（可用 spy 或删除对象文件后仍返回占位符来证明走了缓存，二选一，报告里说明）。

## B. 版本与归档

参照 `rotom/extensions/third-party/vendor/README.md`「Locked SoL-Pi distribution」和以往 `.rotom.1`→`.rotom.3` 的做法：

- `packages/rotom-sol-pi/package.json` / `package-lock.json` 版本 → `0.1.0-rotom.4`；`UPSTREAM.md` 的「rotom changes」加 `.rotom.4` 一条（压缩卸载、默认关闭、依赖 Observation Pack、持久化 unknown 语义）。
- 在 `packages/rotom-sol-pi` 用 `npm pack` 生成 `sol-pi-0.1.0-rotom.4.tgz`，放进 `rotom/extensions/third-party/vendor/`。记录 SHA-256 与 SHA-512 SRI。
- 同步 `rotom/extensions/third-party/package.json`、`package-lock.json`（resolved 指向相对归档、integrity）、`rotom/runtime/product-config.mjs`（version、integrity、archive）。
- 旧 `.rotom.3` 归档按以往惯例处理（README 里写过 `.rotom.0`/`.rotom.1` 被移除）；如果有测试或文档还引用它，就保留并在报告说明。
- 更新 vendor README 的 SoL-Pi 小节（版本、摘要、`.rotom.4` 一句话、测试数）。

## C. rotom 接入

`rotom/extensions/third-party/sol-pi.ts`：

- `ROTOM_SOL_PI_DEFAULT_CONFIG` 里 `compactionOffload` **保持 `false`**（是否默认开启等任务 03 的数据；bob 若另有决定，以 README 状态表为准）。
- 新增环境变量 `ROTOM_COMPACTION_OFFLOAD`，在最终配置（rotom 默认或用户配置文件）之上覆盖 `compactionOffload`：
  - `1` → `true`，但仅当最终 `observationPack === true`；否则保持 `false`，并 `console.error` 一行说明需要 Observation Pack。不要因此让启动失败。
  - `0` → 强制 `false`。
  - 未设置或空串 → 不覆盖。其它值 → 按未设置处理，并 `console.error` 一行。
- 这样任务 03 可以用同一个安装、只切环境变量做开启/关闭对照。
- `rotom/extensions/third-party/index.test.ts` 补用例：默认关；`1` 开；`1` 但用户配置关了 Observation Pack → 仍关；`0` 覆盖用户配置里的 `true`；非法值不覆盖。现有 `features()` 断言如果因为多了字段需要改，一并改。

## D. 文档

- `docs/usage.md` 的 SoL-Pi 小节：版本号改为 `.rotom.4`（现在写的还是 `.rotom.2`，顺手修正），加一段「压缩卸载（默认关闭）」：做什么、怎么开（`ROTOM_COMPACTION_OFFLOAD=1` 或配置文件 `compactionOffload: true`）、依赖 Observation Pack、推迟时 TUI 会出现 “Auto-compaction cancelled” 加一行说明、收益未经真实会话验证。≤ 15 行。
- 根 `CLAUDE.md` 第 3 节提到 SoL-Pi 默认开启项的那句，补半句「Compaction Offload 默认关闭（`ROTOM_COMPACTION_OFFLOAD=1` 开启），收益待实测」。只改这一处，不动其它段落。
- `docs/agent/verification.md` 如有 SoL-Pi 版本/测试数描述，同步。

## 不做

- 不改 Pi fork、observability trace 合同、Context Layers。
- 不调用真实模型，不跑付费对照（任务 03）。
- 不升 rotom 产品版本、不跑 `pack:release`、不发布 npm。

## 验收命令（规划者会重跑）

```sh
cd packages/rotom-sol-pi
npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always
npm run typecheck
npx vitest run tests/compaction-offload.test.ts
npm test                     # 仍只允许 install-guide 的 2 个已知失败
npm pack --dry-run
cd ../../rotom/extensions/third-party
npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never
node --experimental-strip-types --test index.test.ts   # 若仓库实际用别的入口跑这个文件，用实际入口并在报告写明
cd ../..
# 归档摘要与 product-config / lockfile 一致
shasum -a 256 extensions/third-party/vendor/sol-pi-0.1.0-rotom.4.tgz
node -e "const c=require('node:fs').readFileSync('runtime/product-config.mjs','utf8');console.log(/sol-pi.*rotom\.4/.test(c))"
cd ..
git diff --check origin/main...HEAD
python3 scripts/audit-public.py --root .
```

另外跑 `verification.md`「第三方 package/deferred/context」一行要求的 package identity 与 public loader smoke（按该文档的实际命令），报告里写命令和结果；跑不了的写明原因。

## 报告必须写明

- 每个改动文件一句话；新归档的 SHA-256、SRI、文件数、大小。
- A 部分三处修复各自的测试证据。
- 环境变量四种取值的实际行为（贴测试名即可）。
- 哪些检查是 L1、哪些是本地 L2；明确未做真实模型验证。
