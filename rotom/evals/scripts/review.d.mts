import type { Readable, Writable } from "node:stream";

export interface ReviewSummary {
	timestamp: number;
	started: string;
	minutes: number | "?";
	tools: number | "?";
	errors: number | "?";
	hits: string[];
	request: string;
	final: string;
}
export interface ReviewCounts {
	pass: number;
	fail: number;
	skipped: number;
	remaining: number;
	damaged: number;
}
export function extractSummary(card: string): ReviewSummary;
export function renderSummary(summary: ReviewSummary, index: number, total: number): string;
export function runReview(cards: readonly { path: string; content: Buffer; labelStart: number }[], options: {
	limit: number;
	input: Readable;
	output: Writable;
	writeCard: (path: string, content: Buffer) => Promise<void>;
	damaged?: number;
}): Promise<ReviewCounts>;
