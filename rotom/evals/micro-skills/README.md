# Micro-skills pilot: does remembering the test command pay for its prompt?

[TokenEconomizer](https://github.com/microsoft/TokenEconomizer/tree/1bfeccd) learns repository facts across sessions, prunes rarely used tools, and intervenes in failure loops. Its [paper](https://arxiv.org/abs/2610.22732) reports 18.4–30.9% lower mean SWE-Bench cost across five agent/model combinations for the full system, not for this isolated mechanism or for rotom. Tool pruning is not supported by its Pi extension. This pilot isolates one mechanism: expose a short, previously verified test command in the system prompt. It doesn't install TokenEconomizer, change rotom defaults, or make judge/proposer calls.

## Design

- Fixed suite in [`run.mjs`](run.mjs): `quartz` and `cedar` have an undocumented command spelling (directory visible in project metadata and listing); `willow` documents the full command (control for whether a hint still helps when docs exist); `slate` changes command late (contradiction control). ID stands for repository identity; no production Git keying or transcript ingestion is tested.
- Each synthetic history is replayed locally, independently of live attempts. Three separate snapshots verify the same allowlisted command before a hint is eligible; one later failure vetoes a once-confirmed command. Fewer than three confirmations for the replacement in `slate` means no hint. Historical verification codes differ from the live ones and are never injected. Both arms see the same fresh task contents, with the same model, base prompt and tool; only the candidate system note differs where the threshold enables it. Pair order alternates; one trial per arm per task, no runner retries.
- The live model sees only synthetic files and a `workspace` tool that reads a fixed in-memory map or runs one fixed Python argv in the temp fixture (no shell, arbitrary command execution, or arbitrary filesystem reads). An exact final answer **and** a successful run are required to pass. An unavailable `run` counts as a failed command; this does not estimate arbitrary bash failure rates. Each attempt is capped at 10 tool calls and a 100 s process timeout. Latency includes CLI startup. This is a constrained fixture, not an OS sandbox.
- The trace retains action types, success bits and provider usage, not conversation text, credentials, command arguments or tool result bodies. The harness uses `--no-session` with observability disabled and no discovered extensions, skills, context files, or MCP. It uses the existing CLI authentication without reading or exporting credentials.

## Reproduce

Requires Node 22+ with TypeScript stripping, Python 3, and installed `rotom`. Run from the repository root. The offline command costs no model calls. The live command requires authorization to use the chosen provider and writes a new JSON file; it stops at the first infrastructure error and retains completed attempts.

```sh
node rotom/evals/micro-skills/run.mjs --self-test
node rotom/evals/micro-skills/run.mjs --live openai-codex gpt-6.2-sol /tmp/micro-skills-new-results.json
```

`ROTOM_EVAL_BIN` can select an absolute path to a particular installed CLI; `ROTOM_EVAL_PYTHON` can select an absolute Python path (default `/usr/bin/python3`). The offline check covers minimum evidence, duplicate-session rejection, contradiction, command allowlisting, and a real Python verification result.

## Results

**Decision: INCONCLUSIVE for enabling this in rotom.** The hint saved discovery steps in this fixture; it did not reduce failed commands. Keep it in eval only.

Run on 2026-11-22 UTC with installed rotom `0.2.4` (build `95777adbfcdca2987eb927007b974361d3247544`), `openai-codex/gpt-6.2-sol`, thinking `off`, macOS, Node 22.23.1 and Python 3.9.6. Both arms used the same build; the experiment harness was frozen in `969134b2` before live runs. All eight attempts completed, with no infrastructure failures or tool-call limit hits. The offline self-test passed.

Numbers are baseline → candidate. The candidate injects no note for `slate`.

| Fixture | Verifier | Tool calls | Failed commands | Reported tokens | Wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| `quartz` — undocumented | pass → pass | 5 → 1 | 0 → 0 | 2,510 → 697 | 32.9 → 16.5 s |
| `cedar` — undocumented | pass → pass | 5 → 1 | 0 → 0 | 2,516 → 699 | 21.6 → 15.9 s |
| `willow` — documented | pass → pass | 3 → 1 | 0 → 0 | 1,459 → 697 | 26.5 → 17.3 s |
| `slate` — stale note withheld | pass → pass | 5 → 5 | 0 → 0 | 2,512 → 2,512 | 22.1 → 24.5 s |
| **Total** | **4/4 → 4/4** | **18 → 8** | **0 → 0** | **8,997 → 4,605** | **103.2 → 74.2 s** |

The three injected notes skipped 10 `list`/`read` calls; every attempt ran exactly one successful check. Total assistant usage fell 48.8%, counting the extra prompt input. The CLI's usage-based price estimate fell from $0.021522 to $0.011034 (48.7%); every usage row has `totalFromProvider: false` and zero cache reads/writes. These are not billed charges, and latency includes startup/network variance. This compares live runs only, not the cost of harvesting or storing evidence in production. One model and one attempt per arm are not enough to infer stable savings or non-inferiority.

[Measurement JSON](results.json) includes synthetic history rows, paired attempt order, tool outcome bits and per-message usage. The table sums `usage.totalTokens`, `usage.cost.total` and `elapsedMs`; unsuccessful `run` calls count as failed commands. `slate` tests withholding on contradiction, not whether injecting stale guidance would hurt.

## Review questions

1. Are the outcome verifier and the `slate` no-hint control doing what we think? Note that the same configuration can give different model outputs in separate runs.
2. Does the single-command fixture give the hint too much of an advantage compared with a good README or cheap agent discovery? The pilot deliberately does not measure file edits, real historical extraction, injection hygiene on user-authored logs, or long-run prompt/cache overhead.
3. Before considering a product feature, pick fixed real tasks with observed repeat discovery failures and include documented/no-benefit and drift cases. Compare with an improved README, not just with no hint. Keep the hint off by default until multiple repeats show fewer redundant calls without lower verifier success or higher net cost on that workload.
