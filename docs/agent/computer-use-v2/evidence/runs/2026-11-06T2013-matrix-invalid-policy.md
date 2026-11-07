# Computer Use v2 compatibility matrix (2026-11-07T04:13:50.791Z)

Cells: 12 · prepared=1 · pass=9 · unknown=1 · removed=1

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| ~/cu-v2-test/Fixture.app | fixture copy | - | prepared | com.example.cu-fixture.1794024822203 at ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | observe | - | pass | 38 nodes, image |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | focus | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setText | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | typeText | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | press | ~/.nvm/versions/node/v24.18.0/bin/node | unknown | outcome=unknown delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setChecked | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | expand | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | scrollTo | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | select | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| ~/cu-v2-test/runs/2026-11-07T04-13-42-203Z/fixture-1794024822203/Fixture.app | setValue | ~/.nvm/versions/node/v24.18.0/bin/node | pass | outcome=worked delivery=ax |
| Fixture.app | fixture cleanup | - | removed | quit=91844 |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
