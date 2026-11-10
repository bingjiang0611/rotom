# 回放：在隔离副本里重跑一次记录的失败

只在用户显式授权真实会话回放时执行；未授权就整块跳过。用法与边界都记在这里，节奏入口见 [Agent 优化循环](optimization-loop.md#⑦-回放可选需显式授权)。

`npm --prefix rotom/evals run loop -- replay --incident <sessionId:entryId> [--repeats N] [--frozen DIR] [--current DIR] [--model provider/model]`：把一次记录在案的失败在隔离副本里重放。只在用户显式授权真实会话回放时执行；未授权就整块跳过。

- **取会话分支**：从事件会话自己的 jsonl 里切到失败用户消息之前（保留 session header），写成临时 agent dir 里的 session 文件，产品以 `--session` 续跑；失败那条消息是唯一新增回合。
- **取时间点**：`git rev-list -1 --before=<会话开始时间> HEAD`。会话 cwd 不是 git 仓库、或该时刻没有可确定的 commit，就拒绝并换下一个事件，不硬凑。
- **隔离**：`git clone --shared --no-checkout` 到回放目录再 checkout 该 commit，然后删掉所有 remote（不用 `worktree add`，避免往别人的仓库里写 admin 元数据）；工具限定 `read/edit/bash`；子进程 HOME 指向临时目录，环境清掉 `*_TOKEN/*_KEY/*_SECRET/NPM_*/GH_*/GITHUB_*/AWS_*/SSH_AUTH_SOCK`，模型凭据只通过临时 agent dir 里的 auth 文件给 runtime；`BASH_ENV` 载入 shell shim，`git push`、`npm publish`、`gh`、`ssh/scp/rsync`、`curl/wget` 的写请求一律以 97 退出并在 transcript 里记为拒绝。
- **产物**：只写 `~/.rotom/loop/replay-<stamp>/`（0700 目录、0600 文件）：`plan.json`、每次运行的 `transcript.txt` / `session.jsonl` / home / 副本。用例本身**不入 Git**，也不进账本的 `source`；账本只写脱敏后的机制摘要。
- **评判**：优先确定性检查（例如“用户抱怨没跑测试” ⇒ 看那次运行里有没有跑测试命令）；没有确定性检查时，用同一模型盲评 A/B（随机顺序、只许 A/B/tie 加理由），盲评只作参考，不能单独构成入集理由。判定规则：冻结产品 5 次里失败 ≥3 次才算 `reproduced (replay)`。
- **边界**：一次回放是一次真实会话（本机实测单次约 4–5 分钟、2 千余次工具调用），不是单元测试；不要在验证或打包的同时批量跑。
