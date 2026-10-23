# Locked Subagent distribution

The default product selects **`pi-subagents@0.52.1-rotom.10`**, independently maintained in the repository's `packages/rotom-subagents/`. New builds consume its reviewed archive, not installed source or a patch stack. This is a Subagent fork, not a Pi fork.

- Archive: `pi-subagents-0.52.1-rotom.10.tgz`
- SHA256: `aee008364cb159c4424678c37a2f77e75a78d292937f0354f318ce483fd5dede`
- SHA512 SRI: `sha512-5mXSC3zXponiWE+NP16rJ4zo1j1mHS04bbFO+fOc31RVVHA8rKvZ3nvemDOHT9qCBqINAiRcXJuhpZCNNNeoHg==`
- Source digest: `3474af84fa16bf546df3438066571a51b25698b099f53f8c50ddf34ffe291070`

`.rotom.10` makes the builtin roles launchable in owned scope: `delegate` and `oracle`/`advisor` declare empty ambient extensions and fresh default context (oracle now works from a parent-written decision brief), `reviewer` gains prompt-restricted read-only `bash`, and `researcher` is removed because its web tools do not exist in rotom. `.rotom.9` pauses the retiring runtime's live runners and awaits close finalization before cleanup on quit/reload/session replacement/disposal. A result arriving before the native close callback retains pending only while this process owns the matching live observer; registration is not an exit proof. It never signals historical PIDs or repairs missing old-run proof. Retired schedule execution and automatic goal-mission continuation remain disabled, including legacy opt-out sessions; old data remains untouched. Targeted status uses bounded current-session output and native recovery preflight, which is not launch authorization. Shared legacy mission/inspector readers remain. Product schema and prompt guidance are scoped by the product wrapper; raw execution still passes the original fences.
- Upstream: <https://github.com/nicobailon/pi-subagents>
- License: MIT, Copyright (c) 2026 Nico Bailon. Original notice remains in `package/LICENSE`; provenance and maintenance notes are in `package/UPSTREAM.md`.
- Source baseline: validated `0.52.1-dev-agent-owned-flat.7`; 213 TS and four existing mjs files retained byte-for-byte. The component has independent metadata, lockfile, tests and packaging. In `.rotom.1`, worker/scout/reviewer declare empty ambient extensions and fresh default context without expanding tools; explicit user/project overrides remain effective. `.rotom.3` explicitly loads the verified product Qoder provider for Qoder child models, preserving ambient isolation, tool ceilings, model choice and launch identity. Other custom providers still require explicit child configuration. Offline CLI/RPC coverage does not claim live inference acceptance.

The former `pi-subagents-0.52.1-rotom.0.tgz` and `pi-subagents-0.52.1-dev-agent-followthrough.2.tgz` remain **maintenance-only historical evidence** in the repository. It is neither the selected product archive nor included in new product packages. Historical patch comparisons verify and extract that original archive rather than assuming the currently installed default is still `.2`.

`package.json` keeps the exact version. `package-lock.json` resolves it to the relative archive. `runtime/product-config.mjs` pins source and integrity; build-time checks and locked npm ci verify archives. Vendor tgz are build inputs only and omitted from product packages. Startup checks installed package identity/capabilities, not installed file integrity. For a fresh source maintenance installation use `npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never`, not `npm install` (which may resolve the custom version from a registry). **Do not run npm ci over a directory still used by live sessions.** Use a fresh product/prefix and leave the old files intact. Artifact users need no second extension installation: the locked dependencies are included.

Do not use `--replace-registry-host=always`: npm 11 rewrites even local archive URLs into registry URLs. The product launcher now selects `owned-process-groups-v2` for new sessions and anchors its store under `~/.local/state/rotom/subagent-store`; see `node_modules/pi-subagents/docs/owned-execution.md` for the admitted topologies. That default neither migrates live sessions nor authorizes replay, and unknown ownership remains fenced. Unselected upstream tools/templates/skills remain disabled by product policy.

The `.rotom.5` baseline also included the terminal-projection fix: projection failure preserves unknown and observed closure evidence, never authorizing replay. It is subsequent development and is **not** included in the already frozen rotom 0.1.17 artifact. Component unit/SDK/type checks and current product gates are separate from the unavailable historical `test:compat` discovery path documented in the component README.

## Locked Computer Use distribution

The default product selects **`@injaneity/pi-computer-use@0.5.1-rotom.1`**, independently maintained in `packages/rotom-computer-use/`. This is a Computer Use fork, not a Pi fork.

- Archive: `injaneity-pi-computer-use-0.5.1-rotom.1.tgz`
- SHA512 SRI: `sha512-gAGchi9F4Ha9H+xo7XLeFktVxoNnhKh3Z2QrdmoujKQgUgyge/mrcisBTXzMs+W9fNkulNCowvQteB7QrEZxsA==`
- Upstream: `@injaneity/pi-computer-use`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Adds bounded IDEA background text via exact window/ref binding, synthetic internal focus and per-character full readback. Accepted AX writes without matching readback are unknown, never a reason to replay. Batches stop on unknown as well as refusal. Legacy speculative foreground retry remains off by default and unavailable in headless mode.
- macOS arm64/x64/universal artifacts are rebuilt and **ad-hoc signed**; Windows/Linux artifacts are unchanged. Replacing an existing helper with the ad-hoc bundle needs explicit authorization. Protocol 7 mismatch no longer restarts another session's daemon. No personal certificate signatures are shipped.
- Rebuilt arm64 code passed bounded real-plugin input checks using an isolated, separately signed helper. Installed upgrade, final-version concurrent input, x64 execution and Swift deterministic assertions remain unverified. See [verification and limits](../../../../docs/agent/computer-use-background-text.md).

## Locked Goal distribution

`.rotom.8` exposes host recovery and durable stop causes, pauses exhausted provider recovery, and supports explicit idle-active resume without replay. Recovery remains Pi-owned; threshold compaction cannot erase a pending failure. Managed-run events add optional activity fields. Existing installations are not modified in place; see the component README for compatibility and offline verification limits.


The default product selects **`@narumitw/pi-goal@0.54.4-rotom.8`**, independently maintained in `packages/rotom-goal/`. This is a Goal fork, not a Pi fork.

- Archive: `narumitw-pi-goal-0.54.4-rotom.8.tgz`
- SHA512 SRI: `sha512-nEQhj4obyLpYRUUpqZF9co8UeX7Jc1iPKrI0D3hSMW9cEXDrIzv+ZnrhGWqwyWWk4GB7cZ7NzO5LAjC5uNTI8g==`
- `.rotom.7` removes virtual-model reviewer adaptation alongside Pi's classifier/router removal; reviews use the selected ordinary model without another lookup or routing request. Versioned auxiliary usage accounting is retained.
- `.rotom.6` introduced Pi 1.0 tool/model/summary accounting and one-time legacy baseline migration. Its former virtual-model reviewer behavior is superseded by `.rotom.7`.
- `.rotom.5` changes the default automatic-response allowance to 100 (explicit settings win), displays remaining responses and persists the last accepted continuation plan for display only. No extra summary request, replay permission or guard relaxation is added.
- Upstream: `@narumitw/pi-goal`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source baseline: upstream `0.54.4` source tree (22 TS files), absorbing its stable system-prefix caching, budget-stop, transient-wait quiet retry and stable tool schemas. Entry is `./src/index.ts` (the `0.52.1`-style src entry) because upstream `0.54.4` ships a bundled `dist/index.ts` whose esbuild build script is not in the tarball. The existing `@narumitw/pi-tui-kit` dependency is loaded lazily for menus. `.rotom.1` adds default explicit `goal_continue` and a bounded file-only completion reviewer through the selected provider's public registry API, without a nested AgentSession. Attempts, unknown/no-replay, mixed-batch rejection and reported review token budgets are session-bound; see the component README/UPSTREAM for limits. `.rotom.2` makes the review request explicit outside its untrusted JSON payload after Ultimate live evaluation exposed missing verdict markers; strict parsing and bounds remain unchanged. `.rotom.3` adds evidence-first clarification, immediate authorization/decision pauses through the existing missing-decision path, and evidence-driven retries without replaying unknown external writes. This is a prompt contract, not a permission interceptor; tools, state and reviewer limits are unchanged. `.rotom.4` separates the blocker threshold from useful work, permitting immediate pauses instead of futile attempts. Shared rejected-review guidance distinguishes defects from proof gaps and forbids repeating successful/unknown external writes for approval; the reviewer distinguishes procedural observations from unverified external effects. The old `.rotom.0`/`.rotom.1`/`.rotom.2`/`.rotom.3`/`.rotom.4` archives are maintenance-only, not selected or shipped. The original rotom change is in `src/safety.ts`: the no-progress guard now counts a repeat on identical observable behaviour (same visible text **and** same tool-call signature) so re-issuing the same failing tool call can no longer reset the guard forever; it only **pauses** (recoverable via `/goal resume`) and reduces byte-identically to the upstream tool-free fingerprint when no tool is called.

## Locked SoL-Pi distribution

The default product selects **`sol-pi@0.1.0-rotom.3`**, maintained in `packages/rotom-sol-pi/`. SoL-Pi has no npm release; this archive is packed from that directory.

- Archive: `sol-pi-0.1.0-rotom.3.tgz`
- SHA256: `bb352d13af8d51354aa1257277f81b4be377be95c4279dbe55e2300e152c98ab`
- SHA512 SRI: `sha512-0VdUzHtsICuHIp/Sp77Qem5snQH63PY/XbwxY8fLgweLlFM/uE65OnRhhHvQ9c0Wi0PWWUqGWMXlkqTkgqSntw==`
- `.rotom.3`: versioned `details.actionFusion` preserves applied mutations on failed/skipped follow-ups. Pi 1.3.0 dev baseline: typecheck passes, 166 tests pass; the 2 omitted upstream installation-guide fixtures still fail. Older hosts that ignore `isError` results are no longer supported.
- Upstream: <https://github.com/NVlabs/SoL-Pi>, License MIT (original notice in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source: the maintainer's branch `b463fad` (upstream `2b791687` plus five fix/compat commits). `.rotom.0` kept `src/` byte-identical. `.rotom.1` records each returned reducer response as a Pi `usage` entry (`sol_pi_reducer`) through the fork's `pi.appendUsage`, so the footer, session stats and Goal budgets include reducer spend; see `UPSTREAM.md`. `.rotom.2` adds a content-free `quoteDiagnostic` (cause, index, length, SHA-256, matched prefix and line, ANSI/whitespace near-match flags) to `unverifiable-quote` journal entries; acceptance is unchanged. The `.rotom.0` (rotom 0.1.24) and `.rotom.1` (rotom 0.1.25) archives are removed here.
- Tests: `.rotom.2` passes upstream's suite plus the rotom usage and quote-diagnostic tests, 168/168, against both the Pi `1.3.0-rotom.2` packages and the pinned upstream Pi `0.85.1` devDependencies (`.rotom.1`: 167/167; `.rotom.0`: 166/166 on `1.3.0-rotom.1`). In `packages/rotom-sol-pi/` itself, the 2 `tests/install-guide.test.ts` cases fail because they read the non-imported upstream `AGENTS.md`/`CLAUDE.md`.
- `extensions/third-party/sol-pi.ts` supplies rotom's default (Action Fusion, Observation Pack, Evidence-Preserving Reducer on; Online Context Compact off) only when no SoL-Pi config file exists.

`pi-context-view@0.7.1` is taken unmodified from the public npm registry and pinned by its registry integrity in `package-lock.json` and `runtime/product-config.mjs`.

All vendored archives: `package.json` keeps the exact version, `package-lock.json` resolves it to the relative archive, and `runtime/product-config.mjs` pins version + integrity; build-time checks and locked npm ci verify archives, which are not duplicated in the product package. Use the same fresh-prefix `npm ci` guidance above; **do not run npm ci over a directory still used by live sessions.**

No npm publication is authorized. Archive scanning and local process tests are not exhaustive security, arbitrary-descendant closure or business-effect verification.
