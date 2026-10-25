/** Parsed local trace record; only the metadata fields below are consulted. */
export interface TraceRecord {
	schema?: string;
	kind?: "span_start" | "span_end" | string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	name?: string;
	status?: string;
	attributes?: Record<string, string | number | boolean>;
}

export interface ToolCombination {
	outcome: string;
	faultSide: string;
	errorCode: string;
	count: number;
}

export interface ToolErrorRow {
	tool: string;
	endedSpans: number;
	errors: number;
	/** Ended spans with outcome "aborted"; included in errors, listed separately. */
	aborted: number;
	combinations: ToolCombination[];
}

export interface ValueCount {
	value: string;
	count: number;
}

export interface ProviderErrorRow {
	provider: string;
	model: string;
	category: string;
	count: number;
	httpStatus: Record<string, number>;
	qoderErrorCode: Record<string, number>;
	transportPhase: Record<string, number>;
	endReason: Record<string, number>;
	stopReason: Record<string, number>;
}

export interface ProviderErrorRows {
	requests: number;
	errors: number;
	abortedRequests: number;
	rows: ProviderErrorRow[];
	/** Last failed request in record order, with the failure count of its own run. */
	lastFailedRequest: { status: string; runErrorRequests: number };
}

export interface AggregateToolRow extends ToolErrorRow {
	/** errors / endedSpans; null when the session had no ended tool span. */
	rate: number | null;
	/** errors / all tool errors; null when nothing failed. */
	share: number | null;
}

export interface AggregateProviderRow extends Omit<ProviderErrorRow, "httpStatus" | "qoderErrorCode" | "transportPhase" | "endReason" | "stopReason"> {
	share: number | null;
	httpStatus: ValueCount[];
	qoderErrorCode: ValueCount[];
	transportPhase: ValueCount[];
	endReason: ValueCount[];
	stopReason: ValueCount[];
}

export interface AggregateBreakdown {
	sessions: number;
	toolTotals: { endedSpans: number; errors: number; aborted: number };
	tools: AggregateToolRow[];
	concentration: { sessionsWithErrors: number; topSessions: number; topErrors: number; errors: number; share: number | null };
	providerTotals: { requests: number; errors: number; abortedRequests: number };
	providers: AggregateProviderRow[];
	providerEnd: {
		sessions: number;
		/** Sessions whose last failed request shared its run with another failure. */
		runRetried: number;
		/** Sessions with at least two failed provider requests in total. */
		sessionRetried: number;
		single: number;
	};
}

export interface BreakdownSession {
	toolRows: ToolErrorRow[];
	provider: ProviderErrorRows;
	endedOnProviderError: boolean;
}

export const TOOL_SPAN: "pi.tool.execute";
export const PROVIDER_SPAN: "pi.ai.request";
export const MISSING: "(none)";
export const TOP_COMBINATIONS: number;
export const TOP_VALUES: number;
export function toolErrorRows(traceRecords: readonly TraceRecord[]): ToolErrorRow[];
export function providerErrorRows(traceRecords: readonly TraceRecord[]): ProviderErrorRows;
export function aggregateBreakdown(sessions: readonly BreakdownSession[]): AggregateBreakdown;
