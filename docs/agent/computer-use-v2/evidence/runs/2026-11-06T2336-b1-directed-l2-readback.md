# 窗口记录：第四次 B 窗口，B1（2026-11-06 22:55–00:55，`f60cb0e7`）

> 脚本原样输出（`--runs-dir` 在仓库之外），只把家目录写成 `~`。判读：**B1 失败，阶段已停止**。
> 两条 blocker 都是可定位的缺陷，不是环境噪声：
>
> 1. `direct L2 | click effect` 的读回顺序错了——脚本先用 AX 路径点了同一个按钮（第 10 行，
>    `inconclusive` 但实际生效），所以定向点击前 fixture 的结果行**已经是 `clicked`**，定向点击
>    再成功也读不出变化。修法：`--direct-l2` 先跑，或改成可翻转的控件/计数。
> 2. `run | real user input` 仍是 `0 → +72`，用户已确认离开机器，前台没有变化。72 个未标记事件
>    发生在本次运行内部，来源未定位（可能是启动 fixture 副本或某条投递路径没有打标记）。
>    这说明 K2 这一行目前无法区分“人回来了”和“我们自己的动作”，需要按事件来源归因。

# Computer Use v2 L2 single-action check (2026-11-07T07:36:22.720Z)

Rows: 20 · Failures: 2

Step: B1
Commit: f60cb0e7d56870dd15c30c04383a38d22527f896
Verdict: fail
Blockers: 4

本次运行存档：`2026-11-07T07-36-22-719Z-l2-check.md`

One directed click and one directed text input per target, delivered with `background` policy.
`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.

| Area | Action | Result | Note |
| --- | --- | --- | --- |
| run | frozen commit | pass | f60cb0e7d56870dd15c30c04383a38d22527f896 step=B1 |
| gate | verdict | pass | minutes_left=78.8 hid_idle=636s helper_idle=-s |
| environment | input source | inconclusive | input method com.sogou.inputmethod.pinyin; ASCII text typing needs a plain layout |
| helper | diagnostics | pass | protocol=9 accessibility=true |
| environment | operator app | pass | Scry pid=60263 |
| environment | apps at startup | pass | 161 running; only processes started by this run may be operated |
| fixture | fresh copy | pass | bundle=com.example.cu-fixture.1794036971394 path=~/cu-v2-test/runs/2026-11-07T07-36-10-565Z/fixture-1794036971394/Fixture.app |
| fixture | present | pass | pid=39034 bundle=com.example.cu-fixture.1794036971394 |
| fixture | controls | pass | text=e10 button=e11 |
| fixture (not on the L2 list) | click | inconclusive | outcome=unknown delivery=ax cursorMoved=false frontmostChanged=false 515ms |
| fixture (not on the L2 list) | typeText | pass | outcome=worked delivery=ax cursorMoved=false frontmostChanged=false 474ms |
| fixture (not on the L2 list) | input received | pass | field="l2probe" expected="l2probe" outcome=worked |
| L2 whitelist | app on the list | skipped | running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it |
| direct L2 | click | inconclusive | outcome=unknown delivery=l2 helperAlive=true cursorMoved=false judgedBy=unknown and no readback change bundle=com.example.cu-fixture.1794036971394 |
| direct L2 | click effect | fail | before={"value":"clicked","label":null,"title":"","description":""} after={"value":"clicked","label":null,"title":"","description":""} outcome=unknown |
| direct L2 | typeText | skipped | input method selected: pinned transport uses key events, so ASCII text would be rewritten |
| helper | still alive | pass | the helper answered diagnostics after every probe (no crash) |
| cleanup | fixture copy | pass | quit=39034 removed=~/cu-v2-test/runs/2026-11-07T07-36-10-565Z/fixture-1794036971394 |
| restore | operator app | pass | Scry (60263) → Scry (60263) focused=true alreadyFocused=true reason=- lease=unverified (no broker: the helper enforces no token, so this write is unverified) |
| run | real user input | fail | userEvents 0 → 72 (+72); frontmost=Scry pid=60263 |

## Blockers

- direct L2 | click effect = fail (before={"value":"clicked","label":null,"title":"","description":""} after={"value":"clicked","label":null,"title":"","description":""} outcome=unknown)
- run | real user input = fail (userEvents 0 → 72 (+72); frontmost=Scry pid=60263)
- required row not passing: direct L2 | click = inconclusive
- required row not passing: run | real user input = fail

## Log

```
2026-11-07T07:36:11.069Z run frozen commit pass f60cb0e7d56870dd15c30c04383a38d22527f896 step=B1
2026-11-07T07:36:11.178Z gate verdict pass minutes_left=78.8 hid_idle=636s helper_idle=-s
2026-11-07T07:36:11.257Z environment input source inconclusive input method com.sogou.inputmethod.pinyin; ASCII text typing needs a plain layout
2026-11-07T07:36:11.263Z helper diagnostics pass protocol=9 accessibility=true
2026-11-07T07:36:11.307Z environment operator app pass Scry pid=60263
2026-11-07T07:36:11.394Z environment apps at startup pass 161 running; only processes started by this run may be operated
2026-11-07T07:36:11.548Z fixture fresh copy pass bundle=com.example.cu-fixture.1794036971394 path=~/cu-v2-test/runs/2026-11-07T07-36-10-565Z/fixture-1794036971394/Fixture.app
2026-11-07T07:36:18.107Z fixture present pass pid=39034 bundle=com.example.cu-fixture.1794036971394
2026-11-07T07:36:20.363Z fixture controls pass text=e10 button=e11
2026-11-07T07:36:20.884Z fixture (not on the L2 list) click inconclusive outcome=unknown delivery=ax cursorMoved=false frontmostChanged=false 515ms
2026-11-07T07:36:21.865Z fixture (not on the L2 list) typeText pass outcome=worked delivery=ax cursorMoved=false frontmostChanged=false 474ms
2026-11-07T07:36:21.925Z fixture (not on the L2 list) input received pass field="l2probe" expected="l2probe" outcome=worked
2026-11-07T07:36:21.956Z L2 whitelist app on the list skipped running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it
2026-11-07T07:36:22.575Z direct L2 click inconclusive outcome=unknown delivery=l2 helperAlive=true cursorMoved=false judgedBy=unknown and no readback change bundle=com.example.cu-fixture.1794036971394
2026-11-07T07:36:22.575Z direct L2 click effect fail before={"value":"clicked","label":null,"title":"","description":""} after={"value":"clicked","label":null,"title":"","description":""} outcome=unknown
2026-11-07T07:36:22.613Z direct L2 typeText skipped input method selected: pinned transport uses key events, so ASCII text would be rewritten
2026-11-07T07:36:22.620Z helper still alive pass the helper answered diagnostics after every probe (no crash)
2026-11-07T07:36:22.702Z cleanup fixture copy pass quit=39034 removed=~/cu-v2-test/runs/2026-11-07T07-36-10-565Z/fixture-1794036971394
2026-11-07T07:36:22.714Z restore operator app pass Scry (60263) → Scry (60263) focused=true alreadyFocused=true reason=- lease=unverified (no broker: the helper enforces no token, so this write is unverified)
2026-11-07T07:36:22.719Z run real user input fail userEvents 0 → 72 (+72); frontmost=Scry pid=60263
```
