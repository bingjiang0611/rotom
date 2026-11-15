# Computer Use broker cold start

## Failure and fix

On a fresh install, the broker socket directory may not exist. The client used that directory as the daemon's `cwd` before the daemon could create it. Node reports `spawn node ENOENT` even when the Node executable exists.

`spawnBrokerDaemon` now calls the existing `ensurePrivateDir` before spawning. Missing directories are created with mode `0700`; existing directory permissions are checked and corrected, and a symlinked directory is refused. The socket remains `0600`. Spawn errors still surface; this adds no retries or fallback.

## Verification

Verified on macOS arm64 / Node 24.18.0 against public baseline `9bb7bf6` and component `0.5.1-rotom.7`:

| Check | Result |
| --- | --- |
| New cold-start test with the baseline client | Fails with the same `spawn node ENOENT` as the report |
| `npm run typecheck` in `packages/rotom-computer-use` | Pass |
| `node --test --experimental-strip-types --test-concurrency=1 packages/rotom-computer-use/test/broker-socket.test.ts packages/rotom-computer-use/test/broker-packaged.test.ts` | 12 pass; includes missing nested directory, concurrent clients, private modes and symlink refusal |
| Isolated compiler/pretest controls (`typecheck-fatal.test.ts`, `typecheck-pretest.test.ts`) | 5 pass |
| `node --test --test-concurrency=1 rotom/runtime/third-party-archive.test.mjs rotom/runtime/distribution.test.mjs` | 40 pass |
| Clean product dependency installation with `npm ci --ignore-scripts --omit=optional --legacy-peer-deps` | Pass for both Pi and third-party runtimes |
| Actual installed `.7` archive loaded through Jiti, with an absent socket directory | Real daemon starts, handshake and lease acquire/release succeed; directory `0700`, socket `0600` |
| Compare `.6` and `.7` archives | Only README, provenance, package version and broker client differ; all 8 native files are identical |

Before push, public main advanced to `eaa2322` (Pi `1.5.2-rotom.1`). The fix was rebased onto it, preserving both the new Pi notices and Computer Use `.7`. The Pi runtime was clean-installed again; component typecheck, all 12 focused broker tests and all 40 archive/distribution tests passed again. Public tree/history and the actual `.7` archive audits passed.

The full component suite did not complete within a 300-second deadline. The first attempt lacked the component's own compiler dependency; after installing its declared development dependencies, a second full run still timed out without a final summary. The compiler controls pass separately. Do not treat either partial run as a full-suite pass; the full-run timeout remains outside this focused fix.

No desktop GUI was driven, no live helper was replaced or restarted, and no npm publication was performed. This verifies broker process startup and packaging, not desktop interaction or the screenshot's host application's complete chat workflow.
