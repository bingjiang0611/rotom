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
	unknownEntries: number;
}

export function buildCards(options?: {
	root?: string;
	out?: string;
	since?: string;
	limit?: number;
}): Promise<BuildSummary>;

export function collectLabels(options?: { out?: string }): Promise<{
	labeled: number;
	pass: number;
	fail: number;
	categories: Record<string, number>;
}>;
