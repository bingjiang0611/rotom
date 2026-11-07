# Computer Use v2 compatibility matrix (2026-11-07T04:18:44.602Z)

Cells: 30 · prepared=1 · pass=24 · fail=1 · unknown=3 · removed=1

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| ~/cu-v2-test/Fixture.app | fixture copy | - | prepared | com.example.cu-fixture.1794025104289 at ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | observe | - | pass | 38 nodes, image |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | focus | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setText | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | typeText | ax_only | fail | ax_only cannot deliver typeText; use background_text, background or foreground |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | press | ax_only | unknown | outcome=unknown delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setChecked | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | expand | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | scrollTo | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | select | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setValue | ax_only | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | focus | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setText | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | typeText | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | press | background | unknown | outcome=unknown delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setChecked | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | expand | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | scrollTo | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | select | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setValue | background | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | focus | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setText | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | typeText | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | press | foreground | unknown | outcome=unknown delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setChecked | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | expand | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | scrollTo | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | select | foreground | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-18-24-289Z/fixture-1794025104289/Fixture.app | setValue | foreground | pass | outcome=worked delivery=ax |
| Fixture.app | fixture cleanup | - | removed | quit=4682 |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
