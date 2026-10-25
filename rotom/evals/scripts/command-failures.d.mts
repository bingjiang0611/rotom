import type { SessionEntry } from "./trace-assertions.mjs";

export type CommandCategory = "search" | "test" | "build" | "lint" | "git" | "package" | "read" | "run" | "other";
export const RETRY_FAILURE_THRESHOLD: number;
export const FAILURE_STREAK_THRESHOLD: number;
export const COMMAND_PROGRAMS: Readonly<Record<string, string[]>>;
export const PACKAGE_MANAGERS: string[];
export const PACKAGE_ACTIONS: string[];
export const SCRIPT_RULES: Array<[CommandCategory, RegExp]>;
export const COMMAND_CATEGORIES: CommandCategory[];
export function commandCategory(commandText: unknown): CommandCategory;
export function callFingerprint(toolName: string, args: unknown): string;
export interface LoopCall { fingerprint: string; failed: boolean | null }
export interface LoopSummary {
	calls: number; failures: number; unknown: number; retries: number; longest: number; looping: boolean;
}
export function failureLoops(calls: readonly LoopCall[]): LoopSummary;
export interface CommandCount { calls: number; failures: number; unknown: number; searchExit1: number }
export interface SessionCommandFailures {
	categories: Record<CommandCategory, { bash: CommandCount; then_run: CommandCount }>;
	sources: { trace: number; toolResult: number; unknown: number };
	loops: LoopSummary;
	verdict?: string;
}
export function sessionCommandFailures(branch: readonly SessionEntry[], traceTools: ReadonlyMap<string, Readonly<Record<string, unknown>>>): SessionCommandFailures;
export interface AggregateCommandFailures {
	categories: Record<CommandCategory, Record<"bash" | "then_run", CommandCount & { rate: number | null; share: number | null }>>;
	sources: SessionCommandFailures["sources"];
	commandFailures: number;
	labels: { looping: { pass: number; fail: number }; nonLooping: { pass: number; fail: number }; n: number; available?: boolean };
	loops: {
		sessions: number; retries: number; loopingSessions: number; longStreakSessions: number;
		failures: number; loopingFailures: number; failureShare: number | null;
		loopingCommandFailures: number; commandFailureShare: number | null;
		longest: { n: number; median: number | null; p90: number | null };
	};
}
export function aggregateCommandFailures(rows: readonly SessionCommandFailures[]): AggregateCommandFailures;
