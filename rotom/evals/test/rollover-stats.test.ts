import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	aggregate,
	analyzeSession,
	compactionStatsOf,
	buildBranch,
	collect,
	contextTokens,
	defaultAgentDirectory,
	formatReport,
	judge,
	listSessionFiles,
	loadContextWindows,
	parseSessionBody,
	userReserveTokens,
} from "../scripts/rollover-stats.mjs";

const WINDOW = 10_000;
const RESERVE = 1_000;
const windows = new Map([["test/model", WINDOW]]);

/** Sequential JSONL-style session builder: every entry hangs off the previous one. */
class SessionBuilder {
	entries: any[] = [];

	private add(entry: Record<string, unknown>) {
		const id = `e${this.entries.length + 1}`;
		const parentId = this.entries.at(-1)?.id ?? null;
		this.entries.push({ id, parentId, timestamp: "2026-01-01T00:00:00.000Z", ...entry });
		return this;
	}

	model(provider = "test", modelId = "model") {
		return this.add({ type: "model_change", provider, modelId });
	}

	user(content = "user turn") {
		return this.add({ type: "message", message: { role: "user", content } });
	}

	assistant(tokens: number, options: { stopReason?: string; content?: string } = {}) {
		return this.add({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: options.content ?? "answer" }],
				stopReason: options.stopReason ?? "stop",
				usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
	}

	compaction(summary = "compacted", options: { usage?: Record<string, number>; fromHook?: boolean; details?: unknown } = {}) {
		return this.add({
			type: "compaction",
			summary,
			...(options.usage === undefined ? {} : { usage: options.usage }),
			...(options.fromHook === undefined ? {} : { fromHook: options.fromHook }),
			...(options.details === undefined ? {} : { details: options.details }),
		});
	}

	goal(status?: string) {
		return this.add({ type: "custom", customType: "goal-state", data: { goal: status === undefined ? {} : { status } } });
	}
}

function analyze(builder: SessionBuilder, catalog = windows) {
	return analyzeSession(builder.entries, { windows: catalog, reserveTokens: RESERVE });
}

describe("stage-0 accounting primitives", () => {
	it("uses Pi's context accounting: totalTokens first, else the summed usage fields", () => {
		expect(contextTokens({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 })).toBe(18);
		expect(contextTokens({ totalTokens: 40, input: 10, output: 5, cacheRead: 2, cacheWrite: 1 })).toBe(40);
		expect(contextTokens(undefined)).toBe(0);
	});

	it("reads context windows per provider/model from both model source shapes and keeps unresolved models out of the map", () => {
		const catalog = loadContextWindows({
			test: { models: [{ id: "model", contextWindow: WINDOW }, { id: "no-window" }, { id: "zero", contextWindow: 0 }] },
		});
		expect([...catalog.keys()]).toEqual(["test/model"]);
		expect([...loadContextWindows({ providers: { other: { models: [{ id: "m", contextWindow: 200_000 }] } } }).keys()]).toEqual(["other/m"]);
	});

	it("honors an explicit positive reserveTokens setting and otherwise keeps Pi's default", () => {
		expect(userReserveTokens({ compaction: { reserveTokens: 4_096 } })).toBe(4_096);
		expect(userReserveTokens({ compaction: { reserveTokens: 0 } })).toBe(16_384);
		expect(userReserveTokens({ compaction: { reserveTokens: -1 } })).toBe(16_384);
		expect(userReserveTokens({ compaction: { reserveTokens: "8192" } })).toBe(16_384);
		expect(userReserveTokens({})).toBe(16_384);
	});

	it("rejects a body that does not start with a session header instead of guessing", () => {
		expect(parseSessionBody('{"type":"message","id":"a"}\n')).toBeNull();
		expect(parseSessionBody('not json\n')).toBeNull();
		expect(parseSessionBody('{"type":"session","id":"s"}\n{"type":"message","id":"a"}\n')).toEqual([{ type: "message", id: "a" }]);
	});

	it("follows only the leaf chain, so entries on another branch are ignored", () => {
		const entries = [
			{ id: "a", parentId: null, type: "model_change", provider: "test", modelId: "model" },
			{ id: "b", parentId: "a", type: "message", message: { role: "user", content: "u" } },
			{ id: "c", parentId: "b", type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 9_500 } } },
			{ id: "d", parentId: "b", type: "message", message: { role: "assistant", stopReason: "stop", usage: { input: 100 } } },
		];
		expect(buildBranch(entries).map((entry) => entry.id)).toEqual(["a", "b", "d"]);
		expect(analyzeSession(entries, { windows, reserveTokens: RESERVE })).toMatchObject({ requests: 1, crossingSegments: 0 });
	});
});

describe("stage-0 crossing classification", () => {
	it("counts a crossing reached inside a turn as mid-turn", () => {
		const analysis = analyze(
			new SessionBuilder().model().user().assistant(7_500).user().assistant(8_600).assistant(9_500).assistant(9_600),
		);
		expect(analysis).toMatchObject({ segments: 1, requests: 4, crossingSegments: 1, midTurnCrossings: 1, turnEndCrossings: 0 });
	});

	it("counts a crossing reached on the last request of a turn as turn-end", () => {
		const analysis = analyze(new SessionBuilder().model().user().assistant(4_000).assistant(9_100));
		expect(analysis).toMatchObject({ crossingSegments: 1, midTurnCrossings: 0, turnEndCrossings: 1 });
	});

	it("resets the accounting at every compaction entry", () => {
		const analysis = analyze(
			new SessionBuilder().model().user().assistant(9_500).compaction().user().assistant(2_000).assistant(9_100),
		);
		expect(analysis).toMatchObject({ segments: 2, requests: 3, crossingSegments: 2, midTurnCrossings: 0, turnEndCrossings: 2 });
	});

	it("keeps a crossing inside a turn that continues after a compaction as mid-turn", () => {
		// window 10_000, reserve 1_000: the 9_500 request is not the turn's last request, because the
		// same turn keeps requesting (3_000, 4_000) after the compaction entry.
		const analysis = analyze(
			new SessionBuilder().model().user().assistant(5_000).assistant(9_500).compaction().assistant(3_000).assistant(4_000).user().assistant(4_500),
		);
		expect(analysis).toMatchObject({ segments: 2, crossingSegments: 1, midTurnCrossings: 1, turnEndCrossings: 0 });
	});

	it("reports a segment with an unresolved model window separately instead of inventing one", () => {
		const analysis = analyze(new SessionBuilder().model("other", "unknown-model").user().assistant(50_000));
		expect(analysis).toMatchObject({ segments: 1, unknownWindowSegments: 1, requests: 1, crossingSegments: 0 });
		expect(analyze(new SessionBuilder().user().assistant(50_000)).unknownWindowSegments).toBe(1);
	});

	it("ignores aborted, failed and zero-usage assistant messages", () => {
		const analysis = analyze(
			new SessionBuilder().model().user().assistant(9_500, { stopReason: "aborted" }).assistant(9_500, { stopReason: "error" }).assistant(100),
		);
		expect(analysis).toMatchObject({ requests: 1, crossingSegments: 0 });
	});

	it("records whether a Goal was active at the crossing and marks an undecidable Goal as unknown", () => {
		expect(analyze(new SessionBuilder().model().goal("active").user().assistant(9_500))).toMatchObject({ goalActiveCrossings: 1, goalUnknownCrossings: 0 });
		expect(analyze(new SessionBuilder().model().goal("paused").user().assistant(9_500))).toMatchObject({ goalActiveCrossings: 0, goalUnknownCrossings: 0 });
		expect(analyze(new SessionBuilder().model().goal(undefined).user().assistant(9_500))).toMatchObject({ goalActiveCrossings: 0, goalUnknownCrossings: 1 });
	});

	it("reports per-turn context growth distribution from multi-request turns", () => {
		const analysis = analyze(
			new SessionBuilder().model().user().assistant(1_000).assistant(3_000).user().assistant(4_000).assistant(4_200).assistant(6_200),
		);
		expect(analysis.turnGrowth).toEqual([2_000, 2_200]);
	});

	it("only counts an earlier inter-turn point that already passed the candidate water mark", () => {
		// window 10_000, reserve 1_000 -> threshold 9_000, water marks 8_000 / 7_000 / 6_000.
		const analysis = analyze(new SessionBuilder().model().user().assistant(7_500).user().assistant(8_600).assistant(9_500));
		expect(analysis.takeover).toEqual({ 2: 0, 3: 1, 4: 1 });
	});

	it("does not count a water mark reached only inside the crossing turn", () => {
		// The 8_500 request is inside the crossing turn, so it is too late to hand over.
		const analysis = analyze(new SessionBuilder().model().user().assistant(8_500).assistant(9_500).assistant(9_700));
		expect(analysis).toMatchObject({ midTurnCrossings: 1 });
		expect(analysis.takeover).toEqual({ 2: 0, 3: 0, 4: 0 });
	});
});

describe("stage-0 aggregation and gate", () => {
	const crossing = new SessionBuilder().model().user().assistant(7_500).user().assistant(8_600).assistant(9_500).assistant(9_600);
	const plain = new SessionBuilder().model().user().assistant(1_000);

	it("aggregates shares per candidate water mark", () => {
		const report = aggregate([analyze(crossing), analyze(crossing), analyze(plain)], { reserveTokens: RESERVE });
		expect(report).toMatchObject({
			schema: "rotom-rollover-stage0/v1",
			reserveTokens: RESERVE,
			totals: { sessions: 3, sessionsWithCrossing: 2, crossingSegments: 2, requests: 9, midTurnCrossings: 2 },
		});
		expect(report.candidates.map((candidate) => [candidate.reserveMultiples, candidate.takeoverSegments])).toEqual([
			[2, 0],
			[3, 2],
			[4, 2],
		]);
		expect(report.candidates.map((candidate) => candidate.takeoverSessionShare)).toEqual([0, 1, 1]);
	});

	it("judges the session share on the first crossing segment only", () => {
		// First crossing sits in a turn with no earlier inter-turn point; the second one could be
		// taken over at the 3x and 4x water marks (7_500 > 10_000 - 3 x 1_000).
		const session = new SessionBuilder()
			.model()
			.user()
			.assistant(8_500)
			.assistant(9_500)
			.compaction()
			.user()
			.assistant(7_500)
			.user()
			.assistant(9_500);
		const analysis = analyze(session);
		expect(analysis).toMatchObject({ crossingSegments: 2 });
		expect(analysis.takeover).toEqual({ 2: 0, 3: 1, 4: 1 });
		expect(analysis.firstCrossingTakeover).toEqual({ 2: 0, 3: 0, 4: 0 });
		const report = aggregate([analysis], { reserveTokens: RESERVE });
		expect(report.candidates.map((candidate) => [candidate.takeoverSegments, candidate.takeoverSessions])).toEqual([
			[0, 0],
			[1, 0],
			[1, 0],
		]);
		expect(report.candidates.map((candidate) => candidate.takeoverSessionShare)).toEqual([0, 0, 0]);
	});

	it("selects the latest qualifying water mark and fails when none reaches the gate", () => {
		// 3x and 4x both qualify here; the latest water mark is the smallest multiplier.
		const passing = judge(aggregate([analyze(crossing), analyze(crossing)], { reserveTokens: RESERVE }));
		expect(passing).toMatchObject({ passed: true, selectedReserveMultiples: 3, threshold: 0.5 });
		const failing = judge(aggregate([analyze(crossing), analyze(crossing)], { reserveTokens: RESERVE }), { threshold: 1.01 });
		expect(failing).toMatchObject({ passed: false, selectedReserveMultiples: null });
	});

	it("emits aggregate numbers only, with no content, path or session id", () => {
		const session = new SessionBuilder().model().user("secret user text").assistant(9_500, { content: "secret answer text" });
		const report = aggregate([analyze(session)], { reserveTokens: RESERVE });
		const rendered = `${formatReport(report, judge(report))}\n${JSON.stringify(report)}`;
		expect(rendered).not.toContain("secret user text");
		expect(rendered).not.toContain("secret answer text");
		expect(rendered).not.toContain("e1");
		expect(rendered).toContain("crossingSegments=1");
	});
});

describe("stage-0 collection", () => {
	it("only walks session files and skips observability traces", async () => {
		const root = mkdtempSync(join(tmpdir(), "rollover-stats-"));
		mkdirSync(join(root, "observability"), { recursive: true });
		writeFileSync(join(root, "session.jsonl"), '{"type":"session","id":"s"}\n');
		writeFileSync(join(root, "observability", "trace.jsonl"), '{"type":"session","id":"t"}\n');
		writeFileSync(join(root, "other.trace.jsonl"), '{"type":"session","id":"u"}\n');
		writeFileSync(join(root, "notes.txt"), "not a session");
		expect((await listSessionFiles(root)).map((file) => file.slice(root.length + 1))).toEqual(["session.jsonl"]);
	});

	it("collects end to end, using the user reserve setting and skipping unreadable files", async () => {
		const root = mkdtempSync(join(tmpdir(), "rollover-collect-"));
		const sessions = join(root, "sessions", "project");
		mkdirSync(sessions, { recursive: true });
		const body = analyze(new SessionBuilder().model().user().assistant(8_600).assistant(9_500)).crossingSegments;
		expect(body).toBe(1);
		const builder = new SessionBuilder().model().user().assistant(8_600).assistant(9_500).assistant(9_700);
		writeFileSync(join(sessions, "one.jsonl"), `{"type":"session","id":"s"}\n${builder.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		writeFileSync(join(sessions, "broken.jsonl"), "not json\n");
		writeFileSync(join(root, "models-store.json"), JSON.stringify({ test: { models: [{ id: "model", contextWindow: WINDOW }] } }));
		writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { reserveTokens: RESERVE } }));
		let skipped = 0;
		const report = await collect({
			sessionDirectory: join(root, "sessions"),
			modelsPaths: [join(root, "models-store.json"), join(root, "missing-models.json")],
			settingsPath: join(root, "settings.json"),
			onSkip: () => skipped++,
		});
		expect(skipped).toBe(1);
		expect(report).toMatchObject({ reserveTokens: RESERVE, totals: { sessions: 1, crossingSegments: 1, midTurnCrossings: 1 } });
	});

	it("counts native and extension compactions separately and keeps fromHook out of the summary usage", () => {
		const stats = compactionStatsOf(
			new SessionBuilder()
				.model()
				.user()
				.assistant(9_000)
				.compaction("native", { usage: { input: 9_000, output: 500, cacheRead: 100, cacheWrite: 0 } })
				.user()
				.compaction("rollover", { fromHook: true, details: { kind: "rotom-rollover", version: 2 } })
				.compaction("other", { fromHook: true, details: { kind: "sol-pi" } })
				.entries,
		);
		expect(stats).toMatchObject({ entries: 3, native: 1, extension: 2, rollover: 1, otherExtension: 1, nativeWithUsage: 1, nativeWithoutUsage: 0 });
		expect(stats.usage).toEqual({ input: 9_000, output: 500, cacheRead: 100, cacheWrite: 0, totalTokens: 0 });
		expect(contextTokens(stats.usage)).toBe(9_600);
	});

	it("marks native compactions without usable usage instead of treating them as free", () => {
		const stats = compactionStatsOf(new SessionBuilder().model().user().assistant(9_500).compaction("no usage").compaction("zero", { usage: { input: 0 } }).entries);
		expect(stats).toMatchObject({ native: 2, nativeWithUsage: 0, nativeWithoutUsage: 2 });
		expect(contextTokens(stats.usage)).toBe(0);
	});

	it("counts native compactions by Goal state and keeps an unreadable goal unknown", () => {
		const active = compactionStatsOf(new SessionBuilder().model().user().assistant(9_500).goal("active").compaction("native", { usage: { input: 10 } }).goal("blocked").compaction("native", { usage: { input: 20 } }).entries);
		expect(active.nativeDuringActiveGoal).toBe(1);
		expect(active.nativeDuringUnknownGoal).toBe(0);
		const unknown = compactionStatsOf(new SessionBuilder().model().user().goal().compaction("native", { usage: { input: 10 } }).entries);
		expect(unknown.nativeDuringUnknownGoal).toBe(1);
	});

	it("reports the summary share of assistant usage and a null share without assistant usage", () => {
		const report = aggregate([
			analyze(new SessionBuilder().model().user().assistant(9_000).compaction("native", { usage: { input: 1_000 } })),
			analyze(new SessionBuilder().model().user().assistant(3_000)),
		]);
		expect(report.compactions.usage.input).toBe(1_000);
		expect(report.compactions.assistantUsage.input).toBe(12_000);
		expect(report.compactions.usageShare).toBeCloseTo(1_000 / 12_000, 6);
		const empty = aggregate([analyze(new SessionBuilder().model().user().compaction("native", { usage: { input: 10 } }))]);
		expect(empty.compactions.usageShare).toBeNull();
		const text = formatReport(report, judge(report));
		expect(text).toContain("compactions entries=1 native=1 extension=0 rollover=0");
		expect(text).toContain("summaryShare=8.3%");
	});

	it("resolves the agent directory from PI_CODING_AGENT_DIR and falls back to the home directory", () => {
		expect(defaultAgentDirectory({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/user")).toBe("/tmp/agent");
		expect(defaultAgentDirectory({}, "/home/user")).toBe("/home/user/.pi/agent");
	});
});
