import { runStamp, withoutHome } from "./live-helpers.mjs";
import { writeRunArchive } from "./b-window.mjs";

/**
 * One archive writer, kept out of the script so the script reads as the run it performs.
 *
 * Without `beginStep` there is no runs directory and no commit, so a refusal cannot write an
 * archive that a later step would mistake for permission. A report-only run (B0) gets no
 * `Verdict:` line, which is what makes it authorize nothing.
 */
export async function writeEvidence({ frozen, rows, log, b0, runName = `${runStamp()}-l2-check.md` }) {
	const written = frozen
		? writeRunArchive({
			reportOnly: frozen.reportOnly === true,
			runsDir: frozen.runsDir,
			runName,
			title: "Computer Use v2 L2 single-action check",
			step: frozen.step,
			commit: frozen.commit,
			rows: rows.map((row) => ({ ...row, note: withoutHome(row.note) })),
			log: log.map(withoutHome),
			intro: [
				`One directed click and one directed text input per target, delivered with \`background\` policy.${b0 ? " This is the B0 attribution run: it reports, it authorizes nothing." : ""}`,
				"`cursorMoved` and `frontmostChanged` say whether the action reached the user's session.",
				"`attribution` rows group the events the helper counted as real input by source process and event type (review 7, R2).",
			],
		})
		: { verdict: "refused", blockers: [], path: undefined };
	if (written.verdict === "fail") {
		process.exitCode = 1;
		console.error(`[cu-v2 l2] FAILED: ${written.blockers.join("; ")}`);
	}
	if (written.verdict === "report") {
		console.error("[cu-v2 l2] attribution report only: no Verdict line, no step authorized, no B-STOPPED");
	}
	return written;
}
