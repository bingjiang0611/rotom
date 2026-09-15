# rotom Goal

rotom-maintained `@narumitw/pi-goal@0.54.4-rotom.1`. MIT upstream provenance is in [UPSTREAM.md](UPSTREAM.md). Use the integrated [rotom installation](../../docs/usage.md), not a second upstream Goal extension.

## One session, one objective

```text
/goal [--tokens 100k] <complete objective and acceptance requirements>
/goal status
/goal pause
/goal resume
/goal edit <replacement objective>
/goal clear
```

Bare `/goal` opens the manager. Keep all acceptance requirements in the objective; there is no task tree, project goal pool, separate criteria store or ordered queue. Current files, command results and external observations outrank plans and summaries.

## Explicit continuation (default)

Four stable tool schemas are registered at startup. Visibility never activates Goal mode. Every action requires the current active Goal and matching `goal_id`:

- `goal_continue({ goal_id, next_action })`: end this execution segment and permit **one** Goal-owned continuation after settlement. Call alone. The next action is untrusted planning data, not evidence or new external-write authorization.
- `goal_wait({ goal_id, reason, resume_after_ms? })`: remain active but quiet for an arranged external event; optional one-shot safety deadline, minimum 10 seconds. Not a polling facility.
- `goal_complete({ goal_id, summary })`: submit a completion claim to the bounded reviewer below.
- `goal_blocked({ goal_id, reason, evidence, repeated_turns })`: require external/user action after the same blocker recurs for at least three consecutive Goal turns. The count/evidence remain model-reported.

If an otherwise successful run ends without an accepted continue/wait/terminal decision, Goal **pauses**, spending no automatic repair call. New user input or `/goal resume` can continue it. Cancellation, replacement, compaction and session changes invalidate old decisions; an idle compaction does not itself authorize a new dispatch. Persisted waits keep their existing ownership/deadline behavior. Native within-run retries and independently triggered host work are not new Goal continuation decisions.

The default automatic-work limit remains **25 model responses**, not 25 tool calls or scheduler dispatches. The no-progress threshold remains 3 repeated runs. Control-only `goal_continue` narration and arguments are excluded from progress fingerprints. Different ordinary narration can still evade a heuristic fingerprint; this is not proof of semantic progress.

Restrictive allowlists must now include `goal_continue` alongside `goal_complete` and `goal_blocked`; missing tools pause/refuse activation, never widen the caller's selection. No old pending continuation is migrated into a fresh authorization.

## Completion reviewer (default on)

`goal_complete` first checks ownership, current Goal identity and the existing completion guards. It then persists a review attempt **before** requesting the selected model via Pi's public `ModelRegistry.complete` API. No nested AgentSession, resource discovery, provider change or provider-failure fallback is used.

The reviewer receives the full objective, an explicitly untrusted completion claim, bounded recent session tool records, and only `review_read` / `review_list`. Those tools read project-relative local text files/directories; they do not execute shell commands, edit files, browse pages or load project extensions/skills. Symlinks, paths outside the project, `.git`, `.pi` and `node_modules` are excluded. This limited tool surface is **not an OS sandbox**: trusted provider code still runs as the local user.

The reviewer must inspect requirements individually and finish with `<approved/>` or `<rejected/>`. A correct marker is only a second model's judgment, not proof that every check was sound. Uninspectable end-to-end, browser or external-service requirements must remain unverified. Approval is bound to the current Goal/run, selected evidence and digests of the files/directories actually inspected; it does not freeze the whole workspace or external state.

- **Approved:** recheck ownership, evidence and file digests before committing completion.
- **Rejected:** remain active; fix the missing requirements, then submit new evidence or declare continuation.
- **Unknown/error/cancelled/stale/limited:** never complete or automatically repeat the review. Unresolved attempts persist across resume/edit and recovery. A late provider reply cannot approve a newer run.
- Changing the completion summary alone does not create a fresh candidate. Resume/edit do not replenish the Goal's review allowance.

### Fixed bounds and cost

| Bound | Limit |
|---|---:|
| Reviews across one Goal (including resume/edit) | 2 |
| Model requests per review | 4 |
| Local tool calls per review | 12 |
| Review wall deadline | 90 seconds |
| Requested output per response | 2,048 tokens |
| Reported-token admission across Goal reviews | 24,000 |
| Serialized review context | 96,000 bytes |
| Complete text file per read | 24,000 bytes |
| Directory listing | 100 entries, explicitly partial beyond that |
| Parent evidence | At most 6 complete tool records / 12,000 bytes; individual oversized records omitted |

Token accounting is **reported and partial**. A final in-flight response can exceed an admission budget; byte limits are not token estimates. Review usage is separately attributable from parent model usage; the Goal token-budget admission covers their sum. USD/credits remain unknown rather than `$0`. Cancellation cannot guarantee that the upstream provider stops billing. Provider retries are requested off; a custom provider that ignores cancellation/retry options is not certified by this extension.

The user-owned opt-out is `completionReview: false` in the existing user `pi-goal.json` (normally `~/.pi/agent/pi-goal.json`), followed by `/reload`. Disabling the reviewer explicitly restores model-reported completion, not independently verified completion. Do not disable it automatically after a rejection or error.

```json
{
  "completionReview": true,
  "rpc": { "enabled": false },
  "continuationLimits": { "automaticTurns": 25, "noProgressTurns": 3 }
}
```

## Persistence and validation

Goal state and review-attempt metadata live in the existing session branch, not `.pi/goals`. Review content stays in ordinary tool results/notifications; the dedicated `goal-review-result` entry contains only status, identity/digests and partial usage metadata. An interrupted persisted review restores paused and is not replayable.

From this repository, after installing its locked Pi runtime:

```sh
cd packages/rotom-goal
npm test
```

Type checking uses `packages/rotom-pi/node_modules/.bin/tsc -p packages/rotom-goal/tsconfig.json` from the repository root. Tests cover local invariants and a real Pi SDK with a deterministic faux provider. They do **not** prove live-model acceptance quality, lower cost, real external verification or desktop interaction. Those require a separately authorized bounded evaluation.
