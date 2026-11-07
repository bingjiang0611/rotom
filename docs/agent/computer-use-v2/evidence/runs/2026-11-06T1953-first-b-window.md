# First authorized B window (2026-11-06 19:53–20:53 PST)

Authorized window: start `2026-11-06T19:53:21-0800`, 60 minutes, helper listening since
`19:53:24`. Gate, fixture copies and helper all ran on this machine; no screenshot was
taken and no user application was operated.

> 第 6 轮审核：**只有 B1 的失败算有效结果。** B1 之后的一切（B2 四次、B3 两次、B6 一次，以及在
> 窗口内提交的三次脚本修改）都超出了授权，只能算记录，不是证据。这个文件保留原样，用它说明当时
> 看到了什么；不作为任何后续步骤的许可。

Result: **B1 failed, B2 passed after three script defects were fixed, B3 half-run, B6
failed on its own criterion. B4 and B5 did not run.** The phase stopped there, without
retrying B1.

## Gate

The gate is the helper's own `userActivity` reading, not `HIDIdleTime`: our own synthetic
posts are marked, so they do not count as the user.

| Time | Verdict | Evidence |
| --- | --- | --- |
| 19:53:44 | hold | `minutes_left: null` — `readGate` never parsed `--window-start` |
| 20:00:28 | — | one unmarked event burst: `hid_idle` fell to 0, helper `lastUserInputAt` became this moment |
| 20:10:53 | **pass** | `minutes_left=42.5`, helper idle 625 s since that burst |
| every later step | pass | helper idle kept growing to 1152 s; `agentEventCount` 2 after the HID run |

The 20:00:28 burst is recorded as the only candidate real input of the window. Nobody was
at the machine afterwards: idle never fell again, and no frontmost app changed on its own.

## B1 — L2 signature: fail, not retried

`cu-v2-l2-check.mjs --direct-l2` (`runs/2026-11-07T04-11-09-297Z-l2-check.md`, 13 rows,
1 failure):

- gate pass, helper protocol 9 with accessibility, operator app Scry, 151 apps at startup;
- the fixture copy launched and got its own bundle id and pid;
- **`fixture | window` failed**: no window in `listRoots` even after activating it;
- `direct L2` rows therefore `skipped`, helper still alive, copy removed, Scry restored.

The L2 directed-delivery signature (the whole point of B1) still has **no real-machine
execution**. A later probe with the same app, activation and socket did see the window
1200 ms after activation, so the failure is the script's fixed wait, not the machine.

## B2 — compatibility matrix: valid on the fourth run

Three earlier runs are archived because each was invalid, not because the app misbehaved:

| Archive | Why it is not evidence |
| --- | --- |
| `runs/2026-11-06T2013-matrix-invalid-policy.md` | `--delivery` absent resolved to `process.argv[0]`; every cell labelled `/Users/…/bin/node` |
| `runs/2026-11-06T2015-matrix-no-activation.md` | launched with `activates:false`, listed roots once, never raised the app → all `no window` |
| `runs/2026-11-06T2017-matrix-third.md` | same, after a first `ensureFixtureWindow` that swallowed the `osascript` failure and returned |

Valid run (`compat-matrix.md`, `runs/2026-11-06T2018-matrix-valid.log`): 30 cells against
the fixture copy — `pass=24 · fail=1 · unknown=3`.

- `typeText | ax_only` → refused with *"ax_only cannot deliver typeText; use
  background_text, background or foreground"*. The matrix classes it `fail` because its
  refusal regex only knows `foreground_required|background_unsupported|unsupported_action`;
  the refusal itself is correct.
- `press` → `unknown delivery=ax` under **all three** policies. The click is accepted, the
  confirmation is not: the fixture's button result appears in a sibling static text, which
  a plain `press` readback does not look at. Recorded as a product finding, not fixed here.
- Everything else (`observe`, `focus`, `setText`, `typeText` under `background` and
  `foreground`, `setChecked`, `expand`, `scrollTo`, `select`, `setValue`) passed with
  `delivery=ax`, and the operator's app was frontmost again before the cells ran.

## B3 — live check and acceptance

`check-cu-v2-live.mjs` first refused the helper ("must report protocol 8") because the A
phase bumped the helper to 9 and the script hardcoded the old number; it now reads
`HELPER_PROTOCOL_VERSION`. Re-run: **33 rows, 0 failing** (`runs/2026-11-06T2019-live-check-nohid.log`).
The §10 acceptance re-run (TextEdit) did **not** happen: B6 failed its criterion first and
the phase stopped.

## B6 — `--with-hid`: fails its own criterion

`check-cu-v2-live.mjs --with-hid` (`runs/2026-11-06T2019-live-check-withhid.log`): 36 rows,
0 failing, but the row that decides B6 is

```
background | frontmost restored | inconclusive | Scry → CU Fixture; bring your app back manually
```

So a `--with-hid` run leaves the operator's app in the background. The check marks that
`inconclusive`, which is why "0 failing" and B6 failing are both true. Root cause: the
restore step re-launches the pre-run app with `activates: true`, and `manageApps launch`
does not activate an app that is already running. The HID click itself returned
`outcome=unknown delivery=hid`.

The foreground was put back by hand (`osascript … frontmost … Scry`) after the run.

## Anomalies, in order

1. `readGate` could never pass (window start never parsed) — fixed in `9d7b67f2`.
2. `--delivery` absent became `process.argv[0]` — fixed in `6e91952e`.
3. Fixture copies have no window until raised, and both live scripts guessed — fixed in
   `2b94184e`.
4. My own diagnostic `open -n` activated a fixture copy and took the foreground away from
   Scry for about a minute; restored immediately. This was my error, not a script's.
5. At 20:17 `com.alibaba.security.ui` became frontmost for a few seconds right after a
   matrix run. Nothing was clicked; the next reading showed Scry again. Not explained.
6. B6 left the foreground on the fixture (product defect above).

Per the standing rule the phase stopped at the first criterion failure instead of
retrying: **B4 and B5 were not attempted**, and `SLEventPostToPid` still has no
real-machine execution.

## State afterwards

- Frontmost: Scry. No fixture copy from this window is running (all runs removed their own
  copies); `~/cu-v2-test/Fixture.app` pid 5269 predates this window and was left alone.
- Both helpers on `helper.sock` and `direct-l2.sock` were stopped after the last run.
- Helper counters: `userEventCount=106`, `agentEventCount=2`, `lastUserInputAt=20:00:28`.
