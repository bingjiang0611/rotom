/**
 * The two report commands. Both read the same 28-day harvest and differ only in what they print, so
 * they share one entry point instead of repeating the harvest call in the argument switch.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultLoopDir, defaultSessionsDir, harvest } from "./harvest-run.ts";
import { parseLedgerDir } from "./ledger.ts";
import { versionTimeline } from "./release-version.ts";
import { buildWeekly, parseWeeklyConfig, writeWeekly } from "./weekly.ts";

export const WEEKLY_CONFIG = (evalsRoot: string) => `${evalsRoot}/loop/weekly.json`;
const LEDGER = (evalsRoot: string) => `${evalsRoot}/loop/ledger`;

export async function reportCommand(command: string, rest: string[], deps: { repoRoot: string; evalsRoot: string }): Promise<number> {
	if (command === "versions") {
		const { values } = parseArgs({ args: rest, options: { sessions: { type: "string" }, days: { type: "string" } } });
		const days = values.days ? Number(values.days) : 28;
		const result = await harvest({ sessionsDir: values.sessions ?? defaultSessionsDir(), outRoot: defaultLoopDir(), since: new Date(Date.now() - days * 86_400_000), excerpts: false });
		for (const segment of versionTimeline(result.sessions)) {
			console.log(`${segment.startsAt} .. ${segment.endsAt}  ${segment.release}  commit=${segment.commit ?? "unknown"}  sessions=${segment.sessions} turns=${segment.turns} switchedBy=${segment.switchedBy}`);
		}
		return 0;
	}
	if (command === "weekly") {
		const { values } = parseArgs({ args: rest, options: { sessions: { type: "string" }, days: { type: "string" }, out: { type: "string" } } });
		const days = values.days ? Number(values.days) : 28;
		if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
		const since = new Date(Date.now() - days * 86_400_000);
		const config = parseWeeklyConfig(readFileSync(WEEKLY_CONFIG(deps.evalsRoot), "utf8"));
		const result = await harvest({ sessionsDir: values.sessions ?? defaultSessionsDir(), outRoot: values.out ?? defaultLoopDir(), since, excerpts: false });
		const report = buildWeekly({ sessions: result.sessions, incidents: result.incidents, ledger: parseLedgerDir(LEDGER(deps.evalsRoot), deps.repoRoot), config, since: since.toISOString(), ranWithFix: (session, firstCommit) => {
			// A session only counts as exposure when the build it actually ran is the fix or a
			// descendant of it. The build commit comes from the launcher's own stamp; a release
			// label guessed from session text is not attribution and is no longer consulted.
			const commit = session.buildCommit;
			if (!commit) return false;
			try {
				execFileSync("git", ["-C", deps.repoRoot, "merge-base", "--is-ancestor", firstCommit, commit], { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		} });
		const directory = await writeWeekly(values.out ?? defaultLoopDir(), report);
		console.log(`sessions=${result.sessions.length} incidents=${result.incidents.length}`);
		console.log(`weekly: ${directory}/report.md`);
		for (const row of report.records) console.log(`record ${row.status.padEnd(12)} ${row.id}  turns=${row.turns} observed=${row.observedPer100 ?? "N/A"} baseline=${row.baselinePer100 ?? "N/A"}`);
		return 0;
	}
	return 1;
}
