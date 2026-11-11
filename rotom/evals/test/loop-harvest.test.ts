import { describe, expect, it } from "vitest";
import { analyzeSession, createHarvestShared, isBareContinue, isCorrection } from "../src/loop/harvest.ts";
import { applyRoutineRepeats, markRoutineRepeats } from "../src/loop/harvest-repeat.ts";
import { isoWeek, weeklyMetrics } from "../src/loop/harvest-run.ts";

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

	it("does not read a fused follow-up command failure as an edit failure", () => {
		// Action Fusion returns the applied mutation plus `[then_run:failed]` when the command
		// after the edit failed. The file did change, so retrying it without a read is expected.
		const fused = "Successfully replaced 1 block(s) in a.ts.\n\n[then_run:failed]\n1 test failed";
		const { incidents } = analyze(chain([
			user("改一下 a.ts"),
			call("c1", "edit", { path: "a.ts" }),
			result("c1", "edit", true, fused),
			call("c2", "edit", { path: "a.ts" }),
			result("c2", "edit", false),
			reply("done"),
		]));
		expect(incidents.map((incident) => incident.kind)).toEqual([]);
		const skipped = analyze(chain([
			user("改一下 a.ts"),
			call("c1", "edit", { path: "a.ts" }),
			result("c1", "edit", true, "oldText not found\n\n[then_run:skipped] the command was not run."),
			call("c2", "edit", { path: "a.ts" }),
			result("c2", "edit", false),
			reply("done"),
		]));
		expect(skipped.incidents.map((incident) => incident.kind)).toEqual(["edit_retry_without_read"]);
	});

	it("counts a tool error streak only when the same action fails again", () => {
		const differentCommands = analyze(chain([
			user("看看这两个目录"),
			call("c1", "bash", { command: "ls -d a" }),
			result("c1", "bash", true, "(no output) Command exited with code 1"),
			call("c2", "bash", { command: "ls -d b" }),
			result("c2", "bash", true, "(no output) Command exited with code 1"),
			reply("没有这两个目录"),
		]));
		expect(differentCommands.incidents.map((incident) => incident.kind)).toEqual([]);
		const sameCommand = analyze(chain([
			user("跑测试"),
			call("c1", "bash", { command: "npm test" }),
			result("c1", "bash", true, "1 test failed"),
			call("c2", "bash", { command: "npm test" }),
			result("c2", "bash", true, "1 test failed"),
			reply("还在失败"),
		]));
		expect(sameCommand.incidents.map((incident) => incident.kind)).toEqual(["tool_error_streak"]);
		const recovered = analyze(chain([
			user("跑测试"),
			call("c1", "bash", { command: "npm test" }),
			result("c1", "bash", true, "1 test failed"),
			call("c2", "bash", { command: "npm test" }),
			result("c2", "bash", false, "all passed"),
			call("c3", "bash", { command: "npm test" }),
			result("c3", "bash", true, "1 test failed"),
			reply("又失败了"),
		]));
		expect(recovered.incidents.map((incident) => incident.kind)).toEqual([]);
	});

	it("counts one provider error per retry run, not per attempt", () => {
		const { incidents, session: summary } = analyze(chain([
			user("跑一下"),
			reply("", "error"),
			reply("", "error"),
			reply("", "error"),
			reply("done"),
			reply("", "error"),
		]));
		const errors = incidents.filter((incident) => incident.kind === "provider_error");
		expect(errors).toHaveLength(2);
		expect(errors[0].detail.attempts).toBe(3);
		expect(errors[1].detail.attempts).toBe(1);
		expect(summary.failures).toBe(2);
	});

	it("records provider, model, category and whether the retry run recovered", () => {
		const errorReply = (text: string) => ({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", provider: "qoder", model: "dfmodel", errorMessage: text, timestamp: 0 });
		const recovered = analyze(chain([user("跑一下"), errorReply("Qoder: stream_failed"), reply("done")]));
		const first = recovered.incidents[0];
		expect(first.detail).toMatchObject({ provider: "qoder", model: "dfmodel", category: "qoder:stream_failed", categorySource: "message", code: "qoder:stream_failed", recovered: true, attempts: 1 });

		// A run that ends on the error or on a user turn never reached the user as an answer.
		const unrecovered = analyze(chain([user("跑一下"), errorReply("Qoder: connection_failed"), user("还在吗")]));
		expect(unrecovered.incidents[0].detail).toMatchObject({ category: "connect", recovered: false });
		// An opaque `fetch failed` may have been sent, so it is a network failure, not a connect one.
		const aborted = analyze(chain([user("跑一下"), errorReply("fetch failed"), reply("", "aborted")]));
		expect(aborted.incidents[0].detail).toMatchObject({ category: "network", recovered: false });
	});

	it("prefers the local trace category for a failed request span", () => {
		const errorReply = (text: string) => ({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", provider: "qoder", model: "dfmodel", errorMessage: text, timestamp: 0 });
		const lines = chain([user("跑一下"), errorReply("Qoder: stream_failed"), reply("done")]);
		const stamp = lines[2].timestamp as string;
		const trace = [JSON.stringify({ kind: "span_end", name: "pi.ai.request", status: "error", timestamp: stamp, attributes: { "pi.ai.error.category": "network", "pi.ai.qoder.error_code": "transport_failure" } })];
		const traced = analyze(lines, true, trace);
		expect(traced.incidents[0].detail).toMatchObject({ category: "network", categorySource: "trace", provider: "qoder" });
		// The span is consumed once; a second error without its own span falls back to the message.
		const twoRuns = analyze(chain([user("跑一下"), errorReply("Qoder: stream_failed"), reply("done"), errorReply("Qoder: stream_failed"), reply("done")]), true, trace);
		expect(twoRuns.incidents.map((incident) => incident.detail.categorySource)).toEqual(["trace", "message"]);
	});

	it("ignores a skill template when judging whether the user repeated or corrected", () => {
		const skill = (task: string) => `<skill name="impeccable" location="/skills/impeccable/SKILL.md">\n# Impeccable\nPolish the interface, keep spacing even.\n</skill>\n\n${task}`;
		const { incidents } = analyze(chain([
			user(skill("把这个页面做得更干净，间距保持一致")),
			reply("改好了"),
			user(skill("把这个页面做得更干净，间距保持一致")),
			reply("好的"),
		]));
		expect(incidents.map((incident) => incident.kind)).toEqual(["user_repeat"]);
		expect(incidents[0].excerpt?.user).toBe("把这个页面做得更干净，间距保持一致");
		// `/goal resume` re-delivers the goal contract verbatim; that is not the user repeating a request.
		const resume = "The user explicitly resumed the paused /goal. Continue working toward this goal: <goal_objective> 完成 M1 到 M6 并给我验收报告 </goal_objective>";
		const resumed = analyze(chain([user(resume), reply("收到"), user(resume), reply("继续")]));
		expect(resumed.incidents.map((incident) => incident.kind)).toEqual([]);
		expect(resumed.session.userTurns).toBe(2);

		const templateOnly = analyze(chain([
			user(`<skill name="impeccable" location="/skills/impeccable/SKILL.md">\nYou did not run the build.\n</skill>`),
			reply("好的"),
		]));
		expect(templateOnly.incidents.map((incident) => incident.kind)).toEqual([]);
	});

	it("does not report an interruption-induced Goal pause as a Goal failure", () => {
		const { incidents } = analyze(chain([
			user("/goal ship it"),
			{ entryType: "custom", customType: "goal-state", data: { goal: { id: "g1", status: "paused", stopReason: "agent_interruption" } } },
			{ entryType: "custom", customType: "goal-state", data: { goal: { id: "g2", status: "paused", stopReason: "missing_decision" } } },
		]));
		expect(incidents.map((incident) => [incident.kind, incident.detail.reason])).toEqual([["goal_pause", "missing_decision"]]);
	});

	it("computes ISO weeks and the per-100-turn north star", () => {
		expect(isoWeek("2026-11-09T08:00:00Z")).toBe("2026-W46");
		expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01");
		const weeks = weeklyMetrics([
			{ sessionId: "a", sessionFile: "", cwd: "", startedAt: "2026-11-03T00:00:00Z", startedAtSource: "header", modelTurns: {}, interventionModels: {}, northStarV2: 0,
		v2Models: {}, interruptTriage: { "self-retract": 0, quality: 0, other: 0 }, interruptExcluded: 0, models: [], userTurns: 30, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 3, failures: 1, incidentCounts: { user_correction: 3 } },
			{ sessionId: "b", sessionFile: "", cwd: "", startedAt: "2026-11-04T00:00:00Z", startedAtSource: "header", modelTurns: {}, interventionModels: {}, northStarV2: 0,
		v2Models: {}, interruptTriage: { "self-retract": 0, quality: 0, other: 0 }, interruptExcluded: 0, models: [], userTurns: 10, assistantMessages: 0, toolCalls: 0, toolErrors: 0, interventions: 1, failures: 0, incidentCounts: { bare_continue: 1 } },
		]);
		expect(weeks).toHaveLength(1);
		expect(weeks[0]).toMatchObject({ week: "2026-W45", sessions: 2, userTurns: 40, interventions: 4, interventionsPer100Turns: 10, incidentCounts: { user_correction: 3, bare_continue: 1 } });
	});
});

describe("routine repeat detection", () => {
	// A periodic instruction that the agent answered correctly each time is noise, not a person
	// having to step in. The rule needs the whole window's counts, so it runs after the walk.
	const instruction = "本次仅是维护验证，请实际用只读工具读取两个配置，只回答采集通道与 workspaceId";

	function walk(lines: Line[]) {
		const shared = createHarvestShared();
		const analyzed = analyzeSession(session(lines), { sessionFile: "/s.jsonl", excerpts: true, shared });
		if (!analyzed) throw new Error("not a session");
		applyRoutineRepeats([analyzed.session], markRoutineRepeats(shared));
		return analyzed;
	}

	it("drops a periodic re-send that was answered correctly every time", () => {
		const { incidents, session: summary } = walk(chain([
			user(instruction), reply("- 采集通道：trace、scry - workspaceId：rate-native"),
			user(instruction), reply("- 采集通道：trace、scry - workspaceId：rate-native"),
			user(instruction), reply("- 采集通道：trace、scry - workspaceId：rate-native"),
		]));
		const repeats = incidents.filter((incident) => incident.kind === "user_repeat");
		expect(repeats).toHaveLength(2);
		expect(repeats.every((incident) => incident.detail.routine === true)).toBe(true);
		// Both totals drop the excluded repeats: the incidents stay in the queue for triage.
		expect(summary.interventions).toBe(0);
		expect(summary.northStarV2).toBe(0);
	});

	it("keeps a repeat that followed an answer with no content", () => {
		const { incidents, session: summary } = walk(chain([
			user(instruction), reply(""),
			user(instruction), reply(""),
			user(instruction), reply("采集通道 trace/scry，workspaceId rate-native"),
		]));
		const repeats = incidents.filter((incident) => incident.kind === "user_repeat");
		expect(repeats.length).toBeGreaterThan(0);
		expect(repeats.some((incident) => incident.detail.routine !== true)).toBe(true);
		expect(summary.northStarV2).toBeGreaterThan(0);
	});

	it("keeps a one-off repeat: periodicity needs three occurrences", () => {
		const { incidents } = walk(chain([
			user(instruction), reply("采集通道 trace/scry，workspaceId rate-native"),
			user(instruction), reply("采集通道 trace/scry，workspaceId rate-native"),
		]));
		const repeats = incidents.filter((incident) => incident.kind === "user_repeat");
		expect(repeats).toHaveLength(1);
		expect(repeats[0].detail.routine).toBeUndefined();
	});
});
