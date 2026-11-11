import { describe, expect, it } from "vitest";
import { BROKEN_QODER_RELEASES, containsCommit, qoderUnavailable, releaseCommit, versionTimeline } from "../src/loop/release-version.ts";
import type { LedgerEntry } from "../src/loop/ledger.ts";
import { acceptanceRows } from "../src/loop/weekly.ts";

const session = (startedAt: string, release: string | undefined, userTurns = 10) => ({ sessionId: startedAt, sessionFile: "", cwd: "", startedAt, modelTurns: {}, models: [], userTurns, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 0, interruptExcluded: 0, ...(release ? { release } : {}) });

function entry(firstCommit: string): LedgerEntry {
	return {
		schema: "rotom-loop-ledger/v1", id: "L-2026-11-11-test", date: "2026-11-11", title: "t", hypothesis: "h", change: "mechanism",
		measurement: "m", result: "r", evidence: "unmeasured", decision: "shipped", source: "s",
		acceptance: { startedAt: "2026-11-10T00:00:00Z", metric: "provider errors", incident: "provider_error", baselinePer100: 6, minimumTurns: 167, expect: "lower", firstCommit },
	} as LedgerEntry;
}

describe("release strings", () => {
	it("traces a mainline build to its commit and refuses to guess for a local build", () => {
		expect(releaseCommit("0.1.27-main.e9c3d5d1")).toBe("e9c3d5d1");
		expect(releaseCommit("0.1.27-local.5d0fcd56")).toBeUndefined();
		expect(releaseCommit(undefined)).toBeUndefined();
		expect(releaseCommit("0.1.27")).toBeUndefined();
	});

	it("treats the fix commit itself as containing the fix", () => {
		expect(containsCommit("abc1234", "abc1234", () => false)).toBe(true);
		expect(containsCommit("abc1234", "def5678", () => true)).toBe(true);
		expect(containsCommit("abc1234", "def5678", () => false)).toBe(false);
	});

	it("records which builds cannot run Qoder at all", () => {
		expect(qoderUnavailable(BROKEN_QODER_RELEASES[0])).toBe(true);
		expect(qoderUnavailable("0.1.27-main.e9c3d5d1")).toBe(false);
	});
});

describe("version timeline", () => {
	it("groups consecutive sessions by release and marks the switcher unknown", () => {
		const timeline = versionTimeline([
			session("2026-11-10T01:00:00Z", "0.1.27-main.50ccdc87", 5),
			session("2026-11-10T02:00:00Z", "0.1.27-main.50ccdc87", 7),
			session("2026-11-11T09:00:00Z", "0.1.27-main.e9c3d5d1", 3),
		]);
		expect(timeline).toHaveLength(2);
		expect(timeline[0]).toMatchObject({ release: "0.1.27-main.50ccdc87", sessions: 2, turns: 12, switchedBy: "unknown" });
		expect(timeline[1]).toMatchObject({ release: "0.1.27-main.e9c3d5d1", commit: "e9c3d5d1", sessions: 1 });
	});

	it("leaves out a session with no release instead of inventing one", () => {
		expect(versionTimeline([session("2026-11-10T01:00:00Z", undefined)])).toHaveLength(0);
	});
});

describe("acceptance exposure follows the product version", () => {
	const incidents = [
		{ kind: "provider_error", sessionId: "s", sessionFile: "", entryId: "e", timestamp: "2026-11-11T10:00:00Z", detail: {} },
	];

	it("counts only turns whose build contains the fix", () => {
		const sessions = [session("2026-11-11T01:00:00Z", "0.1.27-main.50ccdc87", 100), session("2026-11-11T02:00:00Z", "0.1.27-main.e9c3d5d1", 100)];
		const ranWithFix = (s: { release?: string }) => s.release === "0.1.27-main.e9c3d5d1";
		const [row] = acceptanceRows([entry("d8df7cf4")], sessions as never, incidents as never, new Date("2026-11-11T12:00:00Z"), ranWithFix as never);
		expect(row.turns).toBe(100);
	});

	it("counts nothing when the build cannot be traced, and says so", () => {
		const sessions = [session("2026-11-11T02:00:00Z", "0.1.27-local.5d0fcd56", 400)];
		const [row] = acceptanceRows([entry("d8df7cf4")], sessions as never, incidents as never, new Date("2026-11-11T12:00:00Z"), () => false);
		expect(row.turns).toBe(0);
		expect(row.status).toBe("insufficient-exposure");
		expect(row.note).toMatch(/without the fix/u);
	});

	it("keeps counting every turn for a record that names no commit", () => {
		const sessions = [session("2026-11-11T02:00:00Z", "0.1.27-local.5d0fcd56", 400)];
		const without = entry("d8df7cf4");
		delete (without.acceptance as { firstCommit?: string }).firstCommit;
		const [row] = acceptanceRows([without], sessions as never, incidents as never, new Date("2026-11-11T12:00:00Z"), () => false);
		expect(row.turns).toBe(400);
	});
});
