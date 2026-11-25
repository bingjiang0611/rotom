/** The command help text, kept apart from the parser so the switch stays readable. */
import { defaultLoopDir, defaultSessionsDir } from "./harvest-run.ts";
export const USAGE = `Usage: npm run loop -- <command>

  harvest [--sessions DIR] [--out DIR] [--days N | --since YYYY-MM-DD] [--no-excerpts]
      Scan local Pi sessions (default ${defaultSessionsDir()}) into a private incident
      queue and weekly intervention rate under ${defaultLoopDir()}. No model calls.

  machine [name]
      Print or set this machine's label (stored privately in machine.json, or taken from
      ROTOM_LOOP_MACHINE). A scored gate run refuses to start without one, because every
      run is committed under it.

  records import
      Turn this machine's private gate history into committed records under
      loop/results/gate/<machine>/<runId>.json, one per run not yet recorded. Records hold
      case ids, pass counts, verdicts, models, commits and a product fingerprint; never a
      session, a host name or a local path.

  status
      One screen from files that already exist: intervention rate from the newest weekly
      report, how many climb cases discriminate, shipped mechanism records not yet
      verified, days since the last gate and weekly run, each case's last and pooled
      results, and what is due next. No model calls; "no record" is never printed as 0.

  freeze <ref>
      Check out <ref> as a detached worktree under ${defaultLoopDir()}/frozen/<sha>/,
      install its two dependency sets from its own locks and run the gate preflight.
      Freezing the same commit again reinstalls nothing. \`gate\` without --baseline
      uses the last frozen commit and prints which one.

  gate [--baseline /abs/frozen/rotom] [--candidate /abs/rotom] [--case ID] [--repeats N]
       [--holdout] [--out DIR] [--smoke]
      Re-run the cases in loop/gate.json against both products and print
      held / regressed / unknown. Appends each case to the private gate history.
      Calls the configured model.

      A case may carry its own repeats; --repeats overrides every case. Holdout
      cases (split: holdout) are skipped unless --holdout is passed, and their
      result is printed beside the verdict without deciding it, as candidate
      against baseline: generalizes, no-difference, worse or unknown. Run them at
      the judging round, never while tuning a fix.

      --smoke runs one pair per case and audits the recorded scores: both arms must
      score, every check must be a boolean, and no check may read a file the fixture
      did not observe. It is not a sample, so nothing is appended to the history.
      Run it before a real gate run.

  gate-pool --since ISO [--case ID] [--local | --history PATH]
      Merge the committed gate records of every machine for each case since ISO, grouped
      by product fingerprint (the product tree without evals), model and case, then judge
      the pooled pass and fail counts. --local reads this machine's private history instead.

  ledger
      Validate every loop/ledger/<month>.json shard and print the experiment history.

  replay --incident <sessionId:entryId> [--repeats N] [--frozen DIR] [--current DIR]
         [--model provider/model] [--check COMMAND] [--origin-check [--origin-only]] [--out DIR]
      Re-run one recorded failure against a frozen product in an isolated copy of the
      session's own project: a worktree at the last commit before the session, its
      remotes removed, a scrubbed environment with its own HOME and a shell shim that
      refuses pushes, publishes and remote writes. Artifacts only under
      ~/.rotom/loop/replay-<stamp>/. The incident is read from the newest harvest.
      Product and model default to the frozen release the incident ran and the model
      that answered it; a replay never switches model. --check runs the event's own
      deterministic check in the same sandbox after each run (exit 0 pass, 1 the
      failure, anything else unknown) and admits reproduced (replay) at three of five
      failing runs. The check runs in the clone with REPLAY_TRANSCRIPT (this run's
      output) and REPLAY_WORKSPACE set. Tool calls and usage count the replay's new
      turns only. --origin-check applies the same check to what the original run
      produced before any model call: a pass means the event was never a failure,
      so it is skipped and counted as a harvest false positive. --origin-only stops
      after that verdict and spends no model call.

  replay-gate --product DIR [--current-only] [--case ID] [--out DIR]
      Replay every registered replay case against one product and report
      held / regressed / unknown. Cases come from the private
      ~/.rotom/loop/replay-cases/ (0700/0600, not in Git); gate.json only
      carries their ids and de-identified mechanism summaries. A product that
      did not start, or a run that did not finish, is unknown and never a pass.
      Run it before changing the coding policy, a tool description, or the
      continuation/stop logic.

  weekly [--sessions DIR] [--days N] [--out DIR]
      Harvest the last N days (default 28) and write ~/.rotom/loop/weekly-<date>/:
      north star v2 with bands and a sensitivity column, the observed per-model split,
      every shipped-but-unmeasured ledger record against its own acceptance metric,
      and provider-to-user failures per 100 turns before and after the switch.
      No model calls; nothing is written to Git.
`;
