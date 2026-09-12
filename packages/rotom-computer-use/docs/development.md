# Development — rotom maintenance copy

This is the private rotom fork, not a complete checkout of the upstream development repository. See [UPSTREAM.md](../UPSTREAM.md) for provenance, preserved native binaries, repacking and verification boundaries. Product delivery uses the pinned vendor archive; editing this directory does not update an installed rotom session.

## Repository layout

Paths below are relative to `packages/rotom-computer-use/`:

```text
extensions/computer-use.ts       Public Pi tool registration
src/bridge.ts                    Tool coordination and resource scheduling
src/actions.ts                   Action preparation and result reconciliation
src/runtime.ts                   Immutable state store and scheduler
src/state.ts                     Saved UI state ownership and restoration
src/view.ts                      Stable refs and successor views
src/outline.ts                   Outline queries and ref mapping
src/note.ts                      Disposable running-note generation
native/macos/bridge.swift        macOS helper source
native/windows/bridge-rs/        Windows helper source
native/linux/bridge-rs/          Linux helper source
scripts/build-native.mjs         Platform helper builder
scripts/setup-helper.mjs         Helper setup
test/                           Fork regression tests
```

## Available checks

From this package directory, with a Node version supporting native TypeScript stripping:

```sh
npm test
```

This runs the tracked `test/*.test.ts` regressions, currently the speculative foreground-retry gate. It does **not** run a full typecheck, schema/invariant suite or native desktop acceptance.

The inherited `typecheck` script references an absent `tsconfig.json`. The inherited `test:*` scripts reference upstream `scripts/check-*.mjs` files not included in this maintenance copy. Do not treat their presence in `package.json` as runnable validation or restore them merely to make a documentation command pass. The public snapshot retains the product composition tests in [`rotom/extensions/third-party/`](../../../rotom/extensions/third-party/); preflight their dependencies before running them.

## Architecture rules

- Keep the public tool surface small and state-scoped: observe, progressively query, then act from the same state.
- Cached queries bypass scheduling; live work is ordered per physical resource.
- Native helpers own grounding, preflight, delivery and verification.
- A dispatched write with `didnt` or `unknown` is not proven side-effect-free; the fork defaults to no speculative keyboard replay.
- Do not restore removed direct tools or use a second execution framework.

See [architecture](architecture.md) for the detailed contract.

## Native changes and release boundary

The fork preserves upstream prebuilt binaries byte-for-byte; ordinary TypeScript maintenance does not rebuild or re-sign them. Repacking instructions restore those binaries from the committed archive, not an arbitrary local build.

The tracked builder is exposed as `npm run build:native`, `npm run build:windows`, and `npm run build:linux`. These require the respective platform toolchain; their existence is not native validation evidence. Helper installation, OS permissions and live desktop tests need separate authorization. macOS requires macOS 14+; ad-hoc signing does not preserve a release signing identity.

Upstream Cubench adapters, live-check scripts, signing-certificate scripts and GitHub release workflows are **not included here**. There is no supported local `test:linux-live`/Cubench or tag-to-npm release procedure in this copy. Do not publish this private package or claim cross-platform acceptance from the focused Node tests. See [product installation](../../../rotom/README.md) for the current entrypoint. The public snapshot omits the root release-audit scripts required by the product packer; it is not a self-contained release workspace.
