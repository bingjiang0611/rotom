#!/usr/bin/env node
/**
 * Stage-0 offline statistics for same-session rollover (design 9.1).
 *
 * Reads session JSONL files and a local model store. Never calls a model, never uses
 * the network, never writes. Output contains aggregate counts and distributions only:
 * no message content, no paths, no session ids. Model ids are allowed because the
 * rollover water mark is derived per model window.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_RESERVE_TOKENS = 16_384;
export const CANDIDATE_RESERVE_MULTIPLES = [2, 3, 4];
const SKIPPED_DIRECTORIES = new Set(["observability", "node_modules"]);

/** Pi's own context accounting: total tokens, else the usage fields summed (absent fields are 0). */
export function contextTokens(usage) {
	if (!usage) return 0;
	const field = (name) => (Number.isFinite(usage[name]) ? usage[name] : 0);
	return usage.totalTokens || field("input") + field("output") + field("cacheRead") + field("cacheWrite");
}

/**
 * `provider/modelId` -> context window from Pi's model sources. Both shapes are accepted:
 * the models store is keyed by provider, the user models file nests them under `providers`.
 * Models without a positive window stay unresolved instead of being guessed.
 */
export function loadContextWindows(store) {
	const windows = new Map();
	const providers = store?.providers && typeof store.providers === "object" ? store.providers : store;
	for (const [provider, entry] of Object.entries(providers ?? {})) {
		for (const model of entry?.models ?? []) {
			if (typeof model?.id !== "string" || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) continue;
			windows.set(`${provider}/${model.id}`, model.contextWindow);
		}
	}
	return windows;
}

export function userReserveTokens(settings) {
	const value = settings?.compaction?.reserveTokens;
	// Only an explicit positive integer is a readable user setting; anything else keeps Pi's default.
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_RESERVE_TOKENS;
}

/** Parse one session file body into ordered entries; a malformed line is not recovered. */
export function parseSessionBody(text) {
	const entries = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return null;
		}
		entries.push(parsed);
	}
	if (entries[0]?.type !== "session") return null;
	return entries.slice(1);
}

/** Current leaf path: the last entry is the leaf; anything off that chain is another branch. */
export function buildBranch(entries) {
	if (!entries.length) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch = [];
	let cursor = entries.at(-1);
	const seen = new Set();
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		branch.push(cursor);
		cursor = cursor.parentId === null || cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
	}
	return branch.reverse();
}

/** Requests are assistant messages with usable usage, matching Pi's compaction accounting. */
function requestOf(entry) {
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message?.role !== "assistant") return null;
	if (message.stopReason === "aborted" || message.stopReason === "error") return null;
	const tokens = contextTokens(message.usage);
	return tokens > 0 ? tokens : null;
}

function segmentsOf(branch) {
	const segments = [];
	let current = [];
	const flush = () => {
		if (current.length) segments.push(current);
		current = [];
	};
	for (const [index, entry] of branch.entries()) {
		if (entry.type === "compaction") {
			flush();
			continue;
		}
		current.push([index, entry]);
	}
	flush();
	return segments;
}

/**
 * Turn ownership over the whole branch. Compaction entries end a segment but not a turn: Pi can
 * compact in the middle of a turn and keep requesting, so a segment-local view would count that
 * crossing as a turn end.
 */
function turnOwnershipOf(branch) {
	const userIndexes = [];
	branch.forEach((entry, index) => {
		if (entry.type === "message" && entry.message?.role === "user") userIndexes.push(index);
	});
	const turnKeyOf = (index) => userIndexes.filter((userIndex) => userIndex < index).at(-1) ?? -1;
	const lastRequestOfTurn = new Map();
	branch.forEach((entry, index) => {
		if (requestOf(entry) === null) return;
		lastRequestOfTurn.set(turnKeyOf(index), index);
	});
	return (index) => lastRequestOfTurn.get(turnKeyOf(index)) === index;
}

/**
 * Analyze one session. Turn boundaries are user messages; an inter-turn point is the
 * moment right after a turn's last request, before the next user message.
 */
export function analyzeSession(entries, { windows, reserveTokens = DEFAULT_RESERVE_TOKENS }) {
	const result = {
		segments: 0,
		unknownWindowSegments: 0,
		requests: 0,
		crossingSegments: 0,
		midTurnCrossings: 0,
		turnEndCrossings: 0,
		takeover: Object.fromEntries(CANDIDATE_RESERVE_MULTIPLES.map((multiple) => [multiple, 0])),
		firstCrossingTakeover: Object.fromEntries(CANDIDATE_RESERVE_MULTIPLES.map((multiple) => [multiple, 0])),
		goalActiveCrossings: 0,
		goalUnknownCrossings: 0,
		turnGrowth: [],
		requestsByModel: {},
	};
	// The model in effect and an active Goal both survive a compaction boundary, so they are
	// tracked across the branch while segment accounting restarts.
	let modelKey = null;
	let goalStatus = "none";
	let goalKnown = true;
	const branch = buildBranch(entries);
	const isLastRequestOfTurn = turnOwnershipOf(branch);
	for (const segment of segmentsOf(branch)) {
		result.segments++;
		const requests = [];
		const userIndexes = [];
		for (const [index, entry] of segment) {
			if (entry.type === "model_change") {
				modelKey = `${entry.provider}/${entry.modelId}`;
				continue;
			}
			if (entry.type === "custom" && entry.customType === "goal-state") {
				const status = entry.data?.goal?.status;
				if (typeof status === "string") goalStatus = status;
				else goalKnown = false;
				continue;
			}
			if (entry.type === "message" && entry.message?.role === "user") userIndexes.push(index);
			const tokens = requestOf(entry);
			if (tokens === null) continue;
			requests.push({
				index,
				tokens,
				window: modelKey ? (windows.get(modelKey) ?? null) : null,
				modelKey,
				goal: goalKnown ? goalStatus : "unknown",
				isTurnEnd: isLastRequestOfTurn(index),
			});
		}
		result.requests += requests.length;
		for (const request of requests) {
			if (request.modelKey) result.requestsByModel[request.modelKey] = (result.requestsByModel[request.modelKey] ?? 0) + 1;
		}
		if (!requests.length) continue;
		if (requests.some((request) => request.window === null)) {
			result.unknownWindowSegments++;
			continue;
		}
		const turns = [];
		for (const request of requests) {
			const key = userIndexes.filter((userIndex) => userIndex < request.index).at(-1) ?? -1;
			if (turns.at(-1)?.key !== key) turns.push({ key, requests: [] });
			turns.at(-1).requests.push(request);
		}
		for (const turn of turns) {
			if (turn.requests.length > 1) result.turnGrowth.push(turn.requests.at(-1).tokens - turn.requests[0].tokens);
		}
		const crossingIndex = requests.findIndex((request) => request.tokens > request.window - reserveTokens);
		if (crossingIndex < 0) continue;
		const crossing = requests[crossingIndex];
		const crossingTurnIndex = turns.findIndex((turn) => turn.requests.includes(crossing));
		const isFirstCrossing = result.crossingSegments === 0;
		result.crossingSegments++;
		if (crossing.isTurnEnd) result.turnEndCrossings++;
		else result.midTurnCrossings++;
		if (crossing.goal === "active") result.goalActiveCrossings++;
		else if (crossing.goal === "unknown") result.goalUnknownCrossings++;
		const earlierTurns = turns.slice(0, crossingTurnIndex);
		for (const multiple of CANDIDATE_RESERVE_MULTIPLES) {
			// The inter-turn point of an earlier turn is the last request of that turn.
			const takeover = earlierTurns.some((turn) => {
				const last = turn.requests.at(-1);
				return last.tokens > last.window - multiple * reserveTokens;
			});
			if (!takeover) continue;
			result.takeover[multiple]++;
			// The gate asks whether a session could be taken over before its first native
			// compaction, so only the first crossing segment counts per session.
			if (isFirstCrossing) result.firstCrossingTakeover[multiple]++;
		}
	}
	return result;
}

function percentile(sorted, fraction) {
	if (!sorted.length) return null;
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[rank];
}

export function aggregate(analyses, { reserveTokens = DEFAULT_RESERVE_TOKENS } = {}) {
	const totals = { sessions: analyses.length, sessionsWithCrossing: 0, sessionsSupplyingTakeover: {}, segments: 0, unknownWindowSegments: 0, requests: 0, crossingSegments: 0, midTurnCrossings: 0, turnEndCrossings: 0, goalActiveCrossings: 0, goalUnknownCrossings: 0 };
	const takeover = Object.fromEntries(CANDIDATE_RESERVE_MULTIPLES.map((multiple) => [multiple, 0]));
	const growth = [];
	const requestsByModel = {};
	for (const analysis of analyses) {
		totals.segments += analysis.segments;
		totals.unknownWindowSegments += analysis.unknownWindowSegments;
		totals.requests += analysis.requests;
		totals.crossingSegments += analysis.crossingSegments;
		totals.midTurnCrossings += analysis.midTurnCrossings;
		totals.turnEndCrossings += analysis.turnEndCrossings;
		totals.goalActiveCrossings += analysis.goalActiveCrossings;
		totals.goalUnknownCrossings += analysis.goalUnknownCrossings;
		growth.push(...analysis.turnGrowth);
		for (const [model, count] of Object.entries(analysis.requestsByModel)) requestsByModel[model] = (requestsByModel[model] ?? 0) + count;
		if (analysis.crossingSegments > 0) {
			totals.sessionsWithCrossing++;
			for (const multiple of CANDIDATE_RESERVE_MULTIPLES) {
				takeover[multiple] += analysis.takeover[multiple];
				if (analysis.firstCrossingTakeover[multiple] > 0) totals.sessionsSupplyingTakeover[multiple] = (totals.sessionsSupplyingTakeover[multiple] ?? 0) + 1;
			}
		}
	}
	growth.sort((left, right) => left - right);
	const candidates = CANDIDATE_RESERVE_MULTIPLES.map((multiple) => ({
		reserveMultiples: multiple,
		waterMark: `contextWindow - ${multiple} x reserveTokens`,
		takeoverSegments: takeover[multiple],
		takeoverSegmentShare: totals.crossingSegments ? takeover[multiple] / totals.crossingSegments : null,
		takeoverSessions: totals.sessionsSupplyingTakeover[multiple] ?? 0,
		takeoverSessionShare: totals.sessionsWithCrossing ? (totals.sessionsSupplyingTakeover[multiple] ?? 0) / totals.sessionsWithCrossing : null,
	}));
	return {
		schema: "rotom-rollover-stage0/v1",
		reserveTokens,
		totals,
		candidates,
		turnGrowth: {
			samples: growth.length,
			p50: percentile(growth, 0.5),
			p90: percentile(growth, 0.9),
			max: growth.length ? growth.at(-1) : null,
		},
		requestsByModel,
	};
}

/**
 * The design gate: at least half of the sessions that hit native threshold compaction could have
 * been taken over at an inter-turn point *before their first native compaction*, so the session
 * share reads `firstCrossingTakeover` (segment share still counts every crossing segment). Among
 * the qualifying candidates the latest one wins, i.e. the smallest reserve multiplier: its water
 * mark sits closest to the compaction threshold, so it changes existing behavior the least.
 */
export function judge(report, { threshold = 0.5 } = {}) {
	const qualifies = (candidate) => (candidate.takeoverSessionShare ?? 0) >= threshold;
	const passing = report.candidates.filter(qualifies);
	const selected = passing[0] ?? null;
	return {
		threshold,
		passed: Boolean(selected),
		selectedReserveMultiples: selected?.reserveMultiples ?? null,
		selectedWaterMark: selected?.waterMark ?? null,
		considered: report.candidates.map((candidate) => ({ reserveMultiples: candidate.reserveMultiples, takeoverSessionShare: candidate.takeoverSessionShare, takeoverSegmentShare: candidate.takeoverSegmentShare })),
	};
}

export function formatReport(report, verdict) {
	const share = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
	const lines = [
		"stage-0 rollover statistics (aggregate only)",
		`sessions=${report.totals.sessions} sessionsWithCrossing=${report.totals.sessionsWithCrossing} segments=${report.totals.segments} unknownWindowSegments=${report.totals.unknownWindowSegments}`,
		`requests=${report.totals.requests} crossingSegments=${report.totals.crossingSegments} midTurn=${report.totals.midTurnCrossings} turnEnd=${report.totals.turnEndCrossings}`,
		`goalActiveCrossings=${report.totals.goalActiveCrossings} goalUnknownCrossings=${report.totals.goalUnknownCrossings}`,
		`turnGrowth samples=${report.turnGrowth.samples} p50=${report.turnGrowth.p50 ?? "n/a"} p90=${report.turnGrowth.p90 ?? "n/a"} max=${report.turnGrowth.max ?? "n/a"}`,
	];
	for (const candidate of report.candidates) {
		lines.push(`candidate ${candidate.waterMark}: segments=${candidate.takeoverSegments} share=${share(candidate.takeoverSegmentShare)} sessions=${candidate.takeoverSessions} share=${share(candidate.takeoverSessionShare)}`);
	}
	lines.push(`gate>=${share(verdict.threshold)} passed=${verdict.passed} selected=${verdict.selectedWaterMark ?? "none"}`);
	return `${lines.join("\n")}\n`;
}

/** Session files only; observability traces and dependency trees are not sessions. */
export async function listSessionFiles(root) {
	const files = [];
	const walk = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name));
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.endsWith(".trace.jsonl")) continue;
			files.push(join(directory, entry.name));
		}
	};
	await walk(root);
	return files.sort();
}

export function defaultAgentDirectory(environment = process.env, home = homedir()) {
	const configured = environment.PI_CODING_AGENT_DIR?.trim();
	return resolve(configured ? configured : join(home, ".pi", "agent"));
}

export async function collect({ sessionDirectory, modelsPaths = [], settingsPath, reserveTokens, onSkip } = {}) {
	const windows = new Map();
	for (const modelsPath of modelsPaths) {
		// An unreadable or absent model source is not an error: those segments stay unknown.
		try {
			for (const [key, window] of loadContextWindows(JSON.parse(await readFile(modelsPath, "utf8")))) windows.set(key, window);
		} catch {}
	}
	let reserve = reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	if (reserveTokens === undefined && settingsPath) {
		try {
			reserve = userReserveTokens(JSON.parse(await readFile(settingsPath, "utf8")));
		} catch {
			reserve = DEFAULT_RESERVE_TOKENS;
		}
	}
	const analyses = [];
	for (const file of await listSessionFiles(sessionDirectory)) {
		let entries;
		try {
			entries = parseSessionBody(await readFile(file, "utf8"));
		} catch {
			entries = null;
		}
		if (!entries) {
			onSkip?.();
			continue;
		}
		analyses.push(analyzeSession(entries, { windows, reserveTokens: reserve }));
	}
	return aggregate(analyses, { reserveTokens: reserve });
}

async function main() {
	const args = process.argv.slice(2);
	const options = { sessionDirectory: undefined, modelsPath: undefined, reserveTokens: undefined, json: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--sessions") options.sessionDirectory = resolve(args[++index]);
		else if (arg === "--models") options.modelsPath = resolve(args[++index]);
		else if (arg === "--reserve-tokens") options.reserveTokens = Number(args[++index]);
		else throw new Error(`unknown argument: ${arg}`);
	}
	const agentDirectory = defaultAgentDirectory();
	let skipped = 0;
	const report = await collect({
		sessionDirectory: options.sessionDirectory ?? join(agentDirectory, "sessions"),
		// The user models file wins over the cached catalog for the same provider/model pair.
		modelsPaths: [join(agentDirectory, "models-store.json"), join(agentDirectory, "models.json")],
		settingsPath: join(agentDirectory, "settings.json"),
		reserveTokens: options.reserveTokens,
		onSkip: () => skipped++,
	});
	const output = { ...report, skippedFiles: skipped };
	if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	else process.stdout.write(formatReport(output, judge(output)));
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
