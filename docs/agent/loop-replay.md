# 回放：在隔离副本里重跑一次记录的失败

只在用户显式授权真实会话回放时执行；未授权就整块跳过。用法与边界都记在这里，节奏入口见 [Agent 优化循环](optimization-loop.md#⑦-回放可选需显式授权)。

`npm --prefix rotom/evals run loop -- replay --incident <sessionId:entryId> [--repeats N] [--frozen DIR] [--current DIR] [--model provider/model] [--check COMMAND] [--origin-check [--origin-only]]`：把一次记录在案的失败在隔离副本里重放。只在用户显式授权真实会话回放时执行；未授权就整块跳过。

- **取会话分支**：从事件会话自己的 jsonl 里切到失败用户消息之前（保留 session header），写成临时 agent dir 里的 session 文件，产品以 `--session` 续跑；失败那条消息是唯一新增回合。
- **取时间点**：`git rev-list -1 --before=<会话开始时间> HEAD`。会话 cwd 不是 git 仓库、或该时刻没有可确定的 commit，就拒绝并换下一个事件，不硬凑。
- **隔离**：`git clone --shared --no-checkout` 到回放目录再 checkout 该 commit，然后删掉所有 remote（不用 `worktree add`，避免往别人的仓库里写 admin 元数据）；工具限定 `read/edit/bash`；子进程 HOME 指向临时目录，环境清掉 `*_TOKEN/*_KEY/*_SECRET/NPM_*/GH_*/GITHUB_*/AWS_*/SSH_AUTH_SOCK`，模型凭据只通过临时 agent dir 里的 auth 文件给 runtime；`BASH_ENV` 载入 shell shim，`git push`、`npm publish`、`gh`、`ssh/scp/rsync`、`curl/wget` 的写请求一律以 97 退出并在 transcript 里记为拒绝。
- **产物**：只写 `~/.rotom/loop/replay-<stamp>/`（0700 目录、0600 文件）：`plan.json`、每次运行的 `transcript.txt` / `session.jsonl` / home / 副本。用例本身**不入 Git**，也不进账本的 `source`；账本只写脱敏后的机制摘要。
- **先判原轨迹（零成本门）**：`--origin-check` 在花掉任何模型调用之前，用同一个 `--check` 判**原来那一轮**：窗口取失败用户消息之前的那次回答（含它的工具调用），`REPLAY_SESSION` 指向原会话、`REPLAY_CUT` 指向事件消息、`VIEW_MODE=before`。检查通过说明这条事件本来就没失败——记为“原轨迹未失败”，跳过重放，并计入 harvest 检测器的假阳性；检查跑不通（需要原始工作树、产物已经不在）才把事件留在队列里。`--origin-only` 判完就退出，用它在挑事件时筛掉假阳性。窗口的已知限制：一次运行被 `ask_user_question` 的答复打断时，窗口从那条答复之后开始，因此看不到更早的工具调用。
- **评判**：优先确定性检查，且先写好检查再跑正式批次。`--check COMMAND` 在每次运行结束后、在同一个副本里、用同一份 scrubbed 环境（含 `BASH_ENV` shim）执行：退出 0 = 达标，1 = 用户报的问题仍在，其它 = 检查本身没跑通（不计入任何一侧）。检查能读 `REPLAY_TRANSCRIPT`（该次运行的输出）和 `REPLAY_WORKSPACE`（副本路径），这两个变量不传给 Agent。没有确定性检查时才用同一模型盲评 A/B（随机顺序、只许 A/B/tie 加理由），盲评只作参考，不能单独构成入集理由。判定规则：冻结产品 5 次里失败 ≥3 次才是 `reproduced (replay)`；达标 5 次里 ≥3 次是 `not-reproduced`；unknown 让两侧都不到阈值时保持 `unknown`，不当成通过。
- **统计口径**：工具调用数和 usage 只算**新回合**——重放会话带着整条分支历史，按全文件统计会把历史算成这次的工作。边界优先取切口的 entryId；重放有时会用新 id 重新写出整条分支，那时以失败消息原文的最后一次出现为界（两者取更靠后者），只有边界之后的 assistant 消息计入（`newTurnStats`），usage 按消息上的 `input/output/cacheRead/cacheWrite/totalTokens` 分开加总。`--check` 读同一份会话时用同一规则（`REPLAY_CUT_TEXT`）。
- **冻结产品**：优先用事件当时那个发行版。本机已经没有它时，若版本号带 commit（如 `0.1.27-main.0d90623`），就在临时 worktree 检出该 commit 跑 `pack:release` 重建并装到临时 prefix，`--frozen` 指向装好的包；只是发布标签、没有对应 commit 的版本（如 `0.1.27`）无法重建，退回 `0.1.27-main.50ccdc87` 并在账本里注明——冻结产品比会话实际跑的更新时，“没复现”只说明今天不再复现。
- **边界**：一次回放是一次真实会话（本机实测单条分支短时约 30 秒、长分支数分钟），不是单元测试；不要在验证或打包的同时批量跑。
