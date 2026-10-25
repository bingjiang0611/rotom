import type { Finding, RuleId, SessionEntry } from "./trace-assertions.mjs";

export interface SessionMetrics {
	startedAt: string | null;
	week: string | null;
	durationMs: number | null;
	models: string[];
	assistantTurns: number;
	toolCalls: number;
	/** Ended trace spans whose outcome is not "ok"; null when the trace is missing. */
	toolErrors: number | null;
	endedToolSpans: number | null;
	toolErrorRate: number | null;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	costUsd: number | null;
	costPartial: boolean;
	oversizedResults: number | null;
	endedWithoutFinalText: boolean | null;
	endedOnProviderError: boolean | null;
	ruleHits: RuleId[];
}

export interface NumericStat {
	n: number;
	median: number | null;
	p90: number | null;
}

export interface ShareStat {
	n: number;
	count: number;
	share: number | null;
}

export interface GroupSummary {
	sessions: number;
	toolCalls: NumericStat;
	durationMs: NumericStat;
	tokens: NumericStat;
	toolErrorRate: { n: number; errors: number; endedSpans: number; rate: number | null };
	endedWithoutFinalText: ShareStat;
	endedOnProviderError: ShareStat;
	ruleHits: Record<RuleId, ShareStat>;
	costUsd: { n: number; total: number | null; partial: boolean; partialSessions: number };
}

export interface AggregateMetrics {
	unknownWeek: number;
	unknownModel: number;
	weeks: Array<GroupSummary & { week: string }>;
	models: Array<GroupSummary & { model: string }>;
}

export interface FocusDecision {
	matched: boolean;
	conditions: { toolErrors: boolean; ruleHit: boolean; endedWithoutFinalText: boolean; endedOnProviderError: boolean };
}

export const FOCUS_TOOL_ERRORS_MIN: number;
export const FOCUS_TOOL_ERROR_RATE_MIN: number;

export function sessionMetrics(input: {
	header?: { timestamp?: unknown } & Record<string, unknown>;
	branch: readonly SessionEntry[];
	traceTools: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	traceStatus: "ok" | "partial" | "missing";
	findings?: readonly Finding[];
}): SessionMetrics;

export function focusCandidate(metrics: SessionMetrics): FocusDecision;

export function aggregateMetrics(rows: readonly SessionMetrics[]): AggregateMetrics;
