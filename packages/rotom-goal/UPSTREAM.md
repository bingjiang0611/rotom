# Upstream provenance — rotom Goal

- Upstream package: `@narumitw/pi-goal`
- Repository: <https://github.com/narumiruna/pi-extensions> (`packages/pi-goal`)
- Baseline: upstream `0.54.4`, 22 TypeScript source files.
- License: MIT; original notice retained in `LICENSE`.
- Maintained version: `0.54.4-rotom.1`, private component of [rotom](https://github.com/bingjiang0611/rotom), not an upstream or npm release.

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

## Compatibility and verification

Restrictive tool allowlists now require `goal_continue` for Goal activation; they are never automatically widened. Previous active sessions need an explicit new decision rather than inheriting a pending authorization. Goal state gains optional review metadata; invalid metadata fails closed instead of resetting paid attempts. The three-consecutive-turn blocker count remains model-reported.

`npm test` runs deterministic lifecycle, budget, reader, cancellation and restoration regressions, plus a real installed Pi SDK/faux-provider flow. `tsconfig.json` checks against the product Pi declarations. Product validation additionally checks the locked archive, default/full loader surface and context footprint. These checks do not prove live-model completion quality, lower token cost, real external verification or desktop UI behavior. No paid model experiment or npm publication is part of this change.
