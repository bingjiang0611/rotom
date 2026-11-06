# Computer Use v2 L2 single-action check (2026-11-06T12:51:02.510Z)

Rows: 5 · Failures: 1

本次运行存档：`runs/2026-11-06T12-51-02-510Z-l2-check.md`

One directed click and one directed text input per target, delivered with `background` policy.
`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.

| Target | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=9 accessibility=true |
| environment | operator app | pass | Scry pid=45089 |
| environment | apps at startup | pass | 182 running; only processes started by this run may be operated |
| fixture | fresh copy | pass | bundle=com.example.cu-fixture.1793969462369 path=~/cu-v2-test/runs/2026-11-06T12-51-02-202Z/fixture-1793969462369/Fixture.app |
| run | abort | fail | Command failed: open -n ~/cu-v2-test/runs/2026-11-06T12-51-02-202Z/fixture-1793969462369/Fixture.app
_LSOpenURLsWithCompletionHandler() failed with error -10825.
 |

## Log

```
2026-11-06T12:51:02.272Z helper diagnostics pass protocol=9 accessibility=true
2026-11-06T12:51:02.308Z environment operator app pass Scry pid=45089
2026-11-06T12:51:02.369Z environment apps at startup pass 182 running; only processes started by this run may be operated
2026-11-06T12:51:02.417Z fixture fresh copy pass bundle=com.example.cu-fixture.1793969462369 path=~/cu-v2-test/runs/2026-11-06T12-51-02-202Z/fixture-1793969462369/Fixture.app
2026-11-06T12:51:02.509Z run abort fail Command failed: open -n ~/cu-v2-test/runs/2026-11-06T12-51-02-202Z/fixture-1793969462369/Fixture.app
_LSOpenURLsWithCompletionHandler() failed with error -10825.

```
