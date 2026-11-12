# Computer Use v2 L2 single-action check (2026-11-07T04:11:09.297Z)

Rows: 13 · Failures: 1

本次运行存档：`runs/2026-11-07T04-11-09-297Z-l2-check.md`

One directed click and one directed text input per target, delivered with `background` policy.
`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.

| Target | Action | Result | Note |
| --- | --- | --- | --- |
| gate | verdict | pass | minutes_left=42.4 hid_idle=630.7s helper_idle=630.7s |
| environment | input source | inconclusive | input method com.sogou.inputmethod.pinyin; ASCII text typing needs a plain layout |
| helper | diagnostics | pass | protocol=9 accessibility=true |
| environment | operator app | pass | Scry pid=60263 |
| environment | apps at startup | pass | 151 running; only processes started by this run may be operated |
| fixture | fresh copy | pass | bundle=com.example.cu-fixture.1794024659382 path=~/cu-v2-test/runs/2026-11-07T04-10-59-187Z/fixture-1794024659382/Fixture.app |
| fixture | present | pass | pid=81844 bundle=com.example.cu-fixture.1794024659382 |
| fixture | window | fail | no window in listRoots even after activating the fixture |
| L2 whitelist | app on the list | skipped | running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it |
| direct L2 | window | skipped | the fixture has no window; direct delivery needs one |
| helper | still alive | pass | the helper answered diagnostics after every probe (no crash) |
| cleanup | fixture copy | pass | quit=81844 removed=~/cu-v2-test/runs/2026-11-07T04-10-59-187Z/fixture-1794024659382 |
| cleanup | operator app restored | pass | Scry → Scry |

## Log

```
2026-11-07T04:10:59.295Z gate verdict pass minutes_left=42.4 hid_idle=630.7s helper_idle=630.7s
2026-11-07T04:10:59.323Z environment input source inconclusive input method com.sogou.inputmethod.pinyin; ASCII text typing needs a plain layout
2026-11-07T04:10:59.328Z helper diagnostics pass protocol=9 accessibility=true
2026-11-07T04:10:59.360Z environment operator app pass Scry pid=60263
2026-11-07T04:10:59.382Z environment apps at startup pass 151 running; only processes started by this run may be operated
2026-11-07T04:10:59.463Z fixture fresh copy pass bundle=com.example.cu-fixture.1794024659382 path=~/cu-v2-test/runs/2026-11-07T04-10-59-187Z/fixture-1794024659382/Fixture.app
2026-11-07T04:11:07.028Z fixture present pass pid=81844 bundle=com.example.cu-fixture.1794024659382
2026-11-07T04:11:08.872Z fixture window fail no window in listRoots even after activating the fixture
2026-11-07T04:11:08.922Z L2 whitelist app on the list skipped running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it
2026-11-07T04:11:08.925Z direct L2 window skipped the fixture has no window; direct delivery needs one
2026-11-07T04:11:08.931Z helper still alive pass the helper answered diagnostics after every probe (no crash)
2026-11-07T04:11:08.999Z cleanup fixture copy pass quit=81844 removed=~/cu-v2-test/runs/2026-11-07T04-10-59-187Z/fixture-1794024659382
2026-11-07T04:11:09.296Z cleanup operator app restored pass Scry → Scry
```
