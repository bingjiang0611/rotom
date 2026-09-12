# Upstream provenance — @injaneity/pi-computer-use (rotom fork)

This package is a rotom-maintained fork of the third-party Pi extension
`@injaneity/pi-computer-use`. It is not a Pi fork and not an upstream release.

- Upstream package: `@injaneity/pi-computer-use`
- License: MIT (original notice retained in `LICENSE`)
- Fork baseline: **upstream `0.5.1`** tarball, extracted byte-for-byte (76 files,
  including the prebuilt macOS/Windows/Linux native bridge binaries, Swift/Rust
  native source, and helper/build scripts) except the change listed below.
- Fork version: `0.5.1-rotom.0`

## Why 0.5.1 as the baseline

The previously shipped product baseline was `0.5.0`. `0.5.1` was reviewed and
absorbed for its window-selection improvement (`src/root-selection.ts`,
`scoreWindow` / `shouldPreferForegroundModalWindow`): it avoids letting a
background modal window hijack the current target when resolving the controllable
root, which reduces mis-targeted observations/clicks.

## Native binaries preserved

The prebuilt native binaries and native source are copied verbatim from the
0.5.1 tarball; no native code was modified and nothing was recompiled or
re-signed by this fork. The only change is in TypeScript.

## rotom change on top of 0.5.1

### `src/actions.ts` — speculative foreground retry disabled by default

Upstream, after a background `typeText`/`keypress` attempt returns the `didnt`
outcome, `canRetryInForeground(...)` returns `true` and `helperAct`
(`src/bridge.ts`, escalation reason `side_effect_free_didnt`) automatically
re-dispatches the same input in the foreground.

The problem: the keyboard events were **already delivered once** in the
background attempt. A `didnt` outcome here only means "no observed value change"
within the short post-input read window (`outcomeAfterObservedValues` /
`outcomeAfterCheck`). With asynchronous editors, delayed accessibility updates,
or fields that debounce, the first input may still have taken effect, so an
automatic second dispatch can duplicate input. rotom's contract is to perform an
external write **once** and return `didnt`/`unknown` rather than silently replay
it, letting the model re-observe and decide.

The fork therefore makes `canRetryInForeground` return `false` by default. Set
`ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY=1` (or `true`/`yes`) to restore the
upstream behaviour.

The separate, explicit `foreground_required` escalation path in `helperAct`
(`src/bridge.ts`, where the native layer signalled that the background write was
**not** applied — e.g. web-content pointer requirements or a background AX value
write that was rejected) is intentionally **unchanged**: that path re-dispatches
a write the native layer proved did not land, so it does not risk duplication.

## Re-packing after a TypeScript change

The product ships the integrity-pinned vendored tgz, not this source tree, and
`pack:release` never repacks from `packages/`. The ~14MB prebuilt native
binaries are therefore gitignored here (they are carried byte-for-byte inside
the committed vendored tgz). To reproduce the artifact after editing the
TypeScript, restore the binaries from the committed tgz, then pack:

```sh
tar xzf ../../rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.0.tgz \
  --strip-components=1 -C . package/prebuilt
npm pack --ignore-scripts
```

Then update the integrity pin in `rotom/runtime/product-config.mjs` and
`rotom/extensions/third-party/package-lock.json`, and re-vendor the tgz.

## Verification boundary

Verified here (L1): `test/foreground-retry.test.ts` via `node --test` covers the
default-off gate, the opt-in env, and the headless/outcome/action-type guards.
End-to-end loading is covered by the product loader test in
`rotom/extensions/third-party/index.test.ts`.

**Not verified here (L2/L3):** the real macOS/Windows/Linux desktop behaviour of
suppressing the second dispatch (that a genuine background `didnt` no longer
double-types, and that legitimate cases still succeed via re-observation) can
only be confirmed on real hardware with the signed native helper and explicit
authorization. This change is L1-only in this environment. Native binaries were
not rebuilt or re-signed.
