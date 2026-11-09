/**
 * Optimization-loop harvester: turns the maintainer's own Pi sessions into a
 * ranked queue of incident candidates and a weekly intervention-rate metric.
 *
 * Zero model calls. Reads session JSONL (and the sibling local trace when
 * present) on this machine only; every output stays under a private local
 * directory and is never meant for Git. Detectors are deterministic and
 * deliberately simple: they rank candidates for human triage, they do not
 * decide that the agent was wrong.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const HARVEST_SCHEMA = "rotom-loop-harvest/v1";

/** Human-side signals: the user had to step in. These form the north-star metric. */
export const INTERVENTION_KINDS = ["user_correction", "user_repeat", "bare_continue", "user_interrupt"] as const;
/** Agent-side signals: something went wrong without (yet) a user reaction. */
export const FAILURE_KINDS = [
	"tool_error_streak",
	"edit_retry_without_read",
	"provider_error",
	"length_stop",
	"goal_pause",
	"compaction_failed",
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type IncidentKind = InterventionKind | FailureKind;

export type Incident = {
	kind: IncidentKind;
	sessionId: string;
	sessionFile: string;
	/** Session entry the incident is anchored to; open/fork the session there to replay. */
	entryId: string;
	timestamp: string;
	detail: Record<string, string | number | boolean>;
	/** Local-only text excerpts; omitted with `excerpts: false`. */
	excerpt?: { user?: string; assistant?: string; error?: string };
};

export type SessionSummary = {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	startedAt: string;
	models: string[];
	userTurns: number;
	assistantMessages: number;
	toolCalls: number;
	toolErrors: number;
	interventions: number;
	failures: number;
	incidentCounts: Partial<Record<IncidentKind, number>>;
};

type Entry = { type: string; id: string; parentId: string | null; timestamp: string; [key: string]: unknown };
type Message = { role: string; [key: string]: unknown };
type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };

const EXCERPT_CHARS = 240;
const MAX_LEAVES = 200;

// Strong-ish phrases only; precision over recall, since every hit costs triage time.
const CORRECTION_PATTERNS: readonly RegExp[] = [
	/^(不对|不是|错了|搞错|理解错)/u,
	/(不对[，,。!！]|不是这样|你搞错|你理解错|理解错了|搞错了)/u,
	/(你没有|你没|你漏了|漏掉了|你忘了|你又)/u,
	/(我说的是|我是说|我的意思是|我让你|不是让你|我要的是|我没让你|我没有让你)/u,
	/(为什么没|为什么不|为什么又|怎么又|又错|还是不行|还是没|还是错)/u,
	/(别再|不要再|不要这样|不需要你|谁让你)/u,
	/\b(that'?s (wrong|not right|not what)|not what i (asked|meant|said|wanted))\b/iu,
	/\b(you (didn'?t|did not|forgot|missed|ignored)|i (said|asked|told you)|why did(n'?t)? you|still (broken|failing|wrong|not working))\b/iu,
	/^(no[,.! ]|wrong\b|stop\b)/iu,
];

const BARE_CONTINUE = new Set([
	"继续", "继续吧", "继续做", "继续啊", "接着", "接着做", "接着来", "往下做", "下一步", "别停", "不要停", "然后呢", "继续执行", "go", "go on",
	"continue", "keep going", "proceed", "next", "carry on", "继续。", "继续!", "继续！",
]);

const READ_TOOLS = new Set(["read", "obs_recall"]);
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch"]);
const BENIGN_GOAL_PAUSES = new Set(["explicit_pause", "session_restored"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Block => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function clip(text: string, fromEnd = false): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	if (flat.length <= EXCERPT_CHARS) return flat;
	return fromEnd ? `…${flat.slice(-EXCERPT_CHARS)}` : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

function normalized(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(text: string): Set<string> {
	const result = new Set<string>();
	for (let index = 0; index < text.length - 1; index++) result.add(text.slice(index, index + 2));
	return result;
}

export function similarity(left: string, right: string): number {
	const a = bigrams(normalized(left));
	const b = bigrams(normalized(right));
	if (a.size === 0 || b.size === 0) return normalized(left) === normalized(right) ? 1 : 0;
	let shared = 0;
	for (const gram of a) if (b.has(gram)) shared++;
	return shared / (a.size + b.size - shared);
}

export function isCorrection(text: string): boolean {
	const head = text.trim().slice(0, 400);
	return head.length > 0 && CORRECTION_PATTERNS.some((pattern) => pattern.test(head));
}

export function isBareContinue(text: string): boolean {
	return BARE_CONTINUE.has(text.trim().toLowerCase().replace(/[。.!！~～]+$/u, "")) || BARE_CONTINUE.has(text.trim());
}

function parseLines(lines: readonly string[]): { header?: Record<string, unknown>; entries: Entry[] } {
	let header: Record<string, unknown> | undefined;
	const entries: Entry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue; // A torn final line from a live session is expected; skip, never guess.
		}
		if (!isRecord(value) || typeof value.type !== "string") continue;
		if (value.type === "session") {
			header ??= value;
			continue;
		}
		if (typeof value.id !== "string" || typeof value.timestamp !== "string") continue;
		entries.push({ ...value, parentId: typeof value.parentId === "string" ? value.parentId : null } as Entry);
	}
	return { header, entries };
}

/** Every root→leaf path through the session tree, capped; incidents dedupe by anchor. */
function paths(entries: readonly Entry[]): Entry[][] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const hasChild = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => id !== null));
	const leaves = entries.filter((entry) => !hasChild.has(entry.id)).slice(-MAX_LEAVES);
	return leaves.map((leaf) => {
		const path: Entry[] = [];
		const seen = new Set<string>();
		for (let cursor: Entry | undefined = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
			seen.add(cursor.id);
			path.push(cursor);
		}
		return path.reverse();
	});
}

function messageOf(entry: Entry): Message | undefined {
	return entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string"
		? (entry.message as Message)
		: undefined;
}

export type AnalyzeOptions = { sessionFile: string; excerpts: boolean; traceLines?: readonly string[] };

export function analyzeSession(lines: readonly string[], options: AnalyzeOptions): { session: SessionSummary; incidents: Incident[] } | undefined {
	const { header, entries } = parseLines(lines);
	if (!header || typeof header.id !== "string") return undefined;
	const sessionId = header.id;
	const incidents = new Map<string, Incident>();
	// A user turn counts once even when several signals fire on it.
	const intervenedUserEntries = new Set<string>();
	let interrupts = 0;
	const add = (incident: Omit<Incident, "sessionId" | "sessionFile">) => {
		const key = `${incident.kind}:${incident.entryId}`;
		if (incidents.has(key)) return;
		incidents.set(key, { ...incident, sessionId, sessionFile: options.sessionFile });
		if (incident.kind === "user_interrupt") interrupts++;
		else if ((INTERVENTION_KINDS as readonly string[]).includes(incident.kind)) intervenedUserEntries.add(incident.entryId);
	};
	const withExcerpt = (excerpt: Incident["excerpt"]) => (options.excerpts ? { excerpt } : {});

	const userEntries = new Set<string>();
	const assistantEntries = new Set<string>();
	const toolCallIds = new Set<string>();
	const toolErrorIds = new Set<string>();
	const models = new Set<string>();

	for (const path of paths(entries)) {
		let lastAssistant: { entry: Entry; message: Message } | undefined;
		const recentUsers: { entry: Entry; text: string }[] = [];
		const callArgs = new Map<string, { name: string; path?: string }>();
		const lastResultByTool = new Map<string, { isError: boolean; streak: number }>();
		const failedEditPaths = new Map<string, string>(); // path -> entryId of failed edit
		let lastGoalPause: string | undefined;

		for (const entry of path) {
			if (entry.type === "custom" && entry.customType === "goal-state" && isRecord(entry.data)) {
				const goal = isRecord(entry.data.goal) ? entry.data.goal : undefined;
				const reason = goal && goal.status === "paused" && typeof goal.stopReason === "string" ? goal.stopReason : undefined;
				const marker = reason ? `${String(goal?.id)}:${reason}` : undefined;
				if (reason && !BENIGN_GOAL_PAUSES.has(reason) && marker !== lastGoalPause) {
					add({ kind: "goal_pause", entryId: entry.id, timestamp: entry.timestamp, detail: { reason } });
				}
				lastGoalPause = marker;
				continue;
			}
			const message = messageOf(entry);
			if (!message) continue;

			if (message.role === "user") {
				userEntries.add(entry.id);
				const text = textOf(message.content);
				const previousAssistantText = lastAssistant ? textOf(lastAssistant.message.content) : "";
				const excerpt = { user: clip(text), assistant: previousAssistantText ? clip(previousAssistantText, true) : undefined };
				if (lastAssistant && isBareContinue(text) && lastAssistant.message.stopReason === "stop") {
					add({ kind: "bare_continue", entryId: entry.id, timestamp: entry.timestamp, detail: {}, ...withExcerpt(excerpt) });
				} else if (lastAssistant && isCorrection(text)) {
					add({ kind: "user_correction", entryId: entry.id, timestamp: entry.timestamp, detail: {}, ...withExcerpt(excerpt) });
				}
				if (normalized(text).length >= 12) {
					const repeated = recentUsers.find((previous) => similarity(previous.text, text) >= 0.8);
					// Re-sending after a provider error or an interrupt is not the agent ignoring the request.
					const resentAfterFailure = lastAssistant?.message.stopReason === "error" || lastAssistant?.message.stopReason === "aborted";
					if (repeated && lastAssistant && !resentAfterFailure) {
						add({
							kind: "user_repeat",
							entryId: entry.id,
							timestamp: entry.timestamp,
							detail: { repeatsEntry: repeated.entry.id },
							...withExcerpt(excerpt),
						});
					}
				}
				recentUsers.push({ entry, text });
				if (recentUsers.length > 3) recentUsers.shift();
				lastResultByTool.clear();
				failedEditPaths.clear();
				continue;
			}

			if (message.role === "assistant") {
				assistantEntries.add(entry.id);
				lastAssistant = { entry, message };
				if (typeof message.provider === "string" && typeof message.model === "string") models.add(`${message.provider}/${message.model}`);
				const blocks = Array.isArray(message.content) ? (message.content as unknown[]).filter(isRecord) as Block[] : [];
				for (const block of blocks) {
					if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
					toolCallIds.add(`${entry.id}:${block.id}`);
					const target = isRecord(block.arguments) && typeof block.arguments.path === "string" ? block.arguments.path : undefined;
					callArgs.set(block.id, { name: block.name, path: target });
					if (target && EDIT_TOOLS.has(block.name) && failedEditPaths.has(target)) {
						add({
							kind: "edit_retry_without_read",
							entryId: entry.id,
							timestamp: entry.timestamp,
							detail: { tool: block.name, failedAt: failedEditPaths.get(target) ?? "" },
						});
						failedEditPaths.delete(target);
					}
					if (target && READ_TOOLS.has(block.name)) failedEditPaths.delete(target);
				}
				const errorText = typeof message.errorMessage === "string" ? message.errorMessage : "";
				if (message.stopReason === "aborted") {
					add({ kind: "user_interrupt", entryId: entry.id, timestamp: entry.timestamp, detail: {} });
				} else if (message.stopReason === "error") {
					add({ kind: "provider_error", entryId: entry.id, timestamp: entry.timestamp, detail: {}, ...withExcerpt({ error: clip(errorText) }) });
				} else if (message.stopReason === "length") {
					add({ kind: "length_stop", entryId: entry.id, timestamp: entry.timestamp, detail: {} });
				}
				continue;
			}

			if (message.role === "toolResult") {
				const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
				const isError = message.isError === true;
				if (isError) toolErrorIds.add(entry.id);
				const previous = lastResultByTool.get(toolName);
				const streak = isError ? (previous?.isError ? previous.streak + 1 : 1) : 0;
				lastResultByTool.set(toolName, { isError, streak });
				if (streak === 2) {
					add({
						kind: "tool_error_streak",
						entryId: entry.id,
						timestamp: entry.timestamp,
						detail: { tool: toolName },
						...withExcerpt({ error: clip(textOf(message.content)) }),
					});
				}
				const call = typeof message.toolCallId === "string" ? callArgs.get(message.toolCallId) : undefined;
				if (isError && call?.path && EDIT_TOOLS.has(toolName)) failedEditPaths.set(call.path, entry.id);
			}
		}
	}

	for (const line of options.traceLines ?? []) {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(record) && record.kind === "span_end" && record.name === "pi.session.compaction" && record.status === "error") {
			add({
				kind: "compaction_failed",
				entryId: typeof record.spanId === "string" ? `trace:${record.spanId}` : "trace",
				timestamp: typeof record.timestamp === "string" ? record.timestamp : String(header.timestamp ?? ""),
				detail: {},
			});
		}
	}

	const list = [...incidents.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
	const incidentCounts: Partial<Record<IncidentKind, number>> = {};
	for (const incident of list) incidentCounts[incident.kind] = (incidentCounts[incident.kind] ?? 0) + 1;
	const interventions = intervenedUserEntries.size + interrupts;
	const failures = FAILURE_KINDS.reduce((sum, kind) => sum + (incidentCounts[kind] ?? 0), 0);
	return {
		session: {
			sessionId,
			sessionFile: options.sessionFile,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			startedAt: typeof header.timestamp === "string" ? header.timestamp : "",
			models: [...models].sort(),
			userTurns: userEntries.size,
			assistantMessages: assistantEntries.size,
			toolCalls: toolCallIds.size,
			toolErrors: toolErrorIds.size,
			interventions,
			failures,
			incidentCounts,
		},
		incidents: list,
	};
}

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
	for (const file of files) {
		const info = await lstat(file);
		if (info.mtime < options.since) continue;
		const lines = await readOptional(file);
		if (!lines) {
			skipped++;
			continue;
		}
		const tracePath = join(dirname(file), "observability", `${basename(file).replace(/\.jsonl$/u, "")}.trace.jsonl`);
		const result = analyzeSession(lines, { sessionFile: file, excerpts: options.excerpts, traceLines: await readOptional(tracePath) });
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
