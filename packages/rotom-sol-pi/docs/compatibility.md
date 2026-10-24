# Pi Compatibility

Current development baseline: Pi 1.3.0. Action Fusion now returns `isError: true` with versioned `details.actionFusion` after an applied write whose follow-up fails or is skipped. Hosts must honor error results; older Pi 0.85 is no longer supported by this maintained component. The sections below record earlier compatibility runs, not current guarantees.

## Current compatibility repair (2026-10-09)

The failures recorded in the earlier backport verification below are resolved in this follow-up:

- Action Fusion handles both the older thrown Bash error and Pi 1.0's `isError: true` result. A failed follow-up retains the successful file mutation, emits `[then_run:failed]` with the command output, and propagates failure to Pi. It never reruns the command or infers failure from output text. The execution context type is derived from the public tool signature, rather than assuming event and tool contexts are identical.
- Regression checks against the pre-fix source produced three expected failures: one direct failure-result test and persistent/in-memory SDK failure cases. The final tests also check one command dispatch, preservation of file contents, and successful output that merely mentions a non-zero exit code. Recall test helpers use checked, typed pagination details instead of treating arbitrary tool-result details as an object.
- On macOS with Node 24.18.0 / npm 11.16.0, `VITEST_MAX_WORKERS=2 npm run check` passed type checking, all 19 files / 166 tests and package inspection against both locked Pi 0.85.1 and Rotom 0.1.15's installed Pi `1.0.4-rotom.2`. Public API checks passed for both. The Rotom run used links to its actual packages in an isolated test dependency tree; it did not modify the installed runtime. These are offline/faux-provider tests, not live provider or interactive TUI acceptance.
- Development dependency repairs are Vitest 4.1.11 (including its matched internal packages), Undici 8.10.2, brace-expansion 5.0.12 and source-map-js 1.2.2. The Undici override is required by Pi 0.85.1's exact 8.9.0 dependency; the other two transitive updates fit existing ranges. The regenerated lockfile also normalizes/deduplicates the old nested/workspace entries; unrelated retained package versions were preserved. A fresh `npm ci --ignore-scripts` followed by `npm audit --audit-level=high --registry=https://registry.npmjs.org` reports zero vulnerabilities, including moderate findings. This result covers the source development lockfile, not Rotom's independent installed dependencies.

All installs and tests used temporary checkouts. The already-running checkout's `node_modules` and the global Rotom installation were not replaced; use the new lockfile for the next clean development install. Personal settings, OCC and the local recall implementation remain unchanged.

## Earlier selective backport verification (2026-10-09)

This branch selectively incorporates upstream `148b398` (ephemeral archives), `8c46b76` (Unicode-space paths), and `2415cdd` (reducer route trimming). It retains the local recall source-reference fix; no OCC or Windows-path changes were imported. Personal configuration was not changed, and OCC remains disabled in the user's effective configuration.

Validation used isolated source copies on macOS, Node 24.18.0 and npm 11.16.0, without live model calls or changes to installed Pi:

- New regression tests against the old implementation: 22 expected failures, 78 passes. With the backports and locked Pi 0.85.1: `VITEST_MAX_WORKERS=2 npm run check` passed all 19 files / 163 tests, type checking and package inspection. Public API and all-mechanisms checks also passed. This includes deterministic SDK and real Pi CLI `--no-session` tests, archive retention and the existing recall regressions; Pi 0.84.2 was not retested.
- The initial full run found two packaging assertions caused by npm 11.16's name-keyed JSON output, plus one configuration test exceeding its unchanged five-second timeout under default parallelism. The packaging test now accepts both npm output shapes. The rerun bounded workers to two without changing timeouts or weakening assertions.
- An additional run against the installed Rotom Pi `1.0.4-rotom.1` passed 162/163 runtime tests, including the new regressions, but is **not a full compatibility pass**. Action Fusion marks a failed `then_run` command (exit 7) as succeeded rather than reporting failure. The same failure reproduces on the pre-backport commit `807ad60`. Type checking also fails against this runtime's newer tool-context/result types; pre-backport type checking fails too. Neither incompatibility was changed in this scoped backport.
- `npm audit --audit-level=high` fails for the unchanged development lockfile (3 high, 3 moderate; high entries: `brace-expansion`, `source-map-js`, `undici`). No dependency upgrades or audit fixes were applied. This audit does not establish the vulnerability status of Rotom's separately installed dependency tree.

## Public API surface

SoL-Pi imports only public package exports:

- `createEditToolDefinition`
- `createWriteToolDefinition`
- `createBashToolDefinition`
- extension types and `ExtensionAPI.registerTool`
- `context`, `before_provider_request`, `tool_result`, `turn_end`, `agent_settled`, and `session_before_tree` extension events
- native compaction events, `ExtensionContext.getContextUsage()`, and `ExtensionContext.compact()`
- `ExtensionContext.model` and `ExtensionContext.modelRegistry`
- the public session-manager methods exposed through `ExtensionContext`

## Action Fusion

The built-in edit/write definitions capture their working directory, so SoL-Pi caches one definition per `ctx.cwd`. Its own per-file queue surrounds the built-in mutation and follow-up command. It does not nest Pi's built-in mutation queue.

Action Fusion decodes `file://` targets with Node's `fileURLToPath()` before resolving the queue and hash-check path. This keeps file URLs, including percent-encoded filenames and Pi's optional `@` prefix, aligned with the file handled by the built-in mutation tool.

The queue covers only fused operations registered by this SoL-Pi instance. External processes, direct built-in-tool calls outside the replacement, and unrelated extensions are not globally locked. SoL-Pi hashes the target immediately before launching `then_run` and skips the command if it observes an intervening content change.

## ObservationPack

ObservationPack changes only the messages projected through the public `context` event. Stored session history remains intact. Original bytes and the JSONL ledger live under the session-derived SoL-Pi directory.

Results larger than 10 KiB are sent in full for two provider requests before projection replaces them. An `obs_recall` page can itself exceed that threshold (recall is bounded to 16 KiB / 400 lines). Such a page is replaced with a direct reference to its original observation ID and byte offset, plus the next offset and source EOF state, **not** a newly archived copy of the page. Re-reading that range with a new tool call gets its own two-request budget. Small pages keep the existing below-threshold behavior; reaching EOF on one page does not prove all earlier pages were read.

The reference comes from the recall tool's structured details, never from text that resembles a recall header. Before dropping page text, the extension re-reads that bounded source range and verifies the exact result and pagination metadata. Missing, changed or symlinked source objects, invalid details and failed recall results retain their full text. Ledger projection entries for recall use the original ID with the page offsets; byte/token estimates still describe the tool result being projected, not the whole source or provider-measured usage.

Native compaction and resume retain the original session's object root. A fork can rebuild source objects when the original tool results are present in its context. A compacted fork without those sources keeps its retained recall pages in full; it does not silently read the parent session's storage. This change creates no new wrapper objects, but does not migrate wrapper chains already archived by older versions. `tests/observation-pack.test.ts` covers repeated projection, independent re-read budgets, exact multi-page UTF-8 reconstruction, persisted compaction/resume, source-loss/fork behavior and metadata-only ledger references without a live model.

## Evidence-Preserving Reducer

The reducer handles public `tool_result` events and resolves the configured reducer provider/model through Pi's model registry before calling `ExtensionContext.modelRegistry.complete()` when available. For the Pi 0.81.1 fork, which exposes no registry `complete()` method, it resolves authentication for that reducer model through `getApiKeyAndHeaders()` and calls the shared `@earendil-works/pi-ai/compat` completion API. The reducer preserves the original result whenever the configured reducer model is unavailable or eligibility, model-call, schema, source-hash, exact-quote, size, or likely-secret checks fail.

All persistent paths use `SessionManager.getSessionDir()` and `getSessionId()`, which are present in both the fork and Pi 0.85.1. If the session directory is empty (`--no-session` or `SessionManager.inMemory()`), SoL-Pi lazily creates a private `sol-pi-<session-id>-<random>/` directory under `os.tmpdir()`. Its path is reused by session ID across contexts and both archiving mechanisms while the extension is loaded. These files remain available after worker shutdown for callers that need to read evidence; cleanup is left to the host or caller. SoL-Pi creates no configurable storage-path surface.

The unpublished shared artifact layout is not read or migrated. Each persistent session starts from its own `<sessionDir>/sol-pi/<sessionId>/` directory; ephemeral sessions use the temporary fallback above.

## Online Context Compact

Online Context Compact uses ordinary public `context` and `before_provider_request` handlers instead of fork-only post-transform observer methods. Public handlers run in extension load order, so the SoL-Pi entrypoint registers Online Context Compact after its other context transformers. A third-party transformer loaded later is outside the context-growth observation used by its estimate.

Pi does not expose its active retained-tail compaction setting through the public extension context. The standalone extension therefore uses the Pi 0.85.1 default of 20,000 tokens for its economic estimate. Its programmatic factory accepts an explicit matching value for a non-default Pi setting.

Pi 0.85.1's `ExtensionContext.compact()` aborts the active agent before it summarizes, and `agent_settled` fires only once a whole run has drained every turn, retry, auto-compaction, and queued continuation. A plan boundary that selects compaction therefore saves its plan and progress state, calls `ExtensionContext.abort()` to stop the run, and runs compaction from the `agent_settled` that stop produces. The handler awaits the compaction's own `onComplete`/`onError` callbacks. On success, the extension sends a hidden reminder through public `ExtensionAPI.sendMessage()` with `triggerTurn: true`, so Pi starts a new turn against the compacted context and rebuilds the plan even when the native summary omits that instruction.

A settlement barrier keeps the original `agent_settled` dispatch open until the triggered continuation settles. Print- and JSON-mode processes therefore complete the compact-and-continue sequence within the same Pi invocation; an outer driver does not need to resume the session or send `Continue working`. This continuation is armed only by a successful boundary compaction. Cancelling or exiting does not schedule one. A Pi build that never emits `agent_settled` starts no boundary compaction.

The lifecycle regression accepts `manual` (Pi 0.84) and `extension` (Pi 0.85) as the reason for an extension-requested compaction. The exact compaction instructions, continuation count, settlement barrier and final response assertions remain unchanged; this label difference does not require a runtime fallback.

Pi 0.85.1 does not return a promise from `ExtensionAPI.sendMessage()`. The barrier is therefore verified for standalone SoL-Pi and depends on Pi starting the requested turn synchronously. A later-loaded third-party extension that performs long asynchronous work in its own `agent_settled` handler is outside this guarantee and needs an integration test with that extension set.

Pi reports the session as idle while an extension-requested manual compaction is running. SoL-Pi cancels `session_before_tree` during that interval to prevent tree navigation from moving the active leaf underneath the compaction. Navigation works normally after the compaction callback settles.

Online Context Compact reads `ExtensionContext.getContextUsage()` for both the context window and the provider-counted context size. When Pi reports no size — as it does between a compaction and the next answered request — the boundary falls back to its own estimate.

The standalone entry passes `cacheWriteReadRatio` from `sol-pi.json` directly into Online Context Compact's economic check. It does not inspect model price metadata. Changing models during a session does not change the ratio; users who want a different decision policy update the configuration and start a new session.

## Interactive TUI

The lightning savings treatment uses Pi 0.85.1's public `renderCall`,
`renderResult`, `ctx.ui.notify()`, and keyed `ctx.ui.setStatus()` APIs. It checks
`ctx.mode === "tui"` rather than `ctx.hasUI`, because RPC mode also reports UI
support. The renderer therefore changes only the interactive terminal display;
it does not change session messages, provider requests, tool results, JSON
events, print output, or RPC UI requests.

## Test doubles

The test suite drives every extension through the same public `ExtensionAPI` and `ExtensionContext` surface Pi provides, over a real public `SessionManager`, without calling a remote model provider. That keeps the suite zero-spend and independent of the deleted Pi monorepo test harness. Suites that need a genuine session tree — branch order, compaction entries, custom entries, resume — use `SessionManager.inMemory()` or `SessionManager.create()` rather than reimplementing them.

`tests/pi-package-integration.test.ts` loads the actual TypeScript entrypoint through Pi's `DefaultResourceLoader`, reads a trusted all-enabled project configuration, and executes a fused write/command and a plan update in a real `AgentSession`. `tests/online-context-compact-agent-session.test.ts` verifies one and two consecutive native compactions and waits for automatic continuation before the original prompt returns. These integration tests use Pi's deterministic faux provider; they verify runtime compatibility, not live provider authentication or token savings.

The 0.84.2 backward-compatibility run used an isolated copy of the current source and tests, separate dependencies, and an empty Pi agent directory. Only the copy's four Pi development dependency versions, lockfile, and installation-guide version mentions changed. No source or test changes were needed. The run included all four mechanisms and the native compaction/continuation integration tests; it did not repeat live-provider benchmarks on 0.84.2.
