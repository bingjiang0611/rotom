# Computer Use v2 compatibility matrix (2026-11-07T04:15:56.284Z)

Cells: 12 · prepared=1 · not-run=10 · removed=1

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| /Users/baobingjiang/cu-v2-test/Fixture.app | fixture copy | - | prepared | com.example.cu-fixture.1794024949093 at /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | observe | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | focus | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | setText | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | typeText | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | press | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | setChecked | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | expand | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | scrollTo | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | select | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-15-49-093Z/fixture-1794024949093/Fixture.app | setValue | - | not-run | no window |
| Fixture.app | fixture cleanup | - | removed | quit=95006 |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
