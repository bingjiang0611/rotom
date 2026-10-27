import type { FindingStatus, RuleId } from "./trace-assertions.mjs";
import type { Readable, Writable } from "node:stream";
import type { ReviewCounts } from "./review.mjs";
import type { AggregateMetrics } from "./session-metrics.mjs";
import type { AggregateBreakdown } from "./error-breakdown.mjs";
import type { AggregateCommandFailures } from "./command-failures.mjs";

export interface BuildSummary {
	generated: number;
	skipped: number;
	skippedOversized: number;
	skippedInvalidHeader: number;
	skippedEmpty: number;
	skippedDuplicate: number;
	traceMissing: number;
	tracePartial: number;
	parseErrors: number;
	sessionParseErrors: number;
	traceParseErrors: number;
	badJson: number;
	lineTooLong: number;
	entryMissingId: number;
	danglingParent: number;
	cycle: number;
	messageMissing: number;
	findings: Record<RuleId, Record<FindingStatus, number>>;
	unknownEntries: number;
	invalidHeaderKinds: Record<string, number>;
	invalidHeaderKeySets: Record<string, number>;
	sessionVersions: Record<"1" | "2" | "3" | "missing", number>;
	/** Present only for --focus builds. */
	focusScanned?: number;
	focusMatched?: number;
	focusConditions?: { toolErrors: number; ruleHit: number; endedWithoutFinalText: number; endedOnProviderError: number };
}

export interface StatsSummary {
	sessions: number;
	unknownWeek: number;
	unknownModel: number;
	weeks: AggregateMetrics["weeks"];
	models: AggregateMetrics["models"];
	skipped: number;
	skippedOversized: number;
	skippedInvalidHeader: number;
	skippedEmpty: number;
	skippedDuplicate: number;
	traceMissing: number;
	tracePartial: number;
	parseErrors: number;
}

export function buildCards(options?: {
	root?: string;
	out?: string;
	since?: string;
	limit?: number;
	focus?: boolean;
}): Promise<BuildSummary>;

export function sessionStats(options?: {
	root?: string;
	since?: string;
	out?: string;
}): Promise<StatsSummary>;

export interface BreakdownSummary extends AggregateBreakdown {
	commandFailures: AggregateCommandFailures;
	skipped: number;
	skippedOversized: number;
	skippedInvalidHeader: number;
	skippedEmpty: number;
	skippedDuplicate: number;
	traceMissing: number;
	tracePartial: number;
	parseErrors: number;
}

/** Aggregate metadata and in-memory command classification; session ids stay in `<out>/../breakdown.md`. */
export function errorBreakdown(options?: {
	root?: string;
	since?: string;
	out?: string;
}): Promise<BreakdownSummary>;

export function reviewCards(options?: {
	out?: string;
	limit?: number;
	input?: Readable;
	output?: Writable;
}): Promise<ReviewCounts>;

export function collectLabels(options?: { out?: string }): Promise<{
	labeled: number;
	pass: number;
	fail: number;
	failSet: number;
	conflicts: number;
	categories: Record<string, number>;
}>;
