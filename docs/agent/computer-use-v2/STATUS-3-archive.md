# 阶段 2 第二步：U1–U4 与 0.5.1-rotom.4 归档

范围依据：`REVIEW-24.md`（审核分支 `addfcc5`）及维护者对 U1–U4、组件版本 `.rotom.4` 的授权。只交付审核分支；不合并 main、不发布、不登录 npm、不替换日常 helper。

## 实现

- **U1**：`scripts/macos-sources.mjs` 是两个构建入口共用的 9 文件 Swift 列表。源码回退补齐 input source、takeover 与 text outcome 文件。测试检查两个入口都消费此列表，不再各写 Swift 字面量列表。
- **U2**：用户主动运行 `rotom helper update`。launcher 先验证 Node，runtime 验证已安装第三方包合同与更新脚本路径，再调用组件 `setup-helper.mjs --update`。不启动 Pi 会话。
  - 目标固定为当前 HOME 下 `Applications/pi-computer-use.app`，bundle/signing Identifier 保持 `com.injaneity.pi-computer-use`。自定义 helper 路径不会被顺带覆盖。
  - 检查目标 executable 是否被任何进程占用；包括空闲 helper 在内，发现占用就拒绝，提示关闭所属会话并退出 helper。检查失败或不明确也拒绝。不会杀进程。
  - 验证预构建 app，复制到同目录暂存区。设置 `PI_COMPUTER_USE_CODESIGN_IDENTITY` 时，只对暂存副本调用该身份签名，再做严格签名校验。不会生成、导入、修改证书或导出私钥。
  - 未指定身份时保留预构建签名，并保留原有 ad-hoc 覆盖保护。普通 postinstall/runtime 安装路径的行为不变。
  - 替换前再次检查占用。两个 updater 由目录锁串行化；第二次 rename 失败时保留旧 app 的备份并报告路径，不自动重放。
- **U3**：mismatch 文案给出确切更新命令、签名身份环境变量、默认安装位置与自定义路径说明。不增加 broker 的运行时依赖，不自动更新或重启。
- **U4**：重建 macOS x64、arm64、universal，全部 ad-hoc 签名；恢复并保留旧包 Windows/Linux 字节。同步组件 manifest、产品第三方 manifest/lock、product-config、notice 与归档说明。保留 `.rotom.2` 旧归档；不复用公开 main 已使用的 `.rotom.3`。

## 产物

`rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.4.tgz`

| 项目 | 结果 |
|---|---|
| 文件数 | 141 |
| 压缩 / 解包字节 | 6,439,207 / 18,389,447 |
| SHA-256 | `d3afc8b3e1a2006b66418507178d1426b2fbc047dc1d7bd07ed8ba06ad4fb15a` |
| SHA-512 SRI | `sha512-2gfoCRk6DnycZRLJSr8WS4UISQgZpYblJEjz3ScSchxrtgdlIbt/ygVvFxdATTdUkZnj/FhZ2hzKxiJBht1+WQ==` |
| 归档与 checkout | 全部成员逐字节一致，其中 133 个非 prebuilt 文件 |
| Windows/Linux | 3 个文件与旧归档逐字节一致 |
| 旧归档 | SHA-256 保持 `6c401991d1854180954663621ba85cde978608b14abe7297c993f1de1fded9b8` |
| Mac 签名 | 三个产物均严格校验通过；Identifier 正确、`Signature=adhoc`、无个人 Authority |
| universal | `x86_64 arm64`；plist fork version 为 `.rotom.4` |
| 实际 tgz 隐私审计 | 142 个扫描对象、0 findings；启发式扫描，不是任意秘密或所有权保证 |

构建使用 `node scripts/build-native.mjs --arch all --sign-identity -`，打包使用 `npm pack --ignore-scripts`。维护 checkout 的第三方依赖按锁安装并禁用所有脚本；没有运行日常 helper 的安装或更新。第一次漏加 `--legacy-peer-deps` 的 `npm ci` 在 peer/lock 预检失败；随后使用发布脚本规定的该选项通过，没有引入官方 npm Pi 或修改依赖范围。

## 已取得的验证与边界

- 新增定向检查 **14/14**：组件 12 项、产品命令 2 项。覆盖两次忙碌检查、检查失败、签名/校验失败保留原件、签名目标/身份参数、无身份行为、并发更新锁、symlink 拒绝、共享 Swift 列表与 mismatch 文案。
- 实际 `lsof` 检测的是持有临时 fixture executable 的文件描述符，不是假定返回值，也没有运行 native helper。
- 从实际 `.4` tgz 解包，在独立临时 HOME 执行真实 installer：用显式 `-` 身份签署安装副本，严格签名校验通过，bundle id 保持不变、源 app 字节未变；随后不指定身份时拒绝覆盖已有 ad-hoc app，原件不变。没有访问或替换日常安装，没有启动 helper。**这不证明 Apple Development 身份签名或受管 Mac 上启动成功。**
- 负对照：在独立副本删除占用检查，两个拒绝用例均以 `Missing expected rejection` 失败。没有改生产实现或降低原断言。
- 本阶段观测到一个**既有 broker 失败**：完整 `npm test` 首次运行出现 broker 并发用例失败，并在 300 秒工具期限被中止。独立重跑为 6/7，错误是清理目录时 `ENOTEMPTY`；以 HEAD 原始 broker 依赖闭包建立的独立对照也为 6/7、同一错误。临时保留目录的诊断运行通过，但不算修复。机器当时 load average 为约 165；这是相关环境现象，不足以单独证明根因。没有修改 broker 生产逻辑、原测试断言或内部超时来迁就结果。
- 后续一次完整 `npm test` 为 **310/311**：broker 用例通过，未改动的 `typecheck-pretest.test.ts` 在 `spawnSync npm` 的 30 秒期限返回 `ETIMEDOUT`。真实项目全量 typecheck 已通过；这个 fixture 失败仍计失败，未放宽内部期限。产品检查第一次因缺少 `ROTOM_PI` 而有 9 项 loader 配置错误；指定仓内 pinned Pi、隔离 HOME/TMPDIR 并关闭真实 broker 后，产品/分发/归档/命令检查 **75/75**。
- 因而不能把定向通过冒充整套长期稳定或真机验收。最后变更后的完整计数以本阶段交付报告为准；本状态保留失败证据，不因一次后续通过而抹除该问题。

最终复验入口（从相应 package/repository cwd 运行）：

```sh
# 先把 HOME/TMPDIR 指向本次独立临时目录，不使用日常会话目录。
# packages/rotom-computer-use
npm test
node scripts/cu-v2-script-dry-run.mjs
# repository；ROTOM_PI 指向本仓实际已安装的固定 fork，不从 PATH 找全局 Pi。
ROTOM_PI="$PWD/rotom/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
ROTOM_CU_BROKER=0 node --test --test-concurrency=1 --experimental-strip-types \
  rotom/extensions/third-party/index.test.ts \
  rotom/extensions/third-party/computer-use/approval.test.ts \
  rotom/runtime/distribution.test.mjs \
  rotom/runtime/third-party-archive.test.mjs \
  rotom/runtime/update-helper.test.mjs
python3 scripts/audit-public.py --root .
python3 scripts/audit-public.py --root . --history
python3 scripts/audit-public.py --root . --artifact \
  rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.4.tgz
```

历史隐私审计在本阶段之前已有 83 条 finding；当前 tracked tree / 新 tgz 的通过不等于旧历史通过。以后合入公开 main 仍须走干净公开基线重放，不导入本分支历史。

## 尚未验证与下一道审核门

1. 用户真实签名身份、日常 helper 替换、最终 helper 启动/诊断均未执行。受管 Mac 的策略是否接受最终副本仍未知；须单独授权验证，不绕过安全软件。
2. 更新目录锁只串行化 updater，不是 OS 启动锁。旧 launcher 或外部进程可在最后检查之后启动 helper。用户必须在整个更新期间保持所属会话关闭；不宣称消除了外部启动竞争。
3. 既有 broker 并发清理失败未修复；由维护者审核其是否需另开修复范围。本阶段不顺带改 broker 或测试门禁。
4. 提交、推送本阶段后停下等审核；不进入阶段 3，不合并、不发布。真实签名/升级/启动需维护者另外授权。
