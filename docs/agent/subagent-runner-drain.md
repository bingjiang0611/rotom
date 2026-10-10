# Runner fault drain · rotom 0.1.17

## Fix and boundary

`pi-subagents@0.52.1-rotom.6` adds process-local fault drain for freshly spawned Pi writers. A catchable runner `SIGTERM` follows interrupt/close observation rather than immediately exiting. Interrupt escalation uses the existing controlled process-group controller. A coordinator exception stops and waits for those live handles before sealing admission and publishing business failure. Only the original close/group/lease observers may persist closure evidence; setup failures without those observers remain unknown.

A paused runner may release its execution-capacity slot only with the same identity- and reservation-bound observed closure required of failed/completed runners. Paused status alone, missing/unknown proof, wrong lease, controller loss and escaped stdio still retain occupancy/recovery fences.

This cannot reconstruct a historical runner's missing close evidence. `SIGKILL`, opaque writer leases, unverified descendants and external effects do not authorize another writer. No old run/store/lease was removed or replayed.

## Verified locally

- Unit: 50/50; strict/noEmit: 212 TS files.
- Public SDK with real child processes and local faux inference: 5/5, including SIGTERM drain, injected coordinator fault, native resume, lost controller, stop/timeout and pipe escapes. The two new drain scenarios also passed against the actual installed Pi fork `1.0.4-rotom.2`.
- Product check-personal: 314/314 core plus 87/87 Goal, footprint gate PASS.
- Archive/distribution/runtime contracts: 72/72.
- Audited actual product tgz installed in an isolated prefix: all six CLI scenarios PASS (transient/persistent wait, headless drain, deferred search, native resume, workflow). Full/default installed-resource smokes PASS.
- Product `0.1.17`, component `.6` installed side-by-side; PATH launcher atomically activated after version/component readback. Old `0.1.16` installation preserved; running sessions were not overwritten or restarted. New sessions use the fix. npm registry publication was not performed.

Component archive: 249 files, SHA256 `a41081200e5868d69ec3f1cf6a1622559144d42dbb5dc9ef65939e1aa75503bd`; TS source digest `905a59e2dd5b2bc8831526b320c2efb512f4e9ea6ab353a3ebf34926139409b0`.
Product archive: 18,803 files, 52,767,936 bytes, SHA256 `fe03baf71b226d313d63b45cd14bad42720eaf7a384a4c10ca6b31d82e55386f`.

## Failed attempts retained

The initial unit pack gate hit npm 12's object-keyed JSON output; verification/packing used the installed npm 10.9.4 with Node 24 rather than changing runtime semantics. Initial fixture faults used the wrong observer anchor; paused-slot and fault-status tests exposed the real fixes above. The foreground workflow's 7s whole-run timeout sometimes elapsed before actual Pi startup; its test-only bound is now 15s and still requires a live held tool to close through timeout. Product CLI fixtures referenced the retired unscoped package name/schema; they now verify the exact scoped package name and current schema rejection. One durable install timed out under ambient npm configuration; it was not activated or retried in place. A new private destination installed offline under isolated npm configuration and was verified before activation.

No Linux revalidation, real model billing, escaped external effect verification, or historical unknown-run recovery is claimed.
