# Computer Use v2.1 第 28 轮审核：0.2.0 发布冻结提交（`main`，`ab7d49a`）

## 结论

**需要修改，`ab7d49a` 不能作为构建源。** 内容和边界基本正确，但新增的 `publishConfig.tag` 让产品自己的发行合同测试失败（F1）。
修完 F1、在 Mac 上用 Node 24 重跑产品测试后，用新的冻结提交送审。暂不打包。

## 核对通过的部分

- **范围**：提交只改 5 个文件：`rotom/package.json` 和 4 份文档（`0.2.0-freeze.md`、`computer-use-v2-draft.md`、`distribution.md`、`STATUS.md`）。
  没有产品代码、组件归档、锁文件、Pi 构建器或签名相关改动。
- **历史**：`main` 为 `1fbb1a3 → c2922e7 → 4c7f7bb → ab7d49a`，全部快进，作者和提交者都是 GitHub noreply，没有 merge 或强推。
- **元数据**：`name` `@bingjiang0611/rotom`、`version` `0.2.0`、`private: false`、`publishConfig.access` `public`、`registry` `https://registry.npmjs.org`、
  `license` `UNLICENSED`，与冻结记录的表格和发布说明一致。dist-tag `latest` 与 HANDOFF-6 记录的用户授权一致。
- **最终产物验收（冻结记录第 2–5 步）**：要求对实际最终 tgz 做摘要、审计、隔离安装、smoke、`check-personal`、升级与卸载；
  受管 Mac 硬门禁写清了只用用户已有的 Apple Development 身份、只装到隔离 HOME、核对 app 和 socket 都隔离、读取真实 diagnostics 要求协议 11 且 PID 和可执行文件属于隔离副本、
  签名验证不能代替启动证据、被端点安全终止就停止发布且不绕过。审核者核对：helper 按路径启动（`open -n -g <path>`），隔离副本不会被日常会话按 bundle id 误启动。
- **用户前台发布边界（第 6–7 步）**：Agent 不执行 `npm login`、`npm whoami`、`npm publish`，不启动认证浏览器，不接触密码、OTP 或 token；
  命令由 `scripts/npm-release-handoff.mjs commands` 生成并逐段交接；提交成功或 npm 自动审核中都不算发布，不重复 publish；只有 registry 核验通过才记录和打 tag。
  这与根 `CLAUDE.md`“npm 正式发布顺序”一致。

## F1（必须修）：`publishConfig.tag` 让发行合同测试失败

`rotom/runtime/distribution.test.mjs` 第 46 行断言 `publishConfig` **恰好**是 `{ access, registry }`。`ab7d49a` 加了 `tag: "latest"`，这项测试在该提交上必然失败：

```
not ok 1 - distribution is public-scoped, owns its Pi fork, has no installation hooks and declares the public bin
  + tag: 'latest'
```

审核者在 `4c7f7bb` 上运行同一文件，这一项通过，所以是冻结提交引入的。（同一文件另有 2 项在审核容器里失败，原因是容器的 Node 是 22、产品要求 24 以上，
`4c7f7bb` 上同样失败，与本提交无关。）这说明推送冻结提交前没有跑产品测试。现在 `main` 上这项测试是红的。

**修法（推荐）**：删掉 `publishConfig.tag`。dist-tag 已经由交接命令 `npm publish … --tag latest` 显式给出，`npm-release-handoff.mjs` 的
`preflight`/`verify` 也按命令行的 tag 核对 registry；在 manifest 里再写一份没有额外好处，反而多一个要同步的地方。冻结记录表格里的 dist-tag 一行改为
“`latest`（由交接命令的 `--tag latest` 指定，`verify` 回读）”。

不推荐另一种做法（改测试接受 `tag`）：那要同时改 `distribution.test.mjs`、`npm-release-handoff.mjs` 的合同检查和它的测试，还要保证 manifest 的 tag 与命令行一致，改动面更大。

**流程**：

1. 在 `ab7d49a` 之上新增一个提交（不要 revert 加强推、不要改写历史），删除 `publishConfig.tag`，同步更新 `0.2.0-freeze.md` 的表格，并写明
   `ab7d49a` 因 F1 作废、新提交是唯一构建源。
2. **在最后一次改动之后**，在 Mac 上用 Node 24 跑 `rotom` 的产品测试（至少 `runtime/distribution.test.mjs` 全部、`scripts/npm-release-handoff.test.mjs`）、
   `git diff --check` 和当前文件树审计，报告这次的结果。
3. 快进推送到 `main`，报告新 SHA，等审核通过再打包。

## 建议（不阻断，可以在同一个新提交里顺手改）

- **隔离验收后的清理**：冻结记录第 4 步只写了“只关闭本次创建的实例”。建议补上：记录完证据后，删除本次创建的隔离 HOME（包括其中的隔离 helper 副本）；
  最终 tgz 保留到发布和 registry 核验完成。
- **签名身份在隔离 HOME 下可能找不到**：`codesign` 需要从用户的钥匙串里找到 Apple Development 身份。如果在隔离 HOME 下运行时报找不到身份，
  停下报告，由审核者和用户决定做法；不要复制钥匙串、不要改钥匙串搜索列表、不要导出私钥。
- **REVIEW-27 链接**：冻结记录和发布说明里的 REVIEW-27 链接指向候选分支上的 `4936306`，这个提交不在 `main` 里。发布完成前不要删除候选分支，
  否则链接可能失效。
