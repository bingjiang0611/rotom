# Computer Use v2 compatibility matrix (2026-11-04T12:49:53.244Z)

Cells: 10 · not-run=10

| App | Action | Delivery policy | Result | Note |
| --- | --- | --- | --- | --- |
| com.example.cu-fixture | observe | - | not-run | no window |
| com.example.cu-fixture | focus | - | not-run | no window |
| com.example.cu-fixture | setText | - | not-run | no window |
| com.example.cu-fixture | typeText | - | not-run | no window |
| com.example.cu-fixture | press | - | not-run | no window |
| com.example.cu-fixture | setChecked | - | not-run | no window |
| com.example.cu-fixture | expand | - | not-run | no window |
| com.example.cu-fixture | scrollTo | - | not-run | no window |
| com.example.cu-fixture | select | - | not-run | no window |
| com.example.cu-fixture | setValue | - | not-run | no window |

`not-run` cells mean the app never exposed a window during this run; they are not evidence either way.

`l2-compat.ts` may only grow an app after every action it needs shows `pass` under the `background` policy.
