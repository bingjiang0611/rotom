# Computer Use v2 compatibility matrix (2026-11-07T04:17:07.039Z)

Cells: 12 · prepared=1 · not-run=10 · removed=1

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| /Users/baobingjiang/cu-v2-test/Fixture.app | fixture copy | - | prepared | com.example.cu-fixture.1794025013506 at /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | observe | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | focus | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | setText | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | typeText | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | press | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | setChecked | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | expand | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | scrollTo | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | select | - | not-run | no window |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-16-53-506Z/fixture-1794025013506/Fixture.app | setValue | - | not-run | no window |
| Fixture.app | fixture cleanup | - | removed | quit=none |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
