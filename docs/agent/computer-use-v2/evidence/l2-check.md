# Computer Use v2 L2 single-action check (2026-11-04T15:19:16.036Z)

Rows: 7 · Failures: 1

One directed click and one directed text input per target, delivered with `background` policy.
`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.

| Target | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=8 accessibility=true |
| environment | operator app | pass | Scry pid=72651 |
| fixture | present | pass | pid=50219 bundle=com.example.cu-fixture |
| fixture | window | fail | no window in listRoots even after activating the fixture |
| L2 whitelist | app on the list | skipped | running: IntelliJ IDEA, IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it |
| helper | still alive | pass | the helper answered diagnostics after every probe (no crash) |
| cleanup | operator app restored | inconclusive | Scry → CU Fixture |

## Log

```
2026-11-04T15:19:14.129Z helper diagnostics pass protocol=8 accessibility=true
2026-11-04T15:19:14.136Z environment operator app pass Scry pid=72651
2026-11-04T15:19:14.168Z fixture present pass pid=50219 bundle=com.example.cu-fixture
2026-11-04T15:19:15.639Z fixture window fail no window in listRoots even after activating the fixture
2026-11-04T15:19:15.721Z L2 whitelist app on the list skipped running: IntelliJ IDEA, IntelliJ IDEA; pass --allow-l2-app <bundleId> to type into it
2026-11-04T15:19:15.733Z helper still alive pass the helper answered diagnostics after every probe (no crash)
2026-11-04T15:19:16.035Z cleanup operator app restored inconclusive Scry → CU Fixture
```
