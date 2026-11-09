import type { Stage0Report, Stage0Verdict } from "./rollover-stats.mjs";

export function judge(report: Stage0Report, options?: { threshold?: number }): Stage0Verdict;
export function formatReport(report: Stage0Report, verdict: Stage0Verdict): string;
