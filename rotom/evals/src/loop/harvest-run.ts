/**
 * Harvest output: session walking, the weekly north-star metric, the triage queue and the
 * report files. Analysis of one session lives in `harvest.ts`; these functions only aggregate
 * it and write the private `~/.rotom/loop/harvest-<stamp>/` directory.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FAILURE_KINDS, HARVEST_SCHEMA, INTERVENTION_KINDS, type Incident, type IncidentKind, type SessionSummary, analyzeSession, createHarvestShared } from "./harvest.ts";

/** ISO-8601 week label, e.g. 2026-W45. */
export function isoWeek(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "unknown";
	const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const weekday = day.getUTCDay() || 7;
	day.setUTCDate(day.getUTCDate() + 4 - weekday);
	const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WeekMetric = {
	week: string;
	sessions: number;
	userTurns: number;
	interventions: number;
	/** North star: user interventions per 100 user turns. */
	interventionsPer100Turns: number | null;
	failures: number;
	incidentCounts: Partial<Record<IncidentKind, number>>;
};

export function weeklyMetrics(sessions: readonly SessionSummary[]): WeekMetric[] {
	const weeks = new Map<string, WeekMetric>();
	for (const session of sessions) {
		const week = isoWeek(session.startedAt);
		const metric = weeks.get(week) ?? { week, sessions: 0, userTurns: 0, interventions: 0, interventionsPer100Turns: null, failures: 0, incidentCounts: {} };
		metric.sessions++;
		metric.userTurns += session.userTurns;
		metric.interventions += session.interventions;
		metric.failures += session.failures;
		for (const [kind, count] of Object.entries(session.incidentCounts) as [IncidentKind, number][]) {
			metric.incidentCounts[kind] = (metric.incidentCounts[kind] ?? 0) + count;
		}
		weeks.set(week, metric);
	}
	return [...weeks.values()]
		.map((metric) => ({
			...metric,
			interventionsPer100Turns: metric.userTurns > 0 ? Math.round((metric.interventions / metric.userTurns) * 1000) / 10 : null,
		}))
		.sort((left, right) => left.week.localeCompare(right.week));
}

const TRIAGE_WEIGHT: Record<IncidentKind, number> = {
	user_correction: 3,
	user_repeat: 2,
	bare_continue: 2,
	user_interrupt: 1,
	tool_error_streak: 1,
	edit_retry_without_read: 1,
	provider_error: 0.5,
	length_stop: 0.5,
	goal_pause: 1,
	compaction_failed: 1,
};

export function triageScore(session: SessionSummary): number {
	return (Object.entries(session.incidentCounts) as [IncidentKind, number][]).reduce((sum, [kind, count]) => sum + TRIAGE_WEIGHT[kind] * count, 0);
}

export function renderReport(input: { generatedAt: string; since: string; sessionsDir: string; sessions: readonly SessionSummary[]; incidents: readonly Incident[]; skipped: number }): string {
	const weeks = weeklyMetrics(input.sessions);
	const lines = [
		"# rotom loop harvest",
		"",
		`Generated ${input.generatedAt} · sessions since ${input.since} · source \`${input.sessionsDir}\``,
		"",
		"Local, private output. Detectors are heuristic candidates for triage, not verdicts.",
		"",
		"## Weekly intervention rate",
		"",
		"| Week | Sessions | User turns | Interventions | per 100 turns | Agent-side failures |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
		...weeks.map((week) => `| ${week.week} | ${week.sessions} | ${week.userTurns} | ${week.interventions} | ${week.interventionsPer100Turns ?? "N/A"} | ${week.failures} |`),
		"",
		"## Incidents by kind",
		"",
		"| Kind | Count |",
		"| --- | ---: |",
		...[...INTERVENTION_KINDS, ...FAILURE_KINDS].map((kind) => `| ${kind} | ${input.incidents.filter((incident) => incident.kind === kind).length} |`),
		"",
		"## Triage queue (top sessions)",
		"",
		"| Score | Session | Started | Turns | Incidents | File |",
		"| ---: | --- | --- | ---: | --- | --- |",
	];
	const ranked = [...input.sessions].filter((session) => triageScore(session) > 0).sort((left, right) => triageScore(right) - triageScore(left)).slice(0, 20);
	for (const session of ranked) {
		const counts = Object.entries(session.incidentCounts).map(([kind, count]) => `${kind}×${count}`).join(", ");
		lines.push(`| ${triageScore(session)} | ${session.sessionId.slice(0, 8)} | ${session.startedAt.slice(0, 16)} | ${session.userTurns} | ${counts} | \`${session.sessionFile}\` |`);
	}
	if (input.skipped > 0) lines.push("", `${input.skipped} file(s) skipped (symlink, unreadable or not a session).`);
	lines.push("", "Next: pick incidents from `incidents.jsonl`, classify them, and turn reproducible ones into replay cases (see docs/agent/optimization-loop.md).", "");
	return lines.join("\n");
}

async function sessionFiles(root: string): Promise<{ files: string[]; skipped: number }> {
	const files: string[] = [];
	let skipped = 0;
	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > 4) return;
		const items = await readdir(directory, { withFileTypes: true });
		for (const item of items) {
			const path = join(directory, item.name);
			if (item.isSymbolicLink()) {
				skipped++;
				continue;
			}
			if (item.isDirectory()) {
				// Trace sidecars, subagent artifacts and child-agent stores are not user sessions.
				if (item.name === "observability" || item.name.includes("subagent")) continue;
				await walk(path, depth + 1);
			} else if (item.isFile() && item.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	};
	await walk(root, 0);
	return { files: files.sort(), skipped };
}

async function readOptional(path: string): Promise<string[] | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile()) return undefined;
		return (await readFile(path, "utf8")).split("\n");
	} catch {
		return undefined;
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`refusing non-directory or symlink output: ${path}`);
}

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR || join(env.HOME ?? "", ".pi", "agent");
	return join(agentDir, "sessions");
}

export function defaultLoopDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.ROTOM_LOOP_DIR || join(env.HOME ?? "", ".rotom", "loop");
}

export type HarvestOptions = { sessionsDir: string; outRoot: string; since: Date; now?: Date; excerpts: boolean };

export async function harvest(options: HarvestOptions): Promise<{ outDir: string; sessions: SessionSummary[]; incidents: Incident[]; skipped: number }> {
	const now = options.now ?? new Date();
	const sessionsDir = resolve(options.sessionsDir);
	const rootInfo = await lstat(sessionsDir).catch(() => undefined);
	if (!rootInfo?.isDirectory()) throw new Error(`sessions directory not found: ${sessionsDir} (set --sessions or PI_CODING_AGENT_DIR)`);
	const { files, skipped: skippedLinks } = await sessionFiles(sessionsDir);
	let skipped = skippedLinks;
	const sessions: SessionSummary[] = [];
	const incidents: Incident[] = [];
	const shared = createHarvestShared();
	for (const file of files) {
		const info = await lstat(file);
		if (info.mtime < options.since) continue;
		const lines = await readOptional(file);
		if (!lines) {
			skipped++;
			continue;
		}
		const tracePath = join(dirname(file), "observability", `${basename(file).replace(/\.jsonl$/u, "")}.trace.jsonl`);
		const result = analyzeSession(lines, { sessionFile: file, excerpts: options.excerpts, traceLines: await readOptional(tracePath), shared });
		if (!result) {
			skipped++;
			continue;
		}
		if (result.session.userTurns === 0) continue;
		sessions.push(result.session);
		incidents.push(...result.incidents);
	}

	const stamp = now.toISOString().replace(/[:.]/gu, "-");
	const outRoot = resolve(options.outRoot);
	await ensurePrivateDirectory(outRoot);
	const outDir = join(outRoot, `harvest-${stamp}`);
	await ensurePrivateDirectory(outDir);
	const write = (name: string, body: string) => writeFile(join(outDir, name), body, { mode: 0o600, flag: "wx" });
	const since = options.since.toISOString();
	await write("sessions.jsonl", sessions.map((session) => JSON.stringify(session)).join("\n") + (sessions.length ? "\n" : ""));
	await write("incidents.jsonl", incidents.map((incident) => JSON.stringify(incident)).join("\n") + (incidents.length ? "\n" : ""));
	await write(
		"summary.json",
		`${JSON.stringify({ schema: HARVEST_SCHEMA, generatedAt: now.toISOString(), since, sessionsDir, excerpts: options.excerpts, sessions: sessions.length, incidents: incidents.length, skipped, weeks: weeklyMetrics(sessions) }, null, 2)}\n`,
	);
	await write("report.md", renderReport({ generatedAt: now.toISOString(), since, sessionsDir, sessions, incidents, skipped }));
	return { outDir, sessions, incidents, skipped };
}
