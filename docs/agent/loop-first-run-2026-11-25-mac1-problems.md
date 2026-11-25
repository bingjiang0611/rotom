# 评测循环首次运行的问题与处理 · mac1（2026-11-25）

本文件是 [loop-first-run-2026-11-25-mac1.md](loop-first-run-2026-11-25-mac1.md) 的运行记录里“问题与处理”那一节的全文，单列是为了让那份记录只留数字。只写本轮实际碰到的东西：报错原文（脱敏后）、我做了什么、以及刻意没做什么。

### 1. 默认 Node 是 v22，产品要求 >=24

`node -v` 是 `v22.23.1`，而 `rotom/package.json` 的 `engines` 是 `>=24.0.0`。

- 做了：每条命令都在 `PATH` 前插 `~/.nvm/versions/node/v24.18.0/bin`，所以实际跑的是 v24.18.0 / npm 12.2.0。
- 没做：没改全局 node、没动 nvm alias、没在 v22 下试跑，所以“v22 下会怎么坏”本轮没有证据。

### 2. `gate.json` 里的 openai-codex 覆盖与“只用 dfmodel”冲突

`behavior-mixed-decision-ownership` 自带 `model: {provider: openai-codex, model: gpt-6.1-sol}`，而本次任务的边界是只用 `qoder/dfmodel`；`rotom/evals/src/loop/gate.ts` 的注释又写着 “the loop is authorized to run both”。两者当时不一致。

- 做了：先停下问用户；用户把 origin/main 改成 `919ad0dc`（全部用例回到 dfmodel）后，`git reset --hard origin/main`、确认 `919ad0d` 是祖先，从 smoke 继续；已完成的 status / weekly / freeze 未重跑。
- 没做：没改 `gate.json`、没删这一例、没传 `--model`、没调用任何 openai-codex 模型。

### 3. HTTPS 推送失败

```
fatal: remote helper 'https' aborted session
```

- 做了：按本机 `~/.config/agent-config/local.md` 里已验证的 SSH wrapper（`ssh://git@ssh.github.com:443/…` + 本机专用 key）重试：先 fetch、再 `--dry-run`、再真推。
- 更正一处自己弄错的读数：第一次那条 `git push --dry-run … | tail` 后面打印的 `EXIT=0` 是管道尾部的退出码，不是 git 的；那次推送实际是失败的。之后的推送不再用管道吞掉退出码。
- 没做：没改 remote 配置、没换身份、没用 `--force`。

### 4. pre-push 审计拦下了第一次真推

```
fatal: Invalid revision range 74c52ed6..8dbadffb
audit did not complete: ValueError
Range: 74c52ed6..8dbadffb
error: failed to push some refs to 'ssh://…/rotom.git'
```

原因是远端 `eval/loop-first-run-20261125` 已经存在（`74c52ed6`），本地没有这个对象，审计按 `remoteSha..localSha` 算范围时解析失败。这不是审计本身的误拦，是本地缺旧对象。

- 做了：fetch 该分支 → 发现同一任务的另一份记录（另一台机器，macOS 27.0 build 26A428，77 会话/463 轮，holdout 2/3 vs 2/3 regressed）→ 问用户怎么放 → 按选择 `reset --hard 74c52ed6`、本机结果另存为本文件、快进推送成功（`74c52ed6..85dcc597`）。
- 没做：没用 `--no-verify`、没强推、没 rebase 或合并那台机器的提交、没删它的记录。

### 5. mac2 / mac3 的 SSH 身份被拒

```
Permission denied (publickey,password,keyboard-interactive)
```

- 做了：各一次只读探测，失败即停。
- 没做：没继续排查跨机身份/密钥，因此也没能确认 `74c52ed6` 具体来自哪台机器；文档里只写另一台机器的 macOS 版本，不指名。

### 6. `gate` / `gate-pool` 退出码 1 是判定码

不是崩溃。读了 `rotom/evals/src/loop/gate-commands.ts` 确认 `held=0 / regressed=1 / unknown=2`，所以把这步记为“跑完、判定 regressed”。

- 没做：没为了拿到退出 0 重跑、没改判定、没删样本。

### 7. 日志里的 ✓ 和分数不一致

爬坡用例 baseline repetition 3 的 score 是 0，但 vitest 里仍是 ✓、`thresholdFailed=false`。这条 suite 的 baseline 臂不因低分让断言失败，所以失败数只能从记录的 score 读。详细数字在“三项读数 c”。

唯一一条无关警报：冻结基线装依赖时出现 `npm warn deprecated node-domexception@1.0.0`。本轮没有处理它，也没有换依赖版本。
