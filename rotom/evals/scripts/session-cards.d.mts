import type { FindingStatus, RuleId } from "./trace-assertions.mjs";
import type { Readable, Writable } from "node:stream";
import type { ReviewCounts } from "./review.mjs";

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
}

export function buildCards(options?: {
	root?: string;
	out?: string;
	since?: string;
	limit?: number;
}): Promise<BuildSummary>;

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
	categories: Record<string, number>;
}>;
