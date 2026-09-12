# Scoped owned execution — first release boundary

This is an explicit opt-in contract, not a migration of active sessions or a filesystem sandbox. Unset `PI_SUBAGENTS_EXECUTION_SCOPE` preserves legacy behavior. The isolated candidate is not the currently installed rotom dependency.

## Initialize metadata, then start a new session

Using the candidate package directory (not the old installed `.2`):

```sh
node /absolute/candidate/owned-store.mjs init --base /absolute/private-base --accept-unverified-descendants
node /absolute/candidate/owned-store.mjs inspect --base /absolute/private-base
```

The command only initializes/inspects private metadata. It never launches Pi, changes cwd, migrates sessions, acquires writers, releases unknown locks or authorizes replay. JSON output supplies `PI_SUBAGENTS_TEMP_ROOT` and `PI_SUBAGENTS_EXECUTION_SCOPE=owned-process-groups-v2` for an explicitly new session. Do not set scope only in configuration: startup selection is required. Runtime opening is read-only; absent or changed directories/identity fail closed. A prior v2 store cannot be upgraded to the v3 store by rerunning init. Do not delete/rebind a base or marker to reset occupied capacity.

## Supported entrypoints

Pi agents must declare an explicit `tools` list of names (no nested tools, wildcards or extension paths) and an explicit `extensions` list (`[]` disables ambient discovery). Providers/tools can still be supplied through explicitly configured extensions and `subagentOnlyExtensions`. These are trusted local code, not a capability certification or sandbox; this contract does not make arbitrary extension code safe. Existing agents that rely on ambient resources are rejected before writer launch until their configuration is made explicit.

The agent Markdown parser uses comma/block lists, not YAML flow arrays. In a Markdown definition use a blank `extensions:` value for an empty list (do not write `extensions: []`); JSON/SDK agent configuration uses `extensions: []` normally. Example:

```markdown
---
name: scoped-worker
description: Explicit scoped worker
tools: read, write, edit, bash
extensions:
---
Complete the assigned independent task. Do not delegate.
```

Declare any required provider extension explicitly; an empty extension list does not load an ambient custom provider.

- Public `{agent, task, async:true}` owns one actual async Pi/external CLI runner and returns that runner's identity, not an extra workflow receipt. Public validation still runs first. Legacy mode retains its existing structured-to-workflow conversion.
- An `async:true` workflowScript controller supports independent async Pi/external CLI children and fresh single foreground Pi children. Foreground tasks are not converted into early async receipts to manufacture closure.
- Native `action:"resume"` for an original Pi-only async run requires its real closure, store/session identity and canonical lease fences. It is not permission to replay unknown effects. Workflow/external/retained-child recovery remains unavailable.

Explicitly unsupported: nested delegation, chains/task batches, worktrees, host gates/verification/review execution, fork/imported roots, external-job providers, standalone foreground execution and foreground workflow controllers. Relevant request/agent defaults and dynamic workflow children are checked before writer setup. Clarification/foreground-only routing, malformed async/worktree flags and caller-supplied workflow identities cannot bypass these checks. Known rejected children do not create unbound ownership rows and do not strand the controller's slot. Unexpected missing closure after real admission remains occupied.

The active scoped tool description takes precedence over custom/full/compact descriptions that advertise unsupported routes. `guide` marks the full upstream guide as legacy reference. `children.list` does not advertise scoped workflow children as resumable or advise fallback replay.

## What capacity release means

Only the registered owned resources are proved closed. A slot becoming free, task result, stopped state, receipt, empty controller Map, missing index or human acknowledgment does not prove descendant closure or business-effect verification. Escaped descendants can still write. Do not retry unknown work under another ID, directory, session, scope or base. Separately authorized independent tasks are distinct from retries.

A real direct close and controlled group closure must precede canonical lease release. Forced pipe destruction is not actual close; owner loss, malformed/missing evidence or active/unreadable leases retain occupancy. Scoped v2 leases remain in the shared lease root but are unreadable to old readers, so old PID-staleness checks cannot reclaim them. The v3 store binds the lease/session directory identities; replacing those directories cannot create a fresh pool.

All tooling runs with the local user's permissions. This does not prevent deliberate filesystem edits or arbitrary external tools from escaping a process group. It does not promise rollback, exact token/cost savings, Linux validation from macOS evidence, or support for an untested topology.
