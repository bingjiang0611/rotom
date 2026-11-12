/**
 * Harvest output: walking the sessions root and writing the private
 * `~/.rotom/loop/harvest-<stamp>/` directory. Analysis of one session lives in
 * `harvest.ts`; the report text and the weekly metric live in `harvest-report.ts`.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type CompactionObservation, analyzeCompactions, compactionMetrics } from "./compaction-harvest.ts";
import { HARVEST_SCHEMA, type Incident, type SessionSummary, analyzeSession, createHarvestShared } from "./harvest.ts";
import { applyRoutineRepeats, markRoutineRepeats } from "./harvest-repeat.ts";
import { renderReport, type SkipCounts, type SkipReason } from "./harvest-report.ts";
import { weeklyMetrics } from "./harvest-report.ts";

export { isoWeek, renderReport, triageScore, weeklyMetrics, type SkipCounts, type SkipReason, type WeekMetric } from "./harvest-report.ts";

function bump(counts: SkipCounts, reason: SkipReason): void {
	counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Directory names the product writes beside sessions; none of them is a user session file. */
const ARTIFACT_SEGMENTS = new Set(["observability", "observation-pack"]);

function isArtifactSegment(name: string): boolean {
	return ARTIFACT_SEGMENTS.has(name) || name.includes("subagent");
}

/** A session file lives at `<cwd>/<name>.jsonl` or `<cwd>/<store>/<id>/<name>.jsonl`; deeper is an artifact tree. */
const MAX_DEPTH = 4;

async function sessionFiles(root: string): Promise<{ files: string[]; skipped: SkipCounts }> {
	const files: string[] = [];
	const skipped: SkipCounts = {};
	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH) {
			bump(skipped, "deep-directory");
			return;
		}
		const items = await readdir(directory, { withFileTypes: true });
		for (const item of items) {
			const path = join(directory, item.name);
			if (item.isSymbolicLink()) {
				bump(skipped, "symlink");
				continue;
			}
			if (item.isDirectory()) {
				if (isArtifactSegment(item.name)) {
					bump(skipped, "artifact-store");
					continue;
				}
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

export async function harvest(options: HarvestOptions): Promise<{ outDir: string; sessions: SessionSummary[]; incidents: Incident[]; compactions: CompactionObservation[]; skipped: SkipCounts }> {
	const now = options.now ?? new Date();
	const sessionsDir = resolve(options.sessionsDir);
	const rootInfo = await lstat(sessionsDir).catch(() => undefined);
	if (!rootInfo?.isDirectory()) throw new Error(`sessions directory not found: ${sessionsDir} (set --sessions or PI_CODING_AGENT_DIR)`);
	const { files, skipped } = await sessionFiles(sessionsDir);
	const sessions: SessionSummary[] = [];
	const incidents: Incident[] = [];
	const compactions: CompactionObservation[] = [];
	const seenCompactions = new Set<string>();
	const shared = createHarvestShared();
	for (const file of files) {
		const info = await lstat(file);
		if (info.mtime < options.since) {
			bump(skipped, "outside-window");
			continue;
		}
		const lines = await readOptional(file);
		if (!lines) {
			bump(skipped, "unreadable");
			continue;
		}
		const tracePath = join(dirname(file), "observability", `${basename(file).replace(/\.jsonl$/u, "")}.trace.jsonl`);
		const result = analyzeSession(lines, { sessionFile: file, excerpts: options.excerpts, traceLines: await readOptional(tracePath), shared, fileMtimeMs: info.mtimeMs });
		if (!result) {
			bump(skipped, "not-a-session");
			continue;
		}
		if (result.session.userTurns === 0) {
			bump(skipped, "no-user-turns");
			continue;
		}
		sessions.push(result.session);
		incidents.push(...result.incidents);
		compactions.push(...analyzeCompactions(lines, result.incidents, seenCompactions));
	}

	applyRoutineRepeats(sessions, markRoutineRepeats(shared));

	const stamp = now.toISOString().replace(/[:.]/gu, "-");
	const outRoot = resolve(options.outRoot);
	await ensurePrivateDirectory(outRoot);
	const outDir = join(outRoot, `harvest-${stamp}`);
	await ensurePrivateDirectory(outDir);
	const write = (name: string, body: string) => writeFile(join(outDir, name), body, { mode: 0o600, flag: "wx" });
	const since = options.since.toISOString();
	await write("sessions.jsonl", sessions.map((session) => JSON.stringify(session)).join("\n") + (sessions.length ? "\n" : ""));
	await write("incidents.jsonl", incidents.map((incident) => JSON.stringify(incident)).join("\n") + (incidents.length ? "\n" : ""));
	await write("compactions.jsonl", compactions.map((compaction) => JSON.stringify(compaction)).join("\n") + (compactions.length ? "\n" : ""));
	await write(
		"summary.json",
		`${JSON.stringify({ schema: HARVEST_SCHEMA, generatedAt: now.toISOString(), since, sessionsDir, excerpts: options.excerpts, sessions: sessions.length, incidents: incidents.length, skipped, weeks: weeklyMetrics(sessions), compactions: compactionMetrics(compactions) }, null, 2)}\n`,
	);
	await write(
		"report.md",
		renderReport({
			generatedAt: now.toISOString(),
			since,
			sessionsDir,
			sessions,
			incidents,
			skipped,
			compactions,
		}),
	);
	return { outDir, sessions, incidents, compactions, skipped };
}
