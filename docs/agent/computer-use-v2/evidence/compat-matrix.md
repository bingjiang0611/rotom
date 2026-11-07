# Computer Use v2 compatibility matrix (2026-11-07T04:13:50.791Z)

Cells: 12 · prepared=1 · pass=9 · unknown=1 · removed=1

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| /Users/baobingjiang/cu-v2-test/Fixture.app | fixture copy | - | prepared | com.example.cu-fixture.1794024822203 at /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | observe | - | pass | 38 nodes, image |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | focus | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setText | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | typeText | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | press | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | unknown | outcome=unknown delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setChecked | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | expand | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | scrollTo | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | select | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| /Users/baobingjiang/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setValue | /Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| Fixture.app | fixture cleanup | - | removed | quit=91844 |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
