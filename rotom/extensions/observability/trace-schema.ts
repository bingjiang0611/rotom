export const LOCAL_TRACE_SCHEMA_V1 = "rotom-local-trace/v1";
export const PROVIDER_METADATA_EVENT = "rotom:provider:metadata:v1";

export type TraceStatus = "ok" | "error" | "aborted" | "unknown";
type TraceAttribute = string | number | boolean | string[] | number[] | boolean[];
export type TraceAttributes = Record<string, TraceAttribute>;

export type TraceRecord = {
	schema: typeof LOCAL_TRACE_SCHEMA_V1;
	kind: "span_start" | "span_end";
	timestamp: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes?: TraceAttributes;
	status?: TraceStatus;
	durationMs?: number;
};

export function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function boundedTag(value: unknown, maximum = 256): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum);
}

export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
