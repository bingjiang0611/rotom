export interface Stage0Candidate {
	reserveMultiples: number;
	waterMark: string;
	takeoverSegments: number;
	takeoverSegmentShare: number | null;
	takeoverSessions: number;
	takeoverSessionShare: number | null;
}

export interface Stage0Report {
	schema: string;
	reserveTokens: number;
	totals: {
		sessions: number;
		sessionsWithCrossing: number;
		sessionsSupplyingTakeover: Record<number, number>;
		segments: number;
		unknownWindowSegments: number;
		requests: number;
		crossingSegments: number;
		midTurnCrossings: number;
		turnEndCrossings: number;
		goalActiveCrossings: number;
		goalUnknownCrossings: number;
	};
	candidates: Stage0Candidate[];
	turnGrowth: { samples: number; p50: number | null; p90: number | null; max: number | null };
	requestsByModel: Record<string, number>;
	skippedFiles?: number;
}

export interface Stage0Analysis {
	segments: number;
	unknownWindowSegments: number;
	requests: number;
	crossingSegments: number;
	midTurnCrossings: number;
	turnEndCrossings: number;
	takeover: Record<number, number>;
	goalActiveCrossings: number;
	goalUnknownCrossings: number;
	turnGrowth: number[];
	requestsByModel: Record<string, number>;
}

export interface Stage0Verdict {
	threshold: number;
	passed: boolean;
	selectedReserveMultiples: number | null;
	selectedWaterMark: string | null;
	considered: { reserveMultiples: number; takeoverSessionShare: number | null; takeoverSegmentShare: number | null }[];
}

export const DEFAULT_RESERVE_TOKENS: number;
export const CANDIDATE_RESERVE_MULTIPLES: number[];

export function contextTokens(usage: Record<string, number> | undefined): number;
export function loadContextWindows(store: unknown): Map<string, number>;
export function userReserveTokens(settings: unknown): number;
export function parseSessionBody(text: string): unknown[] | null;
export function buildBranch(entries: unknown[]): any[];
export function analyzeSession(entries: unknown[], options: { windows: Map<string, number>; reserveTokens?: number }): Stage0Analysis;
export function aggregate(analyses: Stage0Analysis[], options?: { reserveTokens?: number }): Stage0Report;
export function judge(report: Stage0Report, options?: { threshold?: number }): Stage0Verdict;
export function formatReport(report: Stage0Report, verdict: Stage0Verdict): string;
export function listSessionFiles(root: string): Promise<string[]>;
export function defaultAgentDirectory(environment?: NodeJS.ProcessEnv, home?: string): string;
export function collect(options?: {
	sessionDirectory?: string;
	modelsPaths?: string[];
	settingsPath?: string;
	reserveTokens?: number;
	onSkip?: () => void;
}): Promise<Stage0Report>;
