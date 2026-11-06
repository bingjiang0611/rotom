// Trace summarisation. The full file is written to disk and its path returned; the model
// gets counts and the slowest entries instead of a multi-megabyte JSON blob.
//
// Chrome trace events are microsecond-based: `dur` is µs, `ts` is µs from tracing start.

export const MAX_TRACE_EVENTS_V1 = 500_000;
export const TRACE_LONG_TASK_MS_V1 = 50;
const TOP_ENTRIES_V1 = 10;

export type TraceLongTaskV1 = { durationMs: number; url?: string };
export type TraceScriptV1 = { durationMs: number; url?: string; line?: number };

export type TraceSummaryV1 = {
	events: number;
	longTasks: number;
	slowestLongTasks: TraceLongTaskV1[];
	cls: number;
	slowestScripts: TraceScriptV1[];
	truncated: boolean;
	note: string;
};

function durationMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value / 1000 * 100) / 100 : undefined;
}

function dataOf(event: Record<string, unknown>): Record<string, unknown> {
	const args = event.args;
	const data = args && typeof args === "object" ? (args as Record<string, unknown>).data : undefined;
	return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function urlOf(data: Record<string, unknown>): string | undefined {
	const url = data.url ?? data.frame ?? data.scriptName;
	return typeof url === "string" && url.length > 0 ? url.slice(0, 512) : undefined;
}

export function summarizeTraceV1(traceText: string, options: { maxEvents?: number } = {}): TraceSummaryV1 {
	const limit = options.maxEvents ?? MAX_TRACE_EVENTS_V1;
	let parsed: unknown;
	try {
		parsed = JSON.parse(traceText);
	} catch {
		throw new Error("trace 文件不是有效 JSON");
	}
	const events = (parsed as { traceEvents?: unknown })?.traceEvents;
	if (!Array.isArray(events)) throw new Error("trace 文件缺少 traceEvents 数组");
	const longTasks: TraceLongTaskV1[] = [];
	const scripts: TraceScriptV1[] = [];
	let cls = 0;
	let scanned = 0;
	for (const event of events as unknown[]) {
		if (scanned >= limit) break;
		if (!event || typeof event !== "object") continue;
		scanned += 1;
		const entry = event as Record<string, unknown>;
		const name = typeof entry.name === "string" ? entry.name : "";
		const duration = durationMs(entry.dur);
		// Chrome records both a "RunTask" span and a "longtask" performance entry for the
		// same work; only the timed span carries a duration worth ranking.
		if (name === "RunTask" && duration !== undefined && duration >= TRACE_LONG_TASK_MS_V1) {
			const url = urlOf(dataOf(entry));
			longTasks.push({ durationMs: duration, ...(url === undefined ? {} : { url }) });
		}
		if (name === "LayoutShift") {
			const data = dataOf(entry);
			const score = typeof data.score === "number" ? data.score : 0;
			// Shifts right after user input are excluded by the CLS definition.
			if (data.hadRecentInput !== true) cls += score;
		}
		if ((name === "EvaluateScript" || name === "FunctionCall") && duration !== undefined) {
			const data = dataOf(entry);
			const url = urlOf(data);
			const line = typeof data.lineNumber === "number" ? data.lineNumber : undefined;
			scripts.push({ durationMs: duration, ...(url === undefined ? {} : { url }), ...(line === undefined ? {} : { line: line + 1 }) });
		}
	}
	const byDuration = (left: { durationMs: number }, right: { durationMs: number }) => right.durationMs - left.durationMs;
	longTasks.sort(byDuration);
	scripts.sort(byDuration);
	return {
		events: events.length,
		longTasks: longTasks.length,
		slowestLongTasks: longTasks.slice(0, TOP_ENTRIES_V1),
		cls: Math.round(cls * 10_000) / 10_000,
		slowestScripts: scripts.slice(0, TOP_ENTRIES_V1),
		truncated: events.length > scanned,
		note: "摘要只统计 devtools.timeline 里的 RunTask/LayoutShift/脚本事件；完整事件在完整文件里",
	};
}
