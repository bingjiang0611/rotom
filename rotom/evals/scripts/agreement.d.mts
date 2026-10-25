export type SignalStatus = "hit" | "clear" | "unknown";
export interface AgreementRow {
	sessionId: string;
	verdict: string;
	categories: readonly string[];
	signals: Readonly<Record<string, SignalStatus>>;
}
export interface SignalAgreement {
	tp: number;
	fp: number;
	fn: number;
	tn: number;
	unknown: number;
	precision: number | null;
	recall: number | null;
	specificity: number | null;
}
export interface AgreementResult {
	totalRows: number;
	evaluatedRows: number;
	ignoredVerdicts: number;
	signals: Record<string, SignalAgreement>;
	categories: Record<string, { fail: number; hits: Record<string, number> }>;
	uncoveredCategories: string[];
	reviewSessions: Record<string, { fp: string[]; fn: string[] }>;
}
export function computeAgreement(rows: readonly AgreementRow[]): AgreementResult;
export function renderAgreementMarkdown(result: AgreementResult): string;
