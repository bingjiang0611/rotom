/**
 * Optimization-loop harvester analysis: turns one Pi session into incident candidates.
 *
 * Zero model calls. Reads session JSONL (and the sibling local trace when present) on this
 * machine only; every output stays under a private local directory and is never meant for Git.
 * Detectors are deterministic and deliberately simple: they rank candidates for human triage,
 * they do not decide that the agent was wrong.
 */

import { providerDetail, traceErrorSpans } from "./harvest-provider.ts";

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
/** Independent of the run, a paused Goal needs no action; the cause is already an incident. */
const BENIGN_GOAL_PAUSES = new Set(["explicit_pause", "session_restored", "agent_interruption"]);
/**
 * Action Fusion appends the follow-up command outcome to the mutation result. A failed fused
 * run means the command after the edit failed, not that the file was left unchanged.
 */
const THEN_RUN_FAILED = "[then_run:failed]";
/** `/skill:<name>` expands into this block; only the text after it is what the user typed. */
const SKILL_BLOCK = /^<skill name="[^"]*" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/u;

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

/** The part of a user message the human wrote; a skill template is injected text, not a request. */
function humanText(text: string): string {
	const match = text.match(SKILL_BLOCK);
	return match ? (match[1] ?? "").trim() : text;
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

export type AnalyzeOptions = { sessionFile: string; excerpts: boolean; traceLines?: readonly string[]; shared?: HarvestShared };
/**
 * Harvest-wide state. Forks copy their parent's entries, so a conversation continued in a
 * second session file must not count its user turns or incidents twice.
 */
export type HarvestShared = { incidentKeys: Set<string>; userEntries: Set<string> };

export function createHarvestShared(): HarvestShared {
	return { incidentKeys: new Set<string>(), userEntries: new Set<string>() };
}

export function analyzeSession(lines: readonly string[], options: AnalyzeOptions): { session: SessionSummary; incidents: Incident[] } | undefined {
	const { header, entries } = parseLines(lines);
	if (!header || typeof header.id !== "string") return undefined;
	const sessionId = header.id;
	const shared = options.shared ?? createHarvestShared();
	const incidents = new Map<string, Incident>();
	// A user turn counts once even when several signals fire on it.
	const intervenedUserEntries = new Set<string>();
	let interrupts = 0;
	const add = (incident: Omit<Incident, "sessionId" | "sessionFile">) => {
		const key = `${incident.kind}:${incident.entryId}`;
		if (incidents.has(key) || shared.incidentKeys.has(key)) return;
		incidents.set(key, { ...incident, sessionId, sessionFile: options.sessionFile });
		shared.incidentKeys.add(key);
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
		const callArgs = new Map<string, { name: string; path?: string; action: string }>();
		const lastResultByAction = new Map<string, { isError: boolean; streak: number }>();
		const failedEditPaths = new Map<string, string>(); // path -> entryId of failed edit
		let lastGoalPause: string | undefined;
		// A retrying provider produces one failed request per attempt; that is one incident.
		let errorRun: { entryId: string; attempts: number; incident?: Incident } | undefined;
		const providerSpans = traceErrorSpans(options.traceLines);

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
				const isNewTurn = !shared.userEntries.has(entry.id);
				if (isNewTurn) {
					shared.userEntries.add(entry.id);
					userEntries.add(entry.id);
				}
				const text = humanText(textOf(message.content));
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
				lastResultByAction.clear();
				failedEditPaths.clear();
				errorRun = undefined;
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
					const command = isRecord(block.arguments) && typeof block.arguments.command === "string" ? block.arguments.command : undefined;
					callArgs.set(block.id, { name: block.name, path: target, action: `${block.name}\u0000${command ?? target ?? ""}` });
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
					errorRun = undefined;
					add({ kind: "user_interrupt", entryId: entry.id, timestamp: entry.timestamp, detail: {} });
				} else if (message.stopReason === "error") {
					if (errorRun) {
						errorRun.attempts++;
						if (errorRun.incident) errorRun.incident.detail.attempts = errorRun.attempts;
					} else {
						const detail = providerDetail({
							provider: typeof message.provider === "string" ? message.provider : "unknown",
							model: typeof message.model === "string" ? message.model : "unknown",
							errorMessage: errorText,
							spans: providerSpans,
							timestamp: entry.timestamp,
						});
						errorRun = { entryId: entry.id, attempts: 1 };
						add({ kind: "provider_error", entryId: entry.id, timestamp: entry.timestamp, detail: { attempts: 1, ...detail, final: false }, ...withExcerpt({ error: clip(errorText) }) });
						errorRun.incident = incidents.get(`provider_error:${entry.id}`);
					}
				} else if (message.stopReason === "length") {
					errorRun = undefined;
					add({ kind: "length_stop", entryId: entry.id, timestamp: entry.timestamp, detail: {} });
				} else {
					// A usable answer ends the retry run: the provider failure did not reach the user.
					if (errorRun?.incident) errorRun.incident.detail.final = true;
					errorRun = undefined;
				}
				continue;
			}

			if (message.role === "toolResult") {
				const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
				const resultText = textOf(message.content);
				const isError = message.isError === true;
				if (isError) toolErrorIds.add(entry.id);
				// A failed fused follow-up is a command outcome; the mutation itself was applied.
				const mutationFailed = isError && !resultText.includes(THEN_RUN_FAILED);
				const call = typeof message.toolCallId === "string" ? callArgs.get(message.toolCallId) : undefined;
				const action = call?.action ?? toolName;
				const previous = lastResultByAction.get(action);
				const streak = mutationFailed ? (previous?.isError ? previous.streak + 1 : 1) : 0;
				lastResultByAction.set(action, { isError: mutationFailed, streak });
				if (streak === 2) {
					add({
						kind: "tool_error_streak",
						entryId: entry.id,
						timestamp: entry.timestamp,
						detail: { tool: toolName },
						...withExcerpt({ error: clip(resultText) }),
					});
				}
				if (mutationFailed && call?.path && EDIT_TOOLS.has(toolName)) failedEditPaths.set(call.path, entry.id);
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
