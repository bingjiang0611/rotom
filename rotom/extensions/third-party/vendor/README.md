# Locked Subagent distribution

The default product selects **`pi-subagents@0.52.1-rotom.15`**, independently maintained in the repository's `packages/rotom-subagents/`. New builds consume its reviewed archive, not installed source or a patch stack. This is a Subagent fork, not a Pi fork.

- Archive: `pi-subagents-0.52.1-rotom.15.tgz`
- SHA256: `75d54d674731b6cb9be1b296acb12582ffc02abe2bda370a308494483e5c9314`
- SHA512 SRI: `sha512-44hMxgbrF7zFfJMjZJCsFuR9HtoSFjyqiDjK7mB8Sz1ci4Dlb9kT7YJyyo/QvnFVYFYREuzvGHkRgHj6Ndrstg==`
- Source digest: `14eaa5df802760128842d367c86bf0b1c365f0bde958eff423ed577a26d2bef5`

`.rotom.15` blocks `share` (GitHub Gist upload) and `sessionDir` on the product surface, makes the builtin `scout` read-only with no default output file, bounds completion notices at 8 KB with the full text in a private store file kept for seven days, and shortens blocking `subagent_wait` to a 10-minute default and 15-minute cap. `.rotom.14` loads the product browser extension for children that request browser tools. `.rotom.12` extends store device-topology checks across restarts to all POSIX platforms.

`.rotom.11` owns the explicitly selected ephemeral tool surface and evidence projection. Product wrappers retain only host publication fencing and product command/shortcut selection; standalone defaults remain unchanged.

`.rotom.10` makes the builtin roles launchable in owned scope: `delegate` and `oracle`/`advisor` declare empty ambient extensions and fresh default context (oracle now works from a parent-written decision brief), `reviewer` gains prompt-restricted read-only `bash`, and `researcher` is removed because its web tools do not exist in rotom. `.rotom.9` pauses the retiring runtime's live runners and awaits close finalization before cleanup on quit/reload/session replacement/disposal. A result arriving before the native close callback retains pending only while this process owns the matching live observer; registration is not an exit proof. It never signals historical PIDs or repairs missing old-run proof. Retired schedule execution and automatic goal-mission continuation remain disabled, including legacy opt-out sessions; old data remains untouched. Targeted status uses bounded current-session output and native recovery preflight, which is not launch authorization. Shared legacy mission/inspector readers remain. The product selects the native ephemeral schema and prompt guidance; raw execution still passes the original fences.
- Upstream: <https://github.com/nicobailon/pi-subagents>
- License: MIT, Copyright (c) 2026 Nico Bailon. Original notice remains in `package/LICENSE`; provenance and maintenance notes are in `package/UPSTREAM.md`.
- Source baseline: validated `0.52.1-dev-agent-owned-flat.7`; 213 TS and four existing mjs files retained byte-for-byte. The component has independent metadata, lockfile, tests and packaging. In `.rotom.1`, worker/scout/reviewer declare empty ambient extensions and fresh default context without expanding tools; explicit user/project overrides remain effective. `.rotom.3` explicitly loads the verified product Qoder provider for Qoder child models, preserving ambient isolation, tool ceilings, model choice and launch identity. Other custom providers still require explicit child configuration. Offline CLI/RPC coverage does not claim live inference acceptance.

The former `pi-subagents-0.52.1-rotom.0.tgz` and `pi-subagents-0.52.1-dev-agent-followthrough.2.tgz` remain **maintenance-only historical evidence** in the repository. It is neither the selected product archive nor included in new product packages. Historical patch comparisons verify and extract that original archive rather than assuming the currently installed default is still `.2`.

`package.json` keeps the exact version. `package-lock.json` resolves it to the relative archive. `runtime/product-config.mjs` pins source and integrity; build-time checks and locked npm ci verify archives. Vendor tgz are build inputs only and omitted from product packages. Startup checks installed package identity/capabilities, not installed file integrity. For a fresh source maintenance installation use `npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never`, not `npm install` (which may resolve the custom version from a registry). **Do not run npm ci over a directory still used by live sessions.** Use a fresh product/prefix and leave the old files intact. Artifact users need no second extension installation: the locked dependencies are included.

Do not use `--replace-registry-host=always`: npm 11 rewrites even local archive URLs into registry URLs. The product launcher now selects `owned-process-groups-v2` for new sessions and anchors its store under `~/.local/state/rotom/subagent-store`; see `node_modules/pi-subagents/docs/owned-execution.md` for the admitted topologies. That default neither migrates live sessions nor authorizes replay, and unknown ownership remains fenced. Unselected upstream tools/templates/skills remain disabled by product policy.

The `.rotom.5` baseline also included the terminal-projection fix: projection failure preserves unknown and observed closure evidence, never authorizing replay. It is subsequent development and is **not** included in the already frozen rotom 0.1.17 artifact. Component unit/SDK/type checks and current product gates are separate from the unavailable historical `test:compat` discovery path documented in the component README.

## Locked Computer Use distribution

The default product selects **`@injaneity/pi-computer-use@0.5.1-rotom.3`**, independently maintained in `packages/rotom-computer-use/`. This is a Computer Use fork, not a Pi fork.

- Archive: `injaneity-pi-computer-use-0.5.1-rotom.3.tgz`
- SHA256: `9e8d92720ad329ec8a804bf4e084dbbd0669bdbf5b85c31715dd93275841d114`
- SHA512 SRI: `sha512-ajoDLEVK85uW+gkpSd6feVrv+uw4foxn4web8WUn5fVkOcYe62T6IJwjroyMj4lYEPJGmI1u2dk3wcQoBREvLw==`
- `.rotom.3` restores source/archive agreement for the v2 tool registrations, broker, policy and trace implementation. All macOS helpers are rebuilt and ad-hoc signed for protocol 8; Windows/Linux artifacts are unchanged. This packaging update does not replace or restart an active helper.
- `.rotom.2` moves schema descriptions, recovery and result evidence into the component. Relay-first browser fallback stays product-specific. This TS-only rebuild retains all prior native helper bytes and signatures; no helper is installed or launched.
- Upstream: `@injaneity/pi-computer-use`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Adds bounded IDEA background text via exact window/ref binding, synthetic internal focus and per-character full readback. Accepted AX writes without matching readback are unknown, never a reason to replay. Batches stop on unknown as well as refusal. Legacy speculative foreground retry remains off by default and unavailable in headless mode.
- macOS arm64/x64/universal artifacts are rebuilt and **ad-hoc signed**; Windows/Linux artifacts are unchanged. Replacing an existing helper with the ad-hoc bundle needs explicit authorization. Protocol 8 mismatch no longer restarts another session's daemon. No personal certificate signatures are shipped.
- Earlier background-text arm64 artifacts passed bounded real-plugin checks using an isolated, separately signed helper. Those checks do not validate the rebuilt `.rotom.3` helpers or live v2 app/window management, clipboard, system-surface and L2 actions. Active-helper upgrade, final-version concurrent input, x64 execution and Swift deterministic assertions remain unverified. See [verification and limits](../../../../docs/agent/computer-use-background-text.md).

## Locked Goal distribution

`.rotom.10` makes active Goal runs continue automatically when no terminal control is selected. `goal_continue` remains an optional stable schema for carrying untrusted `next_action` planning data and may share a batch with ordinary tools. The default response-count limit is Unlimited; explicit numeric limits remain effective. Three empty automatic runs pause, while repeated identical behavior receives one change-approach prompt before a later threshold pauses. Missing user-owned decisions can use the optional `goal_blocked.needs_user_decision` field. Restored active non-waiting goals default to one fresh continuation without replaying saved plans or tools. Exhausted provider recovery schedules fresh continuations after 5, 15 and 30 minute waits before the fourth exhaustion pauses; tool calls are never replayed. Completion-review unknown results do not replay the same candidate, but a genuinely new candidate may use the remaining allowance. Repeated candidates still return a rejection without review; a new candidate after the attempt or reported-token allowance is exhausted pauses with `review_exhausted` for manual acceptance and explicit clear/resume handling. Reviewer bounds are unchanged. External-write no-replay is unchanged. `.rotom.9` keeps an inactive Goal contract immediately after a compaction summary instead of appending it as the newest message. Existing installations are not modified in place; see the component README for compatibility and deterministic verification limits.

The default product selects **`@narumitw/pi-goal@0.54.4-rotom.10`**, independently maintained in `packages/rotom-goal/`. This is a Goal fork, not a Pi fork.

- Archive: `narumitw-pi-goal-0.54.4-rotom.10.tgz`
- SHA256: `d0844a69343bb6e82d326b5586d20638e114606b3ec5080737987dd82e79ec9a`
- SHA512 SRI: `sha512-znlWRFG72CgDIkGWdjS81MEIqL/yVP2/tTldL6X1oBTMyCnogFa5FGvn3W6BX4Dpj1NsOro9avGS/D5vgpogFg==`
- Upstream: `@narumitw/pi-goal`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source baseline: upstream `0.54.4` source tree (22 TS files), absorbing its stable system-prefix caching, budget-stop, transient-wait quiet retry and stable tool schemas. Entry is `./src/index.ts` because upstream's tarball omits the bundler script needed to reproduce `dist/index.ts`; menus lazily load the existing `@narumitw/pi-tui-kit` dependency. The fork adds automatic continuation, deterministic safety guards, a bounded selected-model file-only completion reviewer, session-bound attempts/usage, and read-only handling of unknown external effects. Historical change details and limits are in `packages/rotom-goal/UPSTREAM.md`. Older Goal archives remain maintenance-only and are not selected by the product.

## Locked SoL-Pi distribution

The default product selects **`sol-pi@0.1.0-rotom.6`**, maintained in `packages/rotom-sol-pi/`. SoL-Pi has no npm release; this archive is packed from that directory.

- Archive: `sol-pi-0.1.0-rotom.6.tgz`
- SHA256: `7e22fea51f5c94b31e46a0d4c06f003bf9f077ea42bb6c96977e8dc3a74cd618`
- SHA512 SRI: `sha512-Zg+2NTOEsvOdgI3ANpUXiuvYe0jJ1F4F93YXd3y56d4UQj6Q8p9pSQ+Cf3x/qv2ecaEai7UyQTEQ1XAjVHMvjg==`
- `.rotom.6`: terminal `obs_recall` text cursors are `null` at EOF, with explicit stop instructions. Numeric persisted byte-end metadata stays unchanged; old EOF pages remain intact. A sanitized text-only pagination regression fails on the old implementation and passes with the fix; no live-model A/B was run.
- `.rotom.5`: calibrates defer estimates with the chars/4 savings fraction of the projected context; threshold decisions expose metadata-only counts, bytes and native reasons. The 0.6 target and default-off behavior remain unchanged; no real-model benefit is claimed.
- `.rotom.4`: default-off Compaction Offload requires Observation Pack, preserves recall before persisting metadata, treats append failures as unknown, and keeps observation failures independent of deferral; projection checks are cached until session start/tree changes.
- Tests: `.rotom.6` on pinned npm Pi `1.3.0`: typecheck passes, 211 tests pass, only the 2 known omitted install-guide fixtures fail. Archive: 37 files, 54411 bytes compressed / 184910 bytes unpacked. The superseded `.rotom.5` archive is removed.
- `.rotom.3`: versioned `details.actionFusion` preserves applied mutations on failed/skipped follow-ups. Pi 1.3.0 dev baseline: typecheck passes, 166 tests pass; the 2 omitted upstream installation-guide fixtures still fail. Older hosts that ignore `isError` results are no longer supported.
- Upstream: <https://github.com/NVlabs/SoL-Pi>, License MIT (original notice in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source: the maintainer's branch `b463fad` (upstream `2b791687` plus five fix/compat commits). `.rotom.0` kept `src/` byte-identical. `.rotom.1` records each returned reducer response as a Pi `usage` entry (`sol_pi_reducer`) through the fork's `pi.appendUsage`, so the footer, session stats and Goal budgets include reducer spend; see `UPSTREAM.md`. `.rotom.2` adds a content-free `quoteDiagnostic` (cause, index, length, SHA-256, matched prefix and line, ANSI/whitespace near-match flags) to `unverifiable-quote` journal entries; acceptance is unchanged. The `.rotom.0` (rotom 0.1.24) and `.rotom.1` (rotom 0.1.25) archives are removed here.
- Tests: `.rotom.2` passes upstream's suite plus the rotom usage and quote-diagnostic tests, 168/168, against both the Pi `1.3.0-rotom.2` packages and the pinned upstream Pi `0.85.1` devDependencies (`.rotom.1`: 167/167; `.rotom.0`: 166/166 on `1.3.0-rotom.1`). In `packages/rotom-sol-pi/` itself, the 2 `tests/install-guide.test.ts` cases fail because they read the non-imported upstream `AGENTS.md`/`CLAUDE.md`.
- `extensions/third-party/sol-pi.ts` supplies rotom's default (Action Fusion, Observation Pack, Evidence-Preserving Reducer and Compaction Offload on; only Online Context Compact off) only when no SoL-Pi config file exists; `ROTOM_COMPACTION_OFFLOAD=1|0` overrides the latter after config loading, with Observation Pack required.

`pi-context-view@0.7.1` is taken unmodified from the public npm registry and pinned by its registry integrity in `package-lock.json` and `runtime/product-config.mjs`.

All vendored archives: `package.json` keeps the exact version, `package-lock.json` resolves it to the relative archive, and `runtime/product-config.mjs` pins version + integrity; build-time checks and locked npm ci verify archives, which are not duplicated in the product package. Use the same fresh-prefix `npm ci` guidance above; **do not run npm ci over a directory still used by live sessions.**

No npm publication is authorized. Archive scanning and local process tests are not exhaustive security, arbitrary-descendant closure or business-effect verification.
