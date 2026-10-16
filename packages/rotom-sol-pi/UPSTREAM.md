# Upstream provenance — rotom SoL-Pi

- Upstream: SoL-Pi, <https://github.com/NVlabs/SoL-Pi>. License: MIT, Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES; the original notice stays in `LICENSE`.
- Upstream base: `2b791687` ("Update Pi to 0.85.1 and verify 0.84.2 compatibility (#63)").
- Source: the maintainer's SoL-Pi branch at `b463fad0ffab6e42488f5c80687adab67174a0ee`, imported from its tracked files. On top of the upstream base it carries five commits: recalled pages keep source references (`81b80b0`), the Pi 0.85 compaction-reason test (`83c5426`), the 0.85.1 baseline merge (`807ad60`), selected upstream reliability backports (`32840b2`), and Pi error-result handling plus runtime compatibility repairs (`b463fad`).
- Maintained version: `0.1.0-rotom.1`, a private component of [rotom](https://github.com/bingjiang0611/rotom). It is not an upstream or npm release.

## Changes in this import

- `package.json` / `package-lock.json`: version `0.1.0-rotom.1`, rotom description, `UPSTREAM.md` added to and the hero image removed from the packed files.
- Not imported: `.github/`, `AGENTS.md`, `CLAUDE.md`, `.gitattributes` and `assets/` (the README hero image link is therefore broken in this copy).
- `src/` and `tests/` were byte-identical to the source commit in `0.1.0-rotom.0`.

## rotom changes

- `0.1.0-rotom.1`: the Evidence-Preserving Reducer records each returned reducer response (applied or rejected) as a Pi `usage` entry of kind `sol_pi_reducer`, attributed to the reducer provider/model with the provider-reported usage unchanged. Pi's footer, session stats, usage breakdown and Goal budgets then include the reducer spend. It uses `pi.appendUsage`, which the rotom Pi fork exposes from `1.3.0-rotom.2`; on Pi releases without it (upstream Pi) only the SoL-Pi journal entry is written, as before. Calls that throw before a response (timeout, unavailable model, missing auth) record no usage. Files: `evidence-preserving-reducer/{provider,journal,index}.ts`, `tests/helpers.ts`, `tests/evidence-preserving-reducer.test.ts`.
- `0.1.0-rotom.2`: an `unverifiable-quote` fallback journal entry now carries a `quoteDiagnostic` for the first rejected evidence item: `cause` (`invalid-kind`, `not-a-string`, `empty`, `too-long` or `not-in-source`), its index and the evidence count, the quote length and SHA-256, and for `not-in-source` the longest leading part found in the log with its line, plus whether the quote would match after removing ANSI escapes or collapsing whitespace. It never stores quote or log text. Acceptance is unchanged: a receipt is still rejected unless every quote appears byte for byte. Files: `evidence-preserving-reducer/{receipt,index}.ts`, `tests/evidence-preserving-reducer.test.ts`.

## How rotom uses it

rotom loads SoL-Pi from the third-party composition root (`rotom/extensions/third-party/sol-pi.ts`). The SoL-Pi loader is unchanged: a project `.pi/sol-pi.json` (trusted projects only) or `~/.pi/agent/sol-pi.json` wins. Only when neither file exists does rotom supply its own default instead of SoL-Pi's all-off default: Action Fusion, Observation Pack and the Evidence-Preserving Reducer on, Online Context Compact off.

## Verification

`npm ci && npm run typecheck && npm test` runs the upstream suite against the Pi `0.85.1` devDependencies pinned in `package-lock.json`, not against rotom's Pi fork. Compatibility with the rotom Pi fork is covered by rotom's own runtime tests and smoke runs.
