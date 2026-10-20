# Upstream provenance — @injaneity/pi-computer-use (rotom fork)

This is a rotom-maintained fork, not an upstream release.

- Upstream baseline: `@injaneity/pi-computer-use` **0.5.1** (MIT; original `LICENSE` retained).
- Fork version: **0.5.1-rotom.1**.
- Windows and Linux native artifacts remain byte-for-byte from upstream 0.5.1.
- macOS arm64, x64 and universal helper artifacts are now rebuilt from this source tree and **ad-hoc signed**, not Developer ID signed or notarized.

## Source provenance

The 0.5.1 npm tarball omitted `agent_cursor.swift` and `agent_cursor_motion.swift` even though its builder requires them. These files were restored from upstream tag `v0.5.1`, commit `4b8dbd7eaa13328ab1a8a4b55d0be0b077de7d62` (MIT). All macOS Swift sources are included in this package.

`background_text.swift` is rotom code. Its synthetic key-window record layout follows the MIT [open-computer-use background keyboard research](https://github.com/iFurySt/open-computer-use/blob/main/docs/references/macos-skylight-background-keyboard.md). Private SkyLight symbols are resolved at runtime; missing symbols disable this input route rather than enabling a foreground fallback.

## rotom changes

### Background IDEA text input

macOS headless single actions and batches select `background_text`. Only ref-bound `setText` / `typeText` in `com.jetbrains.intellij` use the new native route, selected **before any AXValue write**. Other applications retain their existing input paths; this change does not add general background clicks, menus or shortcuts.

The route requires an exact native window ID and owner PID, a readable non-secure text field and selection, an onscreen window, and a non-hidden app. It synthesizes the target's internal key window, sets and verifies the AX selection, then posts directed keys one at a time. It verifies the entire field and insertion point before continuing. It does not activate/raise the app, post global HID input, use the clipboard, send Cmd+A, or replay an unknown write.

Supported replacement text is printable ASCII, at most 256 characters. The input wait budget is eight seconds, with at most two seconds of readback waiting per character. Unsupported text is rejected before sending characters. Partial delivery, focus loss or failed readback returns `unknown`. Batches stop on both `didnt` and `unknown`. Empty setText uses one Delete event on the verified whole-field selection.

This is not a guarantee that an application can never activate itself. Foreground/focus checks stop further typing after a detected change; they do not provide OS-level input isolation. IME input, long-running concurrent typing, hidden/minimized windows, other apps and non-text actions are not covered.

### No speculative foreground replay

`canRetryInForeground` remains disabled by default. The legacy explicit `ROTOM_CU_SPECULATIVE_FOREGROUND_RETRY=1` opt-in remains for non-headless upstream behavior; headless never uses it. An **accepted AXValue write with mismatching readback** now returns `unknown`, not `foreground_required`: absence of immediate readback is not proof of non-execution.

### Helper lifecycle and signing

The macOS native protocol is now 7. A protocol/executable mismatch no longer automatically stops and relaunches a daemon potentially owned by another session. Close the owning sessions and explicitly update/restart the helper, or use a separate helper app and socket.

The installer refuses to replace an existing helper with the bundled ad-hoc app unless `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` is explicitly supplied. This can require macOS permission review and does not override system execution policy. No personal development-certificate signatures are included in the public archive. Local live tests used a separately signed copy, without changing the installed helper.

## Rebuilding the archive

From this package directory, restore only the unchanged Windows/Linux artifacts from the pinned archive, then rebuild every macOS artifact:

```sh
tar xzf ../../rotom/extensions/third-party/vendor/injaneity-pi-computer-use-0.5.1-rotom.1.tgz \
  --strip-components=1 package/prebuilt/windows package/prebuilt/linux
node scripts/build-native.mjs --arch all --sign-identity -
npm pack --ignore-scripts
```

`--arch all` also rebuilds the universal app preferred by the installer. Do not retain an older signed universal app beside new per-arch executables. Update the vendored tgz, third-party lock and product integrity pin together. `pack:release` never repacks this source automatically.

## Verification and remaining limits

- Node focused regressions cover no implicit foreground retry and accepting the matching helper/rejecting mismatches without restarting another session's daemon.
- Current native source compiled for arm64 and x64; universal app signature and architecture checks passed. x64 was not run on hardware.
- The rebuilt arm64 helper, with a separate user-authorized development signature, passed real MaxCompute Entity Name replacement, append, explicit Chinese-text refusal, clearing, final readback and batch-stop-on-refusal checks. No Enter/OK/business submission was sent.
- The Swift deterministic regression program compiled, but this machine's execution policy still rejected that test executable. Its assertions are not reported as passed. Earlier helper startup rejection stopped reproducing on an explicit retry; the reason was not established.
- Earlier P0 frontend-sentinel tests used a temporary probe, not this final artifact. They do not prove final-version concurrent-input isolation. This change has not replaced the user's active helper or been npm-published.

Full maintenance status: [background-text verification](https://github.com/bingjiang0611/rotom/blob/main/docs/agent/computer-use-background-text.md).
