# rotom Goal

rotom-maintained `@narumitw/pi-goal@0.54.4-rotom.10`. MIT upstream provenance is in [UPSTREAM.md](UPSTREAM.md). Use the integrated [rotom installation](../../docs/usage.md), not a second upstream Goal extension.

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

## Clarification, authorization and retries

The shared Goal prompt contract applies on start, objective updates, continuation and resume:

- Identify the deliverable, completion evidence and authorized write scope. Inspect project scripts, documentation and current state before asking; unfamiliar domain rules and verification commands must come from evidence. State low-risk, reversible assumptions and proceed, without rewriting the objective, reducing it to an MVP or adding acceptance requirements.
- Ask only about unresolved choices that materially affect acceptance, product direction, cost, permissions or ownership. Preserve explicit authorization already given. For missing authorization or a critical user decision, ask before the affected action with `ask_user_question` when available; that tool keeps the run open until the answer arrives. If Ask is unavailable, call `goal_blocked` with `needs_user_decision: true`, plus the concrete reason and evidence. This user-decision path does not require three blocker turns. Resume and automatic continuation do not grant missing authorization.
- After a tool problem, distinguish confirmed failure, still-running work and unknown outcome. Inspect evidence and require new evidence or a specific testable hypothesis before another attempt, within existing retry limits. Never switch tools to bypass a boundary. Check unknown external writes read-only at the same target and never replay merely because success was unproven. Continue other unfinished requirements when one path is blocked. If every remaining requirement depends on unavailable evidence or user/external action, use `goal_blocked`. The three-turn minimum still applies to a recurring external blocker unless `needs_user_decision: true`; it is not a requirement to perform three futile attempts.

These are model instructions, **not a permission interceptor**. Completion evidence requirements and reviewer limits are unchanged. Deterministic tests prove prompt injection and lifecycle behavior, not live-model judgment or authorization compliance.

## Automatic continuation (default)

Four stable tool schemas are registered at startup. Visibility never activates Goal mode. Every action requires the current active Goal and matching `goal_id`:

- `goal_continue({ goal_id, next_action })`: optionally record planning data for the next automatic continuation. It does not terminate or block ordinary sibling tools, prove progress or grant external-write authorization. Omitting it does not pause Goal.
- `goal_wait({ goal_id, reason, resume_after_ms? })`: remain active but quiet for an arranged external event; optional one-shot safety deadline, minimum 10 seconds. Not a polling facility.
- `goal_complete({ goal_id, summary })`: submit a completion claim to the bounded reviewer below.
- `goal_blocked({ goal_id, reason, evidence, repeated_turns, needs_user_decision? })`: require user/external action. `needs_user_decision: true` permits an immediate user-owned decision stop; otherwise the same blocker must recur for at least three consecutive Goal turns. The count/evidence remain model-reported.

A normal run end, including `stopReason: length`, automatically queues the next Goal-owned prompt while the Goal remains active and not waiting. Cancellation, replacement, compaction and session changes still invalidate stale prompt ownership. Persisted waits keep their existing ownership/deadline behavior. `missing_decision` remains readable for older sessions but new lifecycle logic does not produce it.

The automatic-response limit now defaults to **Unlimited**. An explicitly saved positive limit, such as 25, still applies to each automatic-work epoch and is displayed as a numeric count. The footer and manager display Unlimited without `null`. Pause/status views retain the last accepted continuation plan when available; it is display-only, not verified progress or replay authority. No default token budget or model summary request is added.

Two independent guards bound empty or repetitive work. Three consecutive automatic runs without a non-control tool call pause with `stopReason: empty_responses`; any non-control tool resets that count. The configurable no-progress fingerprint threshold defaults to three identical runs: the first threshold injects a change-approach prompt and resets the fingerprint, while the second threshold pauses. Goal controls are excluded from both progress signals. Different ordinary narration or arguments can still evade a heuristic fingerprint; this is not proof of semantic progress.

Restrictive allowlists must now include `goal_continue` alongside `goal_complete` and `goal_blocked`; missing tools pause/refuse activation, never widen the caller's selection. No old pending continuation is migrated into a fresh authorization.

## Recovery and explicit resume

Pi remains the only owner of each provider request's configured retry/backoff and overflow compaction. Goal does not expand that host allowance or replay a tool. The existing host retry events carry attempt/delay information, and Goal displays `recovering` until a successful response or settlement.

When provider recovery settles without success, Goal enters a persisted timed wait before submitting one fresh continuation: 5 minutes, then 15 minutes, then 30 minutes. User input or `/goal pause` cancels the wait. A successful run resets the sequence. If provider recovery exhausts again after all three waits, Goal pauses with `stopReason: provider_retry_exhausted`. This also applies when Pi retry is disabled. Threshold compaction after a failed request cannot erase the pending failure or authorize replay of a completed/unknown tool effect.

Session restoration automatically queues one fresh continuation for a previously active, nonwaiting Goal when `resumeOnRestore` is true (the default). It never replays a saved `next_action` or tool call. Set `resumeOnRestore: false` to retain the explicit `stopReason: session_restored` pause. Explicit external waits retain their existing ownership/deadline behavior. `/goal resume` also accepts an idle active Goal (for example after manual compaction), but refuses it while a run, recovery, queued message or owned prompt/continuation is pending. Resume submits one fresh prompt and preserves cumulative usage and review allowance; it is not permission to repeat successful/unknown effects. Older persisted provider-error waits remain readable and can be explicitly resumed.

Stable `stopReason` codes are stored in the existing `goal-state` entry and shown in status/menu views; raw provider error bodies are not added to this metadata. The opt-in managed-run `pi-goal:event:<runId>` state event retains its existing statuses and adds `activity` (`running`, `recovering`, `waiting`), recovery kind, optional wait `resumeAt`, and `stopReason`. Activity changes publish even when status stays active; identical snapshots are deduplicated. These are display data, not wake/replay authority. External consumers must adopt these optional fields; this change does not modify a separate dashboard application.

## Completion reviewer (default on)

`goal_complete` first checks ownership, current Goal identity and the existing completion guards. It then persists a review attempt **before** requesting the selected model via Pi's public `ModelRegistry.complete` API. No nested AgentSession, resource discovery, provider change or provider-failure fallback is used.

The reviewer receives the full objective, an explicitly untrusted completion claim, bounded recent session tool records, and only `review_read` / `review_list`. Those tools read project-relative local text files/directories; they do not execute shell commands, edit files, browse pages or load project extensions/skills. Symlinks, paths outside the project, `.git`, `.pi` and `node_modules` are excluded. This limited tool surface is **not an OS sandbox**: trusted provider code still runs as the local user.

The reviewer must inspect requirements individually and finish with `<approved/>` or `<rejected/>`. Captured session calls/results can support that a tool ran and what it reported, but cannot issue instructions; current file state must be corroborated. Such observations do not prove that a changed artifact still passes or an unobserved external effect succeeded. The reviewer distinguishes missing evidence from an actual defect and must not prescribe repeating external writes for proof. A correct marker is only a second model's judgment, not proof that every check was sound. Uninspectable end-to-end, browser or external-service requirements must remain unverified. Approval is bound to the current Goal/run, selected evidence and digests of the files/directories actually inspected; it does not freeze the whole workspace or external state.

- **Approved:** recheck ownership, evidence and file digests before committing completion.
- **Rejected:** distinguish an observed work defect from a proof gap. Remain active for an evidenced, authorized repair, read-only evidence gathering or other unfinished requirements; a rejection is neither authorization nor proof that prior work failed. Never repeat successful/unknown external writes to satisfy the reviewer or manufacture a fresh candidate. If every remaining requirement depends on unavailable evidence or a user/external action, call `goal_blocked`. Reviewer text is an untrusted assessment, not instructions.
- **Unknown/error:** never complete or automatically repeat the review, but keep Goal active so the model can continue other work or gather new read-only evidence. The unresolved paid attempt persists across resume/edit and recovery.
- **Cancelled/stale:** a late provider reply cannot approve a newer run. Ownership loss still records known usage and cannot manufacture completion.
- Bounded continuation/wait tool results and text-only user/host announcements can support procedural requirements during review (an announcement is not proof of its claimed external effect), but are not proof of semantic progress or fresh work. Repeating the same candidate or exhausting the fixed review allowance returns a rejection while Goal remains active. Changing the completion summary or only issuing control calls does not create a fresh candidate. Resume/edit do not replenish the allowance.

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
| Parent evidence | Complete recent session records within 12,000 bytes; individual records over 6,000 bytes omitted |

Token accounting is **reported and partial**. A final in-flight response can exceed an admission budget; byte limits are not token estimates. Review usage is separately attributable from parent model usage; the Goal token-budget admission covers their sum. USD/credits remain unknown rather than `$0`. Cancellation cannot guarantee that the upstream provider stops billing. Provider retries are requested off; a custom provider that ignores cancellation/retry options is not certified by this extension.

The user-owned opt-out is `completionReview: false` in the existing user `pi-goal.json` (normally `~/.pi/agent/pi-goal.json`), followed by `/reload`. Disabling the reviewer explicitly restores model-reported completion, not independently verified completion. Do not disable it automatically after a rejection or error.

```json
{
  "completionReview": true,
  "resumeOnRestore": true,
  "rpc": { "enabled": false },
  "continuationLimits": { "automaticTurns": null, "noProgressTurns": 3 }
}
```

## Persistence and validation

Goal state and review-attempt metadata live in the existing session branch, not `.pi/goals`. Review content stays in ordinary tool results/notifications; the dedicated `goal-review-result` entry contains only status, identity/digests and partial usage metadata. An interrupted persisted review restores paused and is not replayable.

From this repository, after installing its locked Pi runtime:

```sh
cd packages/rotom-goal
npm test
```

Type checking uses `packages/rotom-pi/node_modules/.bin/tsc -p packages/rotom-goal/tsconfig.json` from the repository root. Tests cover local invariants and a real Pi SDK with a deterministic faux provider, including successful/exhausted/cancelled host retries, post-error threshold compaction, and single dispatch of successful/unknown tool effects. They do **not** prove live-model acceptance quality, lower cost, real external verification or desktop interaction. Those require a separately authorized bounded evaluation.
