# Browser 能力补齐与多 agent 并行：执行手册

这个目录是交给**执行 agent** 的完整任务包。执行 agent 按这里的说明在 `browser-parallel` 分支上实现、自测和推送，**评审 agent** 再在同一分支上核验。

| 文件 | 用途 |
| - | - |
| [design.md](design.md) | 技术方案：现状、并行设计、能力补齐设计，以及已经确认的决定 |
| [tasks.md](tasks.md) | 任务拆分：每个任务改哪些文件、验收标准和自验证命令 |
| [STATUS.md](STATUS.md) | 执行 agent 维护的进度与证据，评审 agent 从这里开始核验 |

## 协作方式

1. **只在 `browser-parallel` 分支工作。** 不推 `main`，不开 PR，不发 npm，不打 tag。根 `CLAUDE.md` 里“完成后推 `origin/main`”这条默认规则，在这个任务里由用户明确改成了推这个分支。
2. **尽量一口气做完，少停下来问。** 设计里能拍板的地方都已经拍板（见 design.md 第 8 节）。遇到没写到的细节，按“更保守、更容易回滚、和现有合同一致”的原则自行决定，并把决定写进 `STATUS.md` 的“自行决定”一节，然后继续做。只有下面这些情况才停下：
   - 要改动根 `CLAUDE.md` 列出的不妥协项，例如未知写入重放、回退规则、隐私边界；
   - 需要操作用户真实的 Chrome profile、npm、发布流程或外部账号；
   - 某个里程碑的验收标准做不到，而且没有其他任务可以先做。
3. **每个任务一个 commit**，commit message 用 `browser(Txx): <做了什么>`。做完一个任务就 push 一次，方便评审方随时看进度。push 前先 `git fetch origin browser-parallel` 并 rebase，不要 force push。
4. **每个任务都要自验证。** 跑 tasks.md 里列的命令，把命令和结果摘要写进 `STATUS.md`。不能跑的检查要写明“未验证”和原因，不能用 L1 冒充 L2。
5. **先做 T0。** T0 是一个隔离的真实 Chromium 端到端测试架子，后面每个任务都靠它自测。它不碰用户自己的 Chrome，所以不违反“真实 Chrome L2/L3 需要用户明确要求”这条规则；用户已经要求执行 agent 自主验证。
6. **一个里程碑做完**（M1 到 M4），在 `STATUS.md` 的里程碑表里标 `ready-for-review`，然后**继续做下一个里程碑**，不用等评审。评审意见会以 commit 的形式追加到 `docs/agent/browser-parallel/REVIEW.md`，执行 agent 每次开始新任务前先 `git pull` 看一眼。

## 环境要求

- Node 24 或更高（产品要求，`rotom/package.json` 的 `engines`）。
- 运行 `index.test.ts` 和 runtime smoke 之前要有 Pi fork：在 `rotom/` 下执行 `npm run build:pi`，详见 `docs/agent/pi-fork.md`。
- 端到端测试需要 **Chromium 或 Chrome for Testing**。不能用正式版 Google Chrome：Chrome 137 起正式版忽略 `--load-extension`。
- Linux 上没有显示器时，用 `--headless=new`（MV3 扩展支持）或 `xvfb-run`。

已知的环境性失败：在 Linux 上，`chrome-extension.test.mjs` 里的 installer 测试（第 26 条）和 native host multiplex 测试（第 27 条）会失败，因为它们依赖 macOS 的路径（`/private/tmp`、`process.platform === "darwin"`）。T24 做完跨平台以后，这两条必须在 Linux 上也能通过。在那之前，把它们记为“既有环境失败”，不要算成你的回归。

## 评审方核验什么

- `STATUS.md` 里每个 done 的任务都有 commit 和验证证据；
- 重新跑一遍 tasks.md 里的命令，结果和 STATUS 里写的一致；
- 对照根 `CLAUDE.md` 第 6 节和 `docs/agent/change-checklists.md` 的 Browser 清单逐条核对；
- 读 diff，重点看：未知写入是否会被重放、新能力的输出是否有界、子 agent 是否会自动放行未授权的站点。

## 给执行 agent 的启动提示词

可以直接复制下面这段给执行 agent：

```text
在 bingjiang0611/rotom 仓库的 browser-parallel 分支上工作。先读 docs/agent/browser-parallel/README.md，然后按 tasks.md 从 T0 开始依次实现。每完成一个任务：跑完该任务列出的验证命令，更新 STATUS.md，提交一个 commit 并 push 到 browser-parallel。尽量连续完成多个任务和里程碑，中途不要停下来问我；只有 README 里“只有下面这些情况才停下”列出的情况才停。开始每个任务前先 git pull，看 REVIEW.md 里有没有新的评审意见。
```
