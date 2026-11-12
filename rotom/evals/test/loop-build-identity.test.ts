import { describe, expect, it } from "vitest";
import { analyzeSession, buildCommitOf, buildDirtyOf, type Incident, type SessionSummary } from "../src/loop/harvest.ts";
import { acceptanceRows, parseWeeklyConfig, type WeeklyConfig } from "../src/loop/weekly.ts";
import type { LedgerEntry } from "../src/loop/ledger.ts";

const FIX = "a".repeat(40);
const NEW = "b".repeat(40);
const span = (attributes: Record<string, unknown>) => JSON.stringify({ name: "pi.session.runtime", kind: "span_start", attributes });
const lines = [
	{ type: "session", id: "s", timestamp: "2026-11-11T00:00:00Z", cwd: "/repo" },
	{ type: "message", id: "u", parentId: null, timestamp: "2026-11-11T01:00:00Z", message: { role: "user", content: "test" } },
	{ type: "message", id: "a", parentId: "u", timestamp: "2026-11-11T01:01:00Z", message: { role: "assistant", provider: "fixture", model: "test", stopReason: "stop", content: [{ type: "text", text: "answer" }] } },
].map((row) => JSON.stringify(row));
const summary = (id: string, commit?: string): SessionSummary => ({ ...analyzeSession(lines, { sessionFile: "/fixture.jsonl", excerpts: false })!.session, sessionId: id, userTurns: 100, ...(commit ? { buildCommit: commit } : {}) });
const record: LedgerEntry = {
	schema: "rotom-loop-ledger/v1", id: "L-2026-11-11-test", date: "2026-11-11", title: "test", hypothesis: "test", change: "mechanism", measurement: "test", result: "test", evidence: "unmeasured", decision: "shipped", source: "fixture",
	acceptance: { firstCommit: FIX, startedAt: "2026-11-10T00:00:00Z", metric: "failures", incident: "provider_error", baselinePer100: 10, minimumTurns: 100, expect: "lower" },
};

describe("build attribution", () => {
	it("reads dirty and clean commits from the runtime span, with no version fallback", () => {
		expect(buildCommitOf([span({ "rotom.build.commit": FIX })])).toBe(FIX);
		expect(buildCommitOf([span({ "rotom.build.commit": "short" })])).toBeUndefined();
		expect(buildDirtyOf([span({ "rotom.build.dirty": false })])).toBe(false);
		expect(buildDirtyOf([span({ "rotom.build.dirty": true })])).toBe(true);
		expect(buildDirtyOf([])).toBeUndefined();
		const traced = analyzeSession(lines, { sessionFile: "/fixture.jsonl", excerpts: false, traceLines: [span({ "rotom.build.commit": NEW, "rotom.build.dirty": true })] });
		expect(traced!.session).toMatchObject({ buildCommit: NEW, buildDirty: true });
		expect(summary("unknown").buildCommit).toBeUndefined();
	});

	it("uses the same eligible sessions for event numerator and turn denominator; unknown stays separate even above exposure", () => {
		const sessions = [summary("fixed", NEW), summary("old", "c".repeat(40)), summary("unknown")];
		const events = ["fixed", "old", "unknown"].map((id) => ({ sessionId: id, kind: "provider_error", entryId: id, sessionFile: "/fixture.jsonl", timestamp: "2026-11-11T02:00:00Z", detail: {} }) as Incident);
		const [row] = acceptanceRows([record], sessions, events, new Date("2026-11-12T00:00:00Z"), (session, fix) => fix === FIX && session.buildCommit === NEW);
		expect(row).toMatchObject({ turns: 100, observedPer100: 1, buildUnknown: 1 });
		expect(row.note).toContain("1 known builds without the fix");
		expect(row.note).toContain("1 sessions have no build commit");
	});

	it("does not accept an unknown build even if a caller's ancestry callback says yes", () => {
		const [row] = acceptanceRows([record], [summary("unknown")], [], new Date("2026-11-12T00:00:00Z"), () => true);
		expect(row.turns).toBe(0);
		expect(row.buildUnknown).toBe(1);
	});
});
