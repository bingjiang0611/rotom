/** The command help text, kept apart from the parser so the switch stays readable. */
import { defaultLoopDir, defaultSessionsDir } from "./harvest-run.ts";
export const USAGE = `Usage: npm run loop -- <command>

  harvest [--sessions DIR] [--out DIR] [--days N | --since YYYY-MM-DD] [--no-excerpts]
      Scan local Pi sessions (default ${defaultSessionsDir()}) into a private incident
      queue and weekly intervention rate under ${defaultLoopDir()}. No model calls.

  gate --baseline /abs/frozen/rotom [--candidate /abs/rotom] [--case ID] [--repeats N] [--out DIR] [--smoke]
      Re-run reproduced regression cases from loop/gate.json against both products
      and print held / regressed / unknown. Appends each case to the private gate
      history. Calls the configured model.

      --smoke runs one pair per case and audits the recorded scores: both arms must
      score, every check must be a boolean, and no check may read a file the fixture
      did not observe. It is not a sample, so nothing is appended to the history.
      Run it before a real gate run.

  gate-pool --since ISO [--case ID] [--history PATH]
      Merge every recorded gate run of the same candidate commit and baseline for
      each case since ISO, then judge the pooled pass and fail counts.

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
