import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateSession, RULE_IDS, SCHEMA_ERROR_THRESHOLD, TOOL_RESULT_BYTE_THRESHOLD, type RuleId, type SessionEntry } from "../scripts/trace-assertions.mjs";

const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const assistant = (id: string, content: Array<{ type: string; [key: string]: unknown }>, stopReason = "toolUse"): SessionEntry => ({ id, type: "message", message: { role: "assistant", content, stopReason } });
const call = (id: string, args: unknown = { command: "PRIVATE_ARGUMENT" }, name = "bash") => ({ type: "toolCall", id, name, arguments: args });
const toolResult = (id: string, toolCallId: string, isError?: boolean): SessionEntry => ({ id, type: "message", message: { role: "toolResult", toolCallId, isError, content: [{ type: "text", text: "PRIVATE_RESULT" }] } });
const completed = (): SessionEntry[] => [assistant("a", [call("c")]), toolResult("r", "c", true), assistant("final", [{ type: "text", text: "PRIVATE_REPLY" }], "stop")];
const attributes = (outcome = "ok") => ({ "pi.tool.outcome": outcome, "pi.tool.result_text_bytes": 10, "pi.tool.fault_side": "environment" });
const tools = (values: Record<string, unknown>[] = [attributes()]) => new Map(values.map((value, index) => [digest(index ? `c${index}` : "c"), value]));
const get = (rule: RuleId, branch: SessionEntry[], traceTools = tools(), traceStatus: "ok" | "partial" | "missing" = "ok") => evaluateSession({ branch, traceTools, traceStatus }).find((finding) => finding.rule === rule)!;

const retry = (isError?: boolean): SessionEntry[] => [
	assistant("first", [call("c", { nested: { b: 2, a: 1 }, list: [1, 2] })]),
	toolResult("result", "c", isError),
	assistant("next", [call("c1", { list: [1, 2], nested: { a: 1, b: 2 } })]),
];
const twoCalls = (): SessionEntry[] => [assistant("a", [call("c")]), toolResult("r", "c", true), assistant("b", [call("c1")])];

describe("trace assertions", () => {
	it.each([
		["hit", true], ["clear", false], ["unknown", undefined],
	] as const)("repeat-after-error: %s", (status, isError) => {
		const finding = get("repeat-after-error", retry(isError));
		expect(finding.status).toBe(status);
		expect(finding.count).toBe(status === "hit" ? 1 : 0);
	});

	it.each([
		["hit", attributes("tool_error")], ["clear", attributes()], ["unknown", {}],
	] as const)("ended-after-tool-error: %s", (status, value) => {
		const finding = get("ended-after-tool-error", completed(), tools([value]));
		expect(finding.status).toBe(status);
		expect(finding.count).toBe(status === "hit" ? 1 : 0);
	});

	it.each([
		["hit", "error"], ["clear", "stop"], ["unknown", undefined],
	] as const)("ended-on-provider-error: %s", (status, stopReason) => {
		const entry = assistant("a", []);
		entry.message!.stopReason = stopReason;
		expect(get("ended-on-provider-error", [entry]).status).toBe(status);
	});

	it.each([
		["hit", [attributes("schema"), attributes("schema")], 2],
		["clear", [attributes("schema"), attributes()], 1],
		["unknown", [attributes("schema"), {}], 1],
	] as const)("schema-errors: %s", (status, values, count) => {
		expect(get("schema-errors", twoCalls(), tools([...values]))).toMatchObject({ status, count });
	});

	it.each([
		["hit", 50_001], ["clear", 50_000], ["unknown", undefined],
	] as const)("oversized-tool-result: %s", (status, bytes) => {
		expect(get("oversized-tool-result", completed(), tools([{ "pi.tool.result_text_bytes": bytes }])).status).toBe(status);
	});

	it.each([
		["hit", "harness"], ["clear", "environment"], ["unknown", undefined],
	] as const)("harness-fault: %s", (status, faultSide) => {
		expect(get("harness-fault", completed(), tools([{ "pi.tool.fault_side": faultSide }])).status).toBe(status);
	});

	it("keeps array order and tool identity, including adjacent calls in one assistant message", () => {
		const changedArguments = retry(true);
		changedArguments[2] = assistant("next", [call("c1", { nested: { a: 1, b: 2 }, list: [2, 1] })]);
		expect(get("repeat-after-error", changedArguments).status).toBe("clear");
		const changedName = retry(true);
		changedName[2] = assistant("next", [call("c1", { nested: { a: 1, b: 2 }, list: [1, 2] }, "read")]);
		expect(get("repeat-after-error", changedName).status).toBe("clear");
		expect(get("repeat-after-error", [assistant("batch", [call("c"), call("c1")]), toolResult("r", "c", true)]).status).toBe("hit");
		expect(get("repeat-after-error", [assistant("a", [call("c")]), assistant("b", [call("c1")]), toolResult("r", "c", true)]).status).toBe("hit");
		expect(get("repeat-after-error", [assistant("a", [call("c")]), assistant("b", [call("c1")])]).status).toBe("unknown");
	});

	it("does not mistake a later different tool for an immediate retry", () => {
		const branch = [assistant("a", [call("c")]), toolResult("r", "c", true), assistant("b", [call("other", {}, "read")]), assistant("c", [call("c1")])];
		expect(get("repeat-after-error", branch).status).toBe("clear");
	});

	it("requires an assistant after the last call and uses that call's digest", () => {
		expect(get("ended-after-tool-error", [assistant("a", [call("c")])], tools([attributes("tool_error")])).status).toBe("unknown");
		const branch = [...completed().slice(0, 2), assistant("b", [call("c1")]), toolResult("r2", "c1", false), assistant("end", [], "stop")];
		expect(get("ended-after-tool-error", branch, tools([attributes("tool_error"), attributes()])).status).toBe("clear");
	});

	it("distinguishes aborted with a later user from provider error", () => {
		const user: SessionEntry = { id: "u", type: "message", message: { role: "user", content: "PRIVATE_USER" } };
		expect(get("ended-on-provider-error", [assistant("a", [], "aborted")]).status).toBe("hit");
		expect(get("ended-on-provider-error", [assistant("a", [], "aborted"), user]).status).toBe("clear");
		expect(get("ended-on-provider-error", [assistant("a", [], "error"), user]).status).toBe("hit");
	});

	it("ignores spans from other branches and keeps partial negatives unknown", () => {
		const traceTools = tools([attributes()]);
		traceTools.set(digest("other-branch"), { ...attributes("schema"), "pi.tool.fault_side": "harness", "pi.tool.result_text_bytes": 90_000 });
		const evaluated = evaluateSession({ branch: completed(), traceTools, traceStatus: "ok" });
		for (const rule of ["schema-errors", "oversized-tool-result", "harness-fault"]) expect(evaluated.find((finding) => finding.rule === rule)?.status).toBe("clear");
		expect(get("schema-errors", completed(), traceTools, "partial").status).toBe("unknown");
		expect(get("harness-fault", completed(), tools([{ "pi.tool.fault_side": "harness" }]), "partial").status).toBe("hit");
	});

	it("does not turn missing trace, unfinished spans or missing input into clear", () => {
		for (const rule of ["ended-after-tool-error", "schema-errors", "oversized-tool-result", "harness-fault"] as const) {
			expect(get(rule, completed(), tools(), "missing").status).toBe("unknown");
			expect(get(rule, completed(), tools([{}]), "partial").status).toBe("unknown");
		}
		for (const finding of evaluateSession({ branch: [], traceTools: new Map(), traceStatus: "missing" })) expect(finding.status).toBe("unknown");
	});

	it.each(["missing-message", "missing-parent"])("does not infer ordering or ending from %s input", (gap) => {
		const branch = [...retry(true), assistant("last", [], "error")];
		if (gap === "missing-message") branch.splice(2, 0, { id: "gap", type: "message" });
		else branch[0].parentId = "unavailable";
		const findings = evaluateSession({ branch, traceTools: tools([attributes("tool_error"), attributes("tool_error")]), traceStatus: "ok" });
		for (const rule of ["repeat-after-error", "ended-after-tool-error", "ended-on-provider-error"]) expect(findings.find((finding) => finding.rule === rule)?.status).toBe("unknown");
	});

	it("returns stable metadata-only results without mutating its inputs", () => {
		const branch = retry(true);
		const traceTools = tools([{ ...attributes("schema"), "pi.tool.fault_side": "harness", "pi.tool.result_text_bytes": 60_000 }, attributes("schema")]);
		const before = JSON.stringify({ branch, traceTools: [...traceTools] });
		const findings = evaluateSession({ branch, traceTools, traceStatus: "ok" });
		expect(findings.map(({ rule }) => rule)).toEqual(RULE_IDS);
		expect(JSON.stringify({ branch, traceTools: [...traceTools] })).toBe(before);
		expect(JSON.stringify(findings)).not.toMatch(/PRIVATE_|arguments|content/);
		expect(findings.find(({ rule }) => rule === "repeat-after-error")?.evidence[0]).toEqual({ entryId: "first", nextEntryId: "next", resultEntryId: "result", tool: "bash" });
		expect(SCHEMA_ERROR_THRESHOLD).toBe(2);
		expect(TOOL_RESULT_BYTE_THRESHOLD).toBe(50_000);
	});
});
