# Third-party notices

rotom 的根产品许可证尚未确定（当前 `UNLICENSED`）；此状态不改变下列第三方各自的许可证。公开发布前仍需完成全量传递依赖与分发通知审查。

## Direct runtime dependencies

| Package | Version | Declared license | Distribution |
|---|---|---|---|
| `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-telemetry`, `chord` (all under `@earendil-works`) | `0.85.1-rotom.1` | MIT | In-repository Pi fork (`packages/rotom-pi/`), built into integrity-pinned archives and installed under `runtime/pi/node_modules/` |
| `@injaneity/pi-computer-use` | `0.5.1-rotom.0` | MIT | Independently maintained fork (`packages/rotom-computer-use/`), included from its integrity-pinned vendor archive |
| `@juicesharp/rpiv-ask-user-question` | `2.6.2` | MIT | Included under `extensions/third-party/node_modules/` |
| `@narumitw/pi-goal` | `0.54.4-rotom.0` | MIT | Independently maintained fork (`packages/rotom-goal/`), included from its integrity-pinned vendor archive |
| `pi-subagents` | `0.52.1-rotom.2` | MIT | Independently maintained Subagent source, included from its integrity-pinned vendor archive |

Each included extension retains its original `LICENSE` and package metadata; transitive dependency notices remain in their installed package directories. The modified Subagent, Computer Use and Goal archives' origin and scope are documented in `extensions/third-party/vendor/README.md` and each fork's `package/UPSTREAM.md`. Shipping the complete dependency does not enable its unselected tools, templates, or skills.

## Qoder authentication and legacy inference reference

`extensions/qoder/catalog-auth.mjs` adapts the COSY header construction described in [9router PR #2952](https://github.com/decolua/9router/pull/2952), revision `d2fd11b11698795a2c4479ef6906304f22162475`, `open-sse/protocol/qoder/cosy.js` and its public server key. This is an unmerged third-party interoperability reference, not official Qoder support. `extensions/qoder/legacy.mjs` additionally adapts the body/encoding protocol in that revision's `body.js`, `chat.js` and `encoding.js` for the explicitly allowlisted legacy inference routes. Sonus's observed opaque state is preserved rather than discarded; completion is never inferred from EOF alone. It performs single model-generation requests, not a hosted agent loop or automatic fallback. No installed CLI or WASM is included.

```text
MIT License

Copyright (c) 2024-2026 decolua and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Pi license

Source: [Pi repository LICENSE](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/LICENSE). All six fork archives retain this LICENSE and upstream metadata. `runtime/pi/fork-build.json` records the upstream revision, maintained source/builder digests and archive integrities. The fork changes native model-picker behavior; it is not an official Pi release. Source provenance and maintenance instructions are in `packages/rotom-pi/FORK.json` and `ROTOM-FORK.md` in the source repository.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
