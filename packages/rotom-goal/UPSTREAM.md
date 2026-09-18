# Upstream provenance — rotom Goal

- Upstream package: `@narumitw/pi-goal`
- Repository: <https://github.com/narumiruna/pi-extensions> (`packages/pi-goal`)
- Baseline: upstream `0.54.4`, 22 TypeScript source files.
- License: MIT; original notice retained in `LICENSE`.
- Maintained version: `0.54.4-rotom.5`, private component of [rotom](https://github.com/bingjiang0611/rotom), not an upstream or npm release.
- `.rotom.2`: Qoder Ultimate live evaluation exposed missing verdict markers when the request contained only JSON. The request now carries the same review contract outside the untrusted payload, and file tools explain the project-root path. Bounded `goal_continue`/`goal_wait` tool results and text-only user/host announcements are now visible to the reviewer for procedural requirements, but remain excluded from candidate identity and progress. The request also clarifies pre-completion timing and native control semantics; evidence retains complete records up to the existing 12KB bound instead of prematurely dropping them after six records. Strict verdict parsing, model-call/attempt limits and token/byte budgets are unchanged.

## Retained upstream behavior

Single session-branch Goal state, ownership mutex, explicit wait, native retry/compaction handling, automatic-response and no-progress limits, token-budget stop, and stable startup schemas remain the foundation. User-provided objective text stays inside the authoritative Goal contract. There is no project goal pool, ledger, ordered queue, task tree or separate acceptance-criteria store.

The entry remains `src/index.ts`, not upstream's generated `dist/index.ts`: the upstream archive omitted its bundler script. Pi resolves `.js` specifiers to `.ts`; no stale generated bundle is shipped. Menus lazily load the existing `@narumitw/pi-tui-kit` dependency.

## rotom changes

### `.rotom.0`: no-progress fingerprint

`src/safety.ts` fingerprints normalized assistant text plus ordered tool names/arguments. Identical failing tool calls no longer reset the no-progress guard simply because a tool was attempted. Different text/arguments still reset this heuristic; it is not evidence of semantic progress. Tool-free fingerprints retain their upstream encoding.

### `.rotom.1`: explicit continuation and completion review

This version takes design inspiration from `tmonk/pi-goal-x` commit `323fd4c3b07902e5b354f7d8b7fa0b7ae5bf072f`; its scheduler, task database and nested auditor session are **not** imported.

- `goal_continue` is the fourth stable tool. A current run declares one next action before yielding. Missing decisions pause without a repair turn. Existing Goal dispatch ownership, wait and budget machinery are reused; no second scheduler/allowance is added. Mixed lifecycle-tool batches are rejected before any sibling executes.
- Control-only narration and `goal_continue` arguments are excluded from progress fingerprints.
- `goal_complete` defaults to a bounded file-only reviewer using the selected provider through public `ModelRegistry.complete`. It creates no nested AgentSession, discovers no resources and never gets bash/browser/write tools.
- `completionReview` defaults true in existing settings. An explicit user opt-out restores the old model-reported completion path.
- Review attempts and partial reported-token usage persist in the existing Goal state before dispatch. Resume/edit do not replenish the allowance. Unknown/in-flight attempts are not replayed; restore pauses them. Approval checks the current run/Goal, selected evidence and inspected file digests.
- Requirements remain in the complete original objective. Reviewer approval is a second opinion, not independent proof of arbitrary external effects. File scope, budgets, cancellation limits and unknown USD/credits are documented in [README.md](README.md).

### `.rotom.3`: clarification, authorization pauses and evidence-driven retries

Design inspiration: `qiaomu-goal-meta-skill` by 向阳乔木 (<https://github.com/joeseesun/>). No skill implementation, templates or linter are bundled. The shared prompt contract adds evidence-first clarification without narrowing the original objective, immediate pauses for missing authorization/critical decisions through the existing missing-decision path, and evidence-driven retries with read-only resolution of unknown external writes. No new tool, state, model call, permission interceptor or fixed improvement-round limit is added. Technical `goal_blocked` thresholds and completion requirements remain unchanged.

### `.rotom.4`: stop futile retries and separate rejection from repair authority

Ultimate evaluation of `.rotom.3` exposed repeated failed checks to meet the blocker count, and repeated publication after completion-review rejection. The shared contract now permits an immediate pause once diagnostics show an external prerequisite with no useful next investigation; three turns still gate `goal_blocked`, not the right to pause. Rejected reviews use the same guidance in both the persistent prompt and tool feedback: distinguish observed defects from proof gaps, gather proof read-only, never replay successful/unknown external writes just to obtain approval, and pause when no justified repair or new evidence is available. The file-only reviewer distinguishes captured procedural observations from unobserved external effects; its report is an assessment, not authority to act. Tools, state schema, approval requirements and all review/continuation limits are unchanged. This remains model guidance, not a semantic write interceptor.

### `.rotom.5`: bounded long-task allowance and pause context

The default automatic-response allowance becomes 100; explicitly saved limits are unchanged. Footer status shows remaining responses, and the existing Goal state optionally retains the last accepted continuation plan for pause/status display only. It cannot schedule work, count as progress, reset usage, or authorize replay. Old state without this field remains valid. No summary model call, new tool, scheduler, or relaxed token/no-progress/reviewer guard is introduced.

## Compatibility and verification

Restrictive tool allowlists now require `goal_continue` for Goal activation; they are never automatically widened. Previous active sessions need an explicit new decision rather than inheriting a pending authorization. Goal state gains optional review metadata; invalid metadata fails closed instead of resetting paid attempts. The three-consecutive-turn blocker count remains model-reported.

`npm test` runs deterministic lifecycle, budget, reader, cancellation and restoration regressions, plus a real installed Pi SDK/faux-provider flow. `tsconfig.json` checks against the product Pi declarations. Product validation additionally checks the locked archive, default/full loader surface and context footprint. These checks do not prove live-model completion quality, lower token cost, real external verification or desktop UI behavior. Live Ultimate evaluations and their limits are recorded separately in the repository's `experiments/goal-review/`; they are not part of `npm test`. No npm publication is part of this component change.
