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

## Review (2026-11-22)

Reproduced locally: `--self-test` passes, `loop ledger` validates the entry as `inconclusive / kept-off`, `git diff --check` is clean, and the table matches `results.json`. The decision stands. The evidence is narrower than the hypothesis:

1. **Failed commands were not exercised.** Every baseline ran 0 failed commands because `pyproject.toml` names `test-dir`, so discovery is trivial. The run action accepts only the exact spelling, so the hint arm is the baseline given the answer, and the saving is only the skipped `list`/`read` calls. Excluding `slate`, tokens fell 6,485 → 2,093 for that reason alone.
2. **The prompt size is not rotom's.** `--system-prompt` replaces the default prompt, and context files, extensions and skills are off, so each turn sends about 280 input tokens. In rotom, each turn resends a large cached prefix, so neither the 48.8% figure nor the "extra prompt input" accounting transfers.
3. **The relevant comparator is missing.** rotom loads AGENTS.md by default, and this pilot disables it with `--no-context-files`. A learned hint has to beat the same command written as one line in a context file, not just beat no hint.
4. **`slate` is a repeat measurement, not a drift test.** Neither arm gets a hint, and both runs produced identical calls and 2,512 tokens. That shows near-deterministic trajectories at thinking `off`. It does not show whether a stale hint misleads the model.
5. **Learning is synthetic.** The harness generates the histories, and `learn()` is eval code, so the threshold and contradiction rules are covered only by unit checks.
6. **Classification gap.** `fixture-tool.ts` marks any non-zero test exit as infrastructure, which aborts the run. Before adding fixtures with a genuinely failing check, count a failing check separately from infrastructure.

A next step that could change the decision: run on the full rotom prompt with caching and three arms — no hint, the command as one line in AGENTS.md, and the learned hint. Use fixed real tasks from `loop harvest` with observed repeated discovery or command failures, plus documented and drift cases where an injected stale hint is actually tested. Run several attempts per arm.

## Round two

`loop harvest --days 28 --no-excerpts` produced 695 session summaries and 1,791 incident rows locally. A deterministic check for test-command patterns in the 60 harvested sessions from the public rotom checkout identified verification sequences for manual inspection. The two incident tasks are different recorded targets with the same wrong-config failure family. Their code and executable commands are frozen from the public `01b087c7` tree; only the task descriptions, allowed command aliases, and exposed file subset are eval code. No session transcripts, private paths, or log excerpts are published or supplied to the model. This round tests the **delivery** of manually extracted, locally verified repo notes, not a production history learner.

| Task | Basis | Expected control |
| --- | --- | --- |
| `benchmark-runner` | Recorded repeated attempts at the focused Vitest suite, including bare Vitest finding no tests; explicit unit config passed. | Bare Vitest runs but does not execute the requested tests. |
| `loop-gate-ledger` | Recorded search for the ledger suite followed by bare Vitest finding no tests. | Same wrong-config trap on a different real test target. |
| `public-audit` | The exact command is already in the pinned `docs/agent/verification.md`. | Documentation is available in all arms; B/C repeat information already in the repo. |
| `continuation-drift` | The old behavioral-regression unit command appears in historical successful verification. [`ef2b490a`](https://github.com/bingjiang0611/rotom/commit/ef2b490a) removed that unit file, moved the continuation eval, and kept its successor unit check. | B and C both **receive** the same old command on today's snapshot. Count attempts to run it, plus recovery, failure, and cost. |

### Arms and isolation

A has no note; B exposes the note as a single line in local `AGENTS.md`; C passes the identical line via `--append-system-prompt`. Context-file discovery is **on in all three**. No arm uses `--system-prompt` or a cache override. Runs use installed rotom and are sequential (`ABC`, `BCA`, `CAB` per task), with a stable working directory within the round. Each arm visits each position once. Provider cache hits are measured, not forced. Multiple arms may share a provider cache prefix; note from B and note from C are not assumed to have the same cache placement.

- `--no-extensions` opts out of extension discovery and Pi builtins to avoid user hooks, background calls, and automatic changes to the tool list. Only the explicit eval extension is requested. The harness fails closed if a different tool surface is presented.
- `--no-skills` keeps machine or bundled skill text and skill workflows out of the prompts. `--no-mcp` prevents connection to real tools/services. `--no-builtin-tools --tools workspace` limits the model to public fixture reads and fixed offline test commands; no model-selected shell, filesystem path, or subprocess arguments are used.
- The fresh agent directory excludes personal settings and context. The installed CLI handles existing authentication; the live runner links to the existing auth file rather than reading, copying, or logging it. With `--no-session` and observability off, only structured tool outcomes and usage are retained. This is rotom's default prompt **renderer** and unmodified cache policy on a scoped tool surface, not the full daily-use extension/skill stack.

The verifier requires a successful execution of the requested tests plus a final `PASS`. A normal nonzero exit, runner returning zero with no tests, or unavailable command counts as a failed command; spawn, timeout, and signal failures count as infrastructure. The runner preserves attempted rows and stops on infrastructure, not on test failure. Redundant calls are all workspace calls except the first successful target run; a failed attempt has no successful call to subtract. Report `input`, `output`, `cacheRead`, `cacheWrite`, and the counts of true/false/missing `usage.cost.totalFromProvider`. Include cost for every issued attempt, and distinguish catalog estimate from billing. Cost and usage missingness prevent a positive verdict.

**Decision rule.** C must use fewer redundant calls and cost no more than B in each of the three repeat blocks, with no lower pass count in any block or any task across repeats. Any incomplete comparison or failure of this bar means `kept-off`. Clearing the bar allows discussion, not enablement. Report per-task data and inspect the documented and drift controls separately; four fixed tasks with two same-family incidents do not establish a general product gain.

```sh
node rotom/evals/micro-skills/round2.mjs --self-test
# Only after explicit approval of 4 tasks × 3 arms × 3 attempts = 36 live attempts:
node rotom/evals/micro-skills/round2.mjs --live /tmp/micro-skills-round2.json
node rotom/evals/micro-skills/round2-summary.mjs /tmp/micro-skills-round2.json
```

The self-test needs an installed rotom, Node 24+, Python 3, and the pinned npm dependencies in the local npm cache. It uses `npm ci --offline --ignore-scripts` in a temporary archive of the pinned tree. Its offline rotom prompt probe uses a loopback-only dummy provider and aborts before inference. `ROTOM_EVAL_BIN` can select another installed rotom path. Only the live CLI receives the operator's configured proxy/CA environment; fixture subprocesses and the offline probe do not.

### Results (2026-11-22 UTC)

**INCONCLUSIVE / kept-off.** The real test-command notes prevented discovery and command retries versus A. C did not save any redundant calls over B on tasks anyone passed. Its overall savings came from giving up sooner on the stale command in the drift task, which no arm passed. One infrastructure failure also leaves the comparison incomplete. No product code or default prompt changed.

Installed rotom `0.2.4` (build `95777adbfcdca2987eb927007b974361d3247544`), `openai-codex/gpt-6.2-sol`, thinking `off`, Node `24.18.0`, macOS. The preregistered run is `f25e1194`; the CLI network env was fixed in `022d5b17` before collecting the reported samples. An initial startup attempt without that env had no tool calls or reported tokens and is excluded from the scheduled comparison. In the scored run, `continuation-drift` A/2 stopped with CLI/provider errors before tool execution (zero reported tokens, no provider price). The final three unissued slots ran in a fresh scratch directory after that stop; no earlier slot was rerun. The directory change may change provider cache keys for the resumed attempts. Thus there are 36 scheduled attempts, 35 scored outcomes, and one missing outcome, plus the excluded startup failure.

| Task | Passes A / B / C | Redundant calls A / B / C | Failed commands A / B / C |
| --- | --- | --- | --- |
| `benchmark-runner` | 3/3 · 3/3 · 3/3 | 11 · 0 · 0 | 2 · 0 · 0 |
| `loop-gate-ledger` | 3/3 · 3/3 · 3/3 | 10 · 0 · 0 | 2 · 0 · 0 |
| `public-audit` | 3/3 · 3/3 · 3/3 | 6 · 4 · 4 | 0 · 0 · 0 |
| `continuation-drift` | 0/2 · 0/3 · 0/3 | 20 · 25 · 5 | 10 · 11 · 3 |
| **Total** | **9/11 · 9/12 · 9/12** | **47 · 29 · 9** | **14 · 11 · 3** |

In the drift control, C attempted the stale command and failed all three times. B attempted it twice and hit the tool limit on its third try. Neither A nor either hinted arm reached the correct check. A's two scored attempts also hit the tool limit. The offline verifier proves the target is executable, but the live fixture requires an exact command spelling (including a name filter), which may have made recovery artificially hard. These results show that both hints were followed at times, not that a stale hint lowered the success rate relative to A.

| Arm | Input | Output | Cache read | Cache write | `totalFromProvider` true / false / missing | CLI cost estimate |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| A | 116,192 | 1,903 | 12,288 | 0 | 0 / 65 / 6 | $0.2526428 |
| B | 80,702 | 1,550 | 25,600 | 0 | 0 / 50 / 1 | $0.1794640 |
| C | 38,780 | 669 | 8,192 | 0 | 0 / 30 / 0 | $0.0850692 |

Token categories and source flags are reported per assistant message, then summed or counted by arm. The $0.517176 total is the CLI's usage-based estimate, not billed charges; zero-usage failure placeholders do not establish there was no provider charge. B → C reduced redundant calls in all three blocks (8 → 5, 11 → 1, 10 → 3) without lower block pass counts or higher block cost estimates. But excluding the all-fail drift task, B and C each spent four redundant calls; C cost **more** ($0.0618896 vs $0.0568352), including more on the already documented control. Together with the missing outcome, this does not support product work. Before another live comparison, make the drift fixture accept equivalent safe spellings and confirm unhinted agents can recover to the target; otherwise a fast failure still looks like an efficiency gain.

[Per-attempt JSON shards](round2-results/) preserve the tool outcome bits and usage, including the unscored provider error. To regenerate the tables from the published inputs:

```sh
node rotom/evals/micro-skills/round2-summary.mjs rotom/evals/micro-skills/round2-results/*.json
```

To continue a stopped run without rerunning any already-issued slot, pass the previous result path after the new output path. The runner requires a matching configuration and exact prefix of the original schedule. The comparison gate stays incomplete when that prefix contains an infrastructure failure.
