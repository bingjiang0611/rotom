# Computer Use v2.1 合并与发布（第六期交接）

用户决定（2026-11-11）：剩余的使用问题在使用中再处理，现在做打包、类型检查清零、合入 `main` 并发布。
本文按阶段写清顺序和每一阶段的闸门。根 `CLAUDE.md` 的“npm 正式发布顺序”和隐私规则全部适用，本文只补充 Computer Use 特有的部分。
每一阶段完成后推送并报告 SHA，审核者通过后才进入下一阶段。

## 发布时如实写明的状态（用户已知并接受）

| 能力 | 证据层级 |
| --- | --- |
| Finder 后台读取、AXOpen 打开文件夹、Ask 授权弹层、授权等待不再提前放弃 | 真机，用户报告不打扰（REVIEW-18、20、22） |
| 打开文件或 App 的确认（O1） | 真机通过（用户报告，细节未留存） |
| L2 定向投递 | 真机 0 次成功、5 次失败；IntelliJ 后台点击默认走 L2（用户决定保持开启），可能不生效 |
| pid 投递 | 真机没有成功记录 |
| 后台打字、输入法分流（H2）、剪贴板恢复、前台接管暂停与恢复、租约强制校验 | 只有离线测试和原生自测（L1） |
| B 阶段 B1–B6 | 未通过；本机端点安全会终止每次换新 bundle id 的 fixture 副本 |

这些要原样写进根 `CLAUDE.md` 和发布说明，不能写成“已启用”或“已验证”。

## 阶段 1：类型检查清零（S2）

- 把剩余的 144 项类型错误清零，`pretest` 换回完整的 `typecheck`。只修类型，不改运行时行为；如果某个类型错误背后是真实的运行时缺陷，
  单独列出来并补测试。
- 闸门：`npm test` 全绿（含完整 typecheck）、dry run、文件树审计 0 项。

## 阶段 2：打包 Computer Use（P1）

1. 按 `packages/rotom-computer-use/UPSTREAM.md` 在 Mac 上重建归档：恢复未改动的 Windows、Linux 产物，`build-native.mjs --arch all`，`npm pack --ignore-scripts`。
2. 版本号改为 `0.5.1-rotom.3`（内容变了就换版本号）；同时更新 vendored tgz、`rotom/extensions/third-party/package.json` 和 lock、
   `rotom/runtime/product-config.mjs` 的 version、integrity、archive。
3. **签名问题必须先查清**：`setup-helper.mjs` 会生成本地自签名证书（`pi-computer-use Local Signing`）给 helper 签名。本机端点安全终止过“ad-hoc 或证书链未知”的程序，
   而用户日常可用的 helper 是用用户的 Apple Development 证书签的。请只读查清：(a) 用户日常 helper 当前的签名和安装方式；(b) 升级后 helper 由谁、用什么身份签名；
   (c) 有没有现成的方式让用户指定自己的签名身份（如 `PI_COMPUTER_USE_CODESIGN_IDENTITY`）。结论写进 STATUS，不要改用户证书，不导出私钥。
4. 闸门：完整测试、vendored tgz 的 integrity 与 lock、product-config 一致，`rotom` 的分发测试通过。

## 阶段 3：文档

- 根 `CLAUDE.md` §4：按上表如实更新 Computer Use 的能力和证据层级、helper 协议 11、broker 协议 2；“协作式仲裁”的措辞按 HANDOFF-2 的约定保持
  （B4 没有在真机通过）。
- 发布说明：新增能力、行为变化（`behaviour-changes.md` 第 1–10 条的摘要）、已知限制（上表）、ScreenCaptureKit 每月一次的系统确认弹窗、升级前先退出正在运行的
  rotom 会话（不覆盖存活会话的 helper）。

## 阶段 4：合入 `main`

按根 `CLAUDE.md`：从最新公开 `origin/main` 建独立干净 clone，以 GitHub noreply 身份重放 v2.1 相对 `main` 的 diff（不带分支历史），解决冲突，
跑 `python3 scripts/audit-public.py --root . --history` 和完整测试，只做 fast-forward 推送。分支历史里的非 noreply 身份和家目录路径命中不进 `main`。

## 阶段 5：发布

严格按根 `CLAUDE.md`“npm 正式发布顺序”1–9 步执行，补充两点：

- **版本号和 dist-tag 必须由用户明确给出**，缺一项就停下询问。审核者建议：版本 `0.2.0`（helper 和 broker 协议变化，旧 helper 会被拒绝），
  dist-tag 用 `next` 而不是 `latest`，等用户日常使用一段时间后再提升为 `latest`。最终以用户的回答为准。
- **最终 tgz 的验证必须包含本机 helper 启动**：在隔离的 HOME 和 prefix 里安装最终 tgz，确认 Computer Use 的 helper 能在这台受管 Mac 上启动、
  `diagnostics` 正常。如果被端点安全终止，就停在这里：发布会让用户升级后无法使用 Computer Use，必须先解决签名方式。
- `npm login`、`npm whoami`、`npm publish` 和本机安装切换都由用户在自己的前台终端执行；Agent 只用 `scripts/npm-release-handoff.mjs` 生成命令，并只读核验 registry。

## 用户决定（2026-11-12）：版本与 dist-tag

用户明确授权：发布版本 **`0.2.0`**，dist-tag **`latest`**（审核者原建议 `next`，用户选择 `latest`）。这满足根 `CLAUDE.md` 对“精确 version 与 dist-tag”的授权要求；
发布前仍按发布顺序第 6 步，再次核对公开 commit、`0.2.0` 在 registry 中尚不存在、dist-tag 为 `latest`、最终 tgz 的 SHA-256 和 SRI。

因为发布到 `latest`，所有安装或升级的用户都会拿到这一版，而升级后必须先退出会话和旧 helper、运行 `rotom helper update`（受管 Mac 先设置
`PI_COMPUTER_USE_CODESIGN_IDENTITY`），否则 Computer Use 会因协议不匹配报错。发布说明必须把升级步骤放在最前面，并如实列出未经真机验证的能力。
