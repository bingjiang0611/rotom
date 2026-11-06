# Computer Use v2 L2 single-action check (2026-11-06T14:35:41.059Z)

Rows: 15 · Failures: 0

本次运行存档：`runs/2026-11-06T14-35-41-059Z-l2-check.md`

One directed click and one directed text input per target, delivered with `background` policy.
`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.

| Target | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=9 accessibility=true |
| environment | operator app | pass | Scry pid=45089 |
| environment | apps at startup | pass | 180 running; only processes started by this run may be operated |
| fixture | fresh copy | pass | bundle=com.example.cu-fixture.1793975730028 path=~/cu-v2-test/runs/2026-11-06T14-35-29-905Z/fixture-1793975730028/Fixture.app |
| fixture | present | pass | pid=96637 bundle=com.example.cu-fixture.1793975730028 |
| fixture | controls | pass | text=e10 button=e11 |
| fixture (not on the L2 list) | click | inconclusive | outcome=unknown delivery=ax cursorMoved=false frontmostChanged=false 467ms |
| fixture (not on the L2 list) | typeText | pass | outcome=worked delivery=ax cursorMoved=false frontmostChanged=false 475ms |
| fixture (not on the L2 list) | input received | pass | field="l2probe" expected="l2probe" outcome=worked |
| L2 whitelist | app on the list | skipped | running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it |
| direct L2 | click | inconclusive | outcome=unknown delivery=ax helperAlive=true cursorMoved=false bundle=com.example.cu-fixture.1793975730028 |
| direct L2 | typeText | pass | outcome=worked delivery=ax helperAlive=true cursorMoved=false bundle=com.example.cu-fixture.1793975730028 |
| helper | still alive | pass | the helper answered diagnostics after every probe (no crash) |
| cleanup | fixture copy | pass | quit=96637 removed=~/cu-v2-test/runs/2026-11-06T14-35-29-905Z/fixture-1793975730028 |
| cleanup | operator app restored | pass | Scry → Scry |

## Log

```
2026-11-06T14:35:29.969Z helper diagnostics pass protocol=9 accessibility=true
2026-11-06T14:35:29.993Z environment operator app pass Scry pid=45089
2026-11-06T14:35:30.028Z environment apps at startup pass 180 running; only processes started by this run may be operated
2026-11-06T14:35:30.113Z fixture fresh copy pass bundle=com.example.cu-fixture.1793975730028 path=~/cu-v2-test/runs/2026-11-06T14-35-29-905Z/fixture-1793975730028/Fixture.app
2026-11-06T14:35:37.673Z fixture present pass pid=96637 bundle=com.example.cu-fixture.1793975730028
2026-11-06T14:35:37.774Z fixture controls pass text=e10 button=e11
2026-11-06T14:35:38.249Z fixture (not on the L2 list) click inconclusive outcome=unknown delivery=ax cursorMoved=false frontmostChanged=false 467ms
2026-11-06T14:35:39.232Z fixture (not on the L2 list) typeText pass outcome=worked delivery=ax cursorMoved=false frontmostChanged=false 475ms
2026-11-06T14:35:39.290Z fixture (not on the L2 list) input received pass field="l2probe" expected="l2probe" outcome=worked
2026-11-06T14:35:39.323Z L2 whitelist app on the list skipped running: IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it
2026-11-06T14:35:39.835Z direct L2 click inconclusive outcome=unknown delivery=ax helperAlive=true cursorMoved=false bundle=com.example.cu-fixture.1793975730028
2026-11-06T14:35:40.370Z direct L2 typeText pass outcome=worked delivery=ax helperAlive=true cursorMoved=false bundle=com.example.cu-fixture.1793975730028
2026-11-06T14:35:40.375Z helper still alive pass the helper answered diagnostics after every probe (no crash)
2026-11-06T14:35:40.465Z cleanup fixture copy pass quit=96637 removed=~/cu-v2-test/runs/2026-11-06T14-35-29-905Z/fixture-1793975730028
2026-11-06T14:35:41.059Z cleanup operator app restored pass Scry → Scry
```
