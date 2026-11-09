import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeSession, harvest, isBareContinue, isCorrection, isoWeek, weeklyMetrics } from "../src/loop/harvest.ts";

let counter = 0;
type Line = Record<string, unknown>;

function session(lines: Line[]): string[] {
	return [JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-11-03T10:00:00.000Z", cwd: "/work/app" }), ...lines.map((line) => JSON.stringify(line))];
}

/** Linear chain: each entry's parent is the previous one unless given. */
function chain(messages: (Record<string, unknown> & { entryType?: string })[]): Line[] {
	let parentId: string | null = null;
	return messages.map((item) => {
		const id = `e${++counter}`;
		const { entryType, ...rest } = item;
		const entry: Line = entryType ? { type: entryType, id, parentId, timestamp: `2026-11-03T10:${String(counter % 60).padStart(2, "0")}:00.000Z`, ...rest } : { type: "message", id, parentId, timestamp: `2026-11-03T10:${String(counter % 60).padStart(2, "0")}:00.000Z`, message: rest };
		parentId = id;
		return entry;
	});
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, provider: "qoder", model: "dfmodel", timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", provider: "qoder", model: "dfmodel", timestamp: 0 });
const result = (id: string, name: string, isError: boolean, text = "ok") => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 });

function analyze(lines: Line[], excerpts = true, traceLines?: string[]) {
	const analyzed = analyzeSession(session(lines), { sessionFile: "/s.jsonl", excerpts, traceLines });
	if (!analyzed) throw new Error("not a session");
	return analyzed;
}

describe("loop harvest detectors", () => {
	it("recognizes corrections and bare continues without matching ordinary requests", () => {
		for (const text of ["不对，应该改 parser", "你没有跑测试", "我说的是另一个文件", "why didn't you run the build", "That's not what I asked"]) expect(isCorrection(text), text).toBe(true);
		for (const text of ["帮我加一个测试", "看下这个函数", "please add retry logic", "这个不是很清楚的地方帮我解释下"]) expect(isCorrection(text), text).toBe(false);
		for (const text of ["继续", "继续。", "continue", "Keep going"]) expect(isBareContinue(text), text).toBe(true);
		expect(isBareContinue("继续把测试也补上")).toBe(false);
	});

	it("flags user-side interventions once per user turn and keeps excerpts local-only", () => {
		const { session: summary, incidents } = analyze(chain([
			user("把 parser 的 bug 修了"),
			reply("修好了，下一步需要你确认"),
			user("继续"),
			reply("已完成"),
			user("不对，你没有跑测试"),
			reply("好的"),
		]));
		expect(incidents.map((incident) => incident.kind)).toEqual(["bare_continue", "user_correction"]);
		expect(summary.userTurns).toBe(3);
		expect(summary.interventions).toBe(2);
		expect(incidents[1].excerpt?.user).toContain("你没有跑测试");
		expect(incidents[1].excerpt?.assistant).toBe("已完成");
		const bare = analyze(chain([user("修 bug"), reply("done"), user("不对，你没有跑测试"), reply("ok")]), false);
		expect(bare.incidents[0].excerpt).toBeUndefined();
	});

	it("does not call a bare continue after a tool-use stop a premature handoff", () => {
		const { incidents } = analyze(chain([user("跑测试"), reply("partial", "aborted"), user("继续")]));
		expect(incidents.map((incident) => incident.kind)).toEqual(["user_interrupt"]);
	});

	it("detects repeated requests but not a re-send after a provider error", () => {
		const repeated = analyze(chain([user("请把 README 的安装步骤更新一下"), reply("我看了一下"), user("请把 README 的安装步骤更新一下！")]));
		expect(repeated.incidents.map((incident) => incident.kind)).toEqual(["user_repeat"]);
		const resent = analyze(chain([user("请把 README 的安装步骤更新一下"), reply("", "error"), user("请把 README 的安装步骤更新一下")]));
		expect(resent.incidents.map((incident) => incident.kind)).toEqual(["provider_error"]);
	});

	it("detects same-tool error streaks and blind edit retries", () => {
		const { incidents, session: summary } = analyze(chain([
			user("改一下 a.ts"),
			call("c1", "edit", { path: "a.ts" }),
			result("c1", "edit", true, "No edits were written by this call"),
			call("c2", "edit", { path: "a.ts" }),
			result("c2", "edit", true, "No edits were written by this call"),
			call("c3", "read", { path: "a.ts" }),
			result("c3", "read", false),
			call("c4", "edit", { path: "a.ts" }),
			result("c4", "edit", false),
			reply("done"),
		]));
		expect(incidents.map((incident) => incident.kind)).toEqual(["edit_retry_without_read", "tool_error_streak"]);
		expect(summary.toolCalls).toBe(4);
		expect(summary.toolErrors).toBe(2);
		expect(summary.interventions).toBe(0);
		expect(summary.failures).toBe(2);
	});

	it("reports non-user Goal pauses and trace compaction failures", () => {
		const lines = chain([
			user("/goal ship it"),
			{ entryType: "custom", customType: "goal-state", data: { goal: { id: "g1", status: "paused", stopReason: "empty_responses" } } },
			{ entryType: "custom", customType: "goal-state", data: { goal: { id: "g1", status: "paused", stopReason: "empty_responses" } } },
			{ entryType: "custom", customType: "goal-state", data: { goal: { id: "g1", status: "paused", stopReason: "explicit_pause" } } },
		]);
		const trace = [JSON.stringify({ kind: "span_end", name: "pi.session.compaction", status: "error", spanId: "x1", timestamp: "2026-11-03T11:00:00.000Z" }), "{torn"];
		const { incidents } = analyze(lines, true, trace);
		expect(incidents.map((incident) => [incident.kind, incident.detail.reason ?? null])).toEqual([["goal_pause", "empty_responses"], ["compaction_failed", null]]);
	});

	it("dedupes incidents shared by branches", () => {
		const base = chain([user("改 a.ts"), reply("done")]);
		const branchA = { type: "message", id: "ba", parentId: base[1].id, timestamp: "2026-11-03T12:00:00.000Z", message: user("不对，改 b.ts") };
		const branchB = { type: "message", id: "bb", parentId: base[1].id, timestamp: "2026-11-03T12:01:00.000Z", message: user("你没有改测试") };
		const { incidents, session: summary } = analyze([...base, branchA, branchB]);
		expect(incidents.map((incident) => incident.entryId)).toEqual(["ba", "bb"]);
		expect(summary.userTurns).toBe(3);
	});

	it("computes ISO weeks and the per-100-turn north star", () => {
		expect(isoWeek("2026-11-09T08:00:00Z")).toBe("2026-W46");
		expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01");
		const weeks = weeklyMetrics([
			{ sessionId: "a", sessionFile: "", cwd: "", startedAt: "2026-11-03T00:00:00Z", models: [], userTurns: 30, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 3, failures: 1, incidentCounts: { user_correction: 3 } },
			{ sessionId: "b", sessionFile: "", cwd: "", startedAt: "2026-11-04T00:00:00Z", models: [], userTurns: 10, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 1, failures: 0, incidentCounts: { bare_continue: 1 } },
		]);
		expect(weeks).toHaveLength(1);
		expect(weeks[0]).toMatchObject({ week: "2026-W45", sessions: 2, userTurns: 40, interventions: 4, interventionsPer100Turns: 10, incidentCounts: { user_correction: 3, bare_continue: 1 } });
	});
});

describe("loop harvest output", () => {
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	it("writes a private report, skips symlinks, traces and subagent stores", async () => {
		const root = await mkdtemp(join(tmpdir(), "loop-harvest-"));
		roots.push(root);
		const sessions = join(root, "sessions", "--work-app--");
		await mkdir(join(sessions, "observability"), { recursive: true });
		await mkdir(join(sessions, "subagent-artifacts"), { recursive: true });
		const lines = session(chain([user("修 bug"), reply("done"), user("不对，你没有跑测试")]));
		await writeFile(join(sessions, "2026-11-03_s-1.jsonl"), `${lines.join("\n")}\n{"torn`);
		await writeFile(join(sessions, "observability", "2026-11-03_s-1.trace.jsonl"), `${JSON.stringify({ kind: "span_end", name: "pi.session.compaction", status: "error", spanId: "t" })}\n`);
		await writeFile(join(sessions, "subagent-artifacts", "child.jsonl"), lines.join("\n"));
		await writeFile(join(root, "elsewhere.jsonl"), lines.join("\n"));
		await symlink(join(root, "elsewhere.jsonl"), join(sessions, "linked.jsonl"));

		const out = join(root, "loop");
		const result = await harvest({ sessionsDir: join(root, "sessions"), outRoot: out, since: new Date("2026-01-01T00:00:00Z"), now: new Date("2026-11-09T00:00:00Z"), excerpts: true });
		expect(result.sessions).toHaveLength(1);
		expect(result.incidents.map((incident) => incident.kind).sort()).toEqual(["compaction_failed", "user_correction"]);
		expect(result.skipped).toBe(1);
		expect(((await lstat(result.outDir)).mode & 0o777)).toBe(0o700);
		const files = (await readdir(result.outDir)).sort();
		expect(files).toEqual(["incidents.jsonl", "report.md", "sessions.jsonl", "summary.json"]);
		for (const file of files) expect(((await lstat(join(result.outDir, file))).mode & 0o777)).toBe(0o600);
		const report = await readFile(join(result.outDir, "report.md"), "utf8");
		expect(report).toContain("| 2026-W45 | 1 | 2 | 1 | 50 | 1 |");
		expect(JSON.parse(await readFile(join(result.outDir, "summary.json"), "utf8"))).toMatchObject({ schema: "rotom-loop-harvest/v1", sessions: 1, incidents: 2 });
	});
});
