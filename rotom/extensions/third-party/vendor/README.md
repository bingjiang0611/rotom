# Locked Subagent distribution

The default product selects **`pi-subagents@0.52.1-rotom.2`**, independently maintained in the repository's `packages/rotom-subagents/`. New builds consume its reviewed archive, not installed source or a patch stack. This is a Subagent fork, not a Pi fork.

- Archive: `pi-subagents-0.52.1-rotom.2.tgz`
- SHA256: `23c92eeaf0d4c7a3be7d3ce925e542f5c413f3c162778de855bb90a33ff3727f`
- SHA512 SRI: `sha512-rwGayYsZUxd/IY/G7nfU29IicL5RJGVeFcBd6UJoukb6cHI3XZBPPE+Iyft6vlj+J3JuD/HjCjuwGIS2ZB++KA==`
- Upstream: <https://github.com/nicobailon/pi-subagents>
- License: MIT, Copyright (c) 2026 Nico Bailon. Original notice remains in `package/LICENSE`; provenance and maintenance notes are in `package/UPSTREAM.md`.
- Source baseline: validated `0.52.1-dev-agent-owned-flat.7`; 213 TS and four existing mjs files retained byte-for-byte. The component has independent metadata, lockfile, tests and packaging. In `.rotom.1`, worker/scout/reviewer declare empty ambient extensions and fresh default context without expanding tools; explicit user/project overrides remain effective.

The former `pi-subagents-0.52.1-rotom.0.tgz` and `pi-subagents-0.52.1-dev-agent-followthrough.2.tgz` remain **maintenance-only historical evidence** in the repository. It is neither the selected product archive nor included in new product packages. Historical patch comparisons verify and extract that original archive rather than assuming the currently installed default is still `.2`.

`package.json` keeps the exact version. `package-lock.json` resolves it to the relative archive. `runtime/product-config.mjs` pins source and integrity; the launcher rejects missing, linked, changed or mismatched archives. For a fresh source maintenance installation use `npm ci --ignore-scripts --omit=optional --legacy-peer-deps --replace-registry-host=never`, not `npm install` (which may resolve the custom version from a registry). **Do not run npm ci over a directory still used by live sessions.** Use a fresh product/prefix and leave the old files intact. Artifact users need no second extension installation: the locked dependencies are included.

Do not use `--replace-registry-host=always`: npm 11 rewrites even local archive URLs into registry URLs. The product launcher now selects `owned-process-groups-v2` for new sessions and anchors its store under `~/.local/state/rotom/subagent-store`; see `node_modules/pi-subagents/docs/owned-execution.md` for the admitted topologies. That default neither migrates live sessions nor authorizes replay, and unknown ownership remains fenced. Unselected upstream tools/templates/skills remain disabled by product policy.

## Locked Computer Use distribution

The default product selects **`@injaneity/pi-computer-use@0.5.1-rotom.0`**, independently maintained in `packages/rotom-computer-use/`. This is a Computer Use fork, not a Pi fork.

- Archive: `injaneity-pi-computer-use-0.5.1-rotom.0.tgz`
- SHA512 SRI: `sha512-CNmDZatjUImvODkmVUZPMTx/exzojHdDNZGXSqk9yqpAtR54lnaUULbPvBtrqunhZnee+mGJwQW2wVkLVTEDtw==`
- Upstream: `@injaneity/pi-computer-use`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source baseline: upstream `0.5.1` tarball extracted byte-for-byte (77 files incl. the prebuilt macOS/Windows/Linux native bridge binaries and Swift/Rust native source), absorbing the `0.5.1` window-selection fix (`src/root-selection.ts`). Native code is unchanged and was not recompiled or re-signed. The only change is in `src/actions.ts`: the speculative `typeText`/`keypress` foreground re-dispatch is disabled by default to avoid replaying already-delivered input (`ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY=1` restores upstream). The explicit `foreground_required` escalation path is unchanged. That desktop behaviour is L1-only here; real-device effect is unverified.

## Locked Goal distribution

The default product selects **`@narumitw/pi-goal@0.54.4-rotom.0`**, independently maintained in `packages/rotom-goal/`. This is a Goal fork, not a Pi fork.

- Archive: `narumitw-pi-goal-0.54.4-rotom.0.tgz`
- SHA512 SRI: `sha512-QhEGtXm5jnkGSuTy2wXUCUE1h3tya3GTTZlJr00HFQdckX2Vd37emUGCAw4HGK1PaV1cpZHKL/Ym/+bsvQ4a1A==`
- Upstream: `@narumitw/pi-goal`, License MIT (original notice retained in `package/LICENSE`; provenance in `package/UPSTREAM.md`).
- Source baseline: upstream `0.54.4` source tree (22 TS files), absorbing its stable system-prefix caching, budget-stop, transient-wait quiet retry and stable tool schemas. Entry is `./src/index.ts` (the `0.52.1`-style src entry) because upstream `0.54.4` ships a bundled `dist/index.ts` whose esbuild build script is not in the tarball. `@narumitw/pi-tui-kit` is a type-only import, erased at load. The rotom change is in `src/safety.ts`: the no-progress guard now counts a repeat on identical observable behaviour (same visible text **and** same tool-call signature) so re-issuing the same failing tool call can no longer reset the guard forever; it only **pauses** (recoverable via `/goal resume`) and reduces byte-identically to the upstream tool-free fingerprint when no tool is called.

Both forks: `package.json` keeps the exact version, `package-lock.json` resolves it to the relative archive, and `runtime/product-config.mjs` pins version + integrity; the launcher rejects missing, linked, changed or mismatched archives. Use the same fresh-prefix `npm ci` guidance above; **do not run npm ci over a directory still used by live sessions.**

No npm publication is authorized. Archive scanning and local process tests are not exhaustive security, arbitrary-descendant closure or business-effect verification.
