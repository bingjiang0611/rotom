import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregateCommandFailures, callFingerprint, commandCategory, COMMAND_PROGRAMS, failureLoops, PACKAGE_ACTIONS, PACKAGE_MANAGERS, sessionCommandFailures, type CommandCategory } from "../scripts/command-failures.mjs";
import type { SessionEntry } from "../scripts/trace-assertions.mjs";

const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const entry = (id: string, message: SessionEntry["message"]): SessionEntry => ({ id, type: "message", message });
const call = (id: string, name: string, args: unknown) => entry(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, isError: boolean, details = {}) => entry(`r-${id}`, { role: "toolResult", toolCallId: id, isError, details });

describe("command categories", () => {
	for (const [category, programs] of Object.entries(COMMAND_PROGRAMS)) for (const program of programs) {
		it(`${program} uses the fixed ${category} rule`, () => expect(commandCategory(`${program} fixture`)).toBe(category));
	}
	for (const manager of PACKAGE_MANAGERS) for (const action of PACKAGE_ACTIONS) {
		it(`${manager} ${action} is package`, () => expect(commandCategory(`${manager} ${action}`)).toBe("package"));
	}
	it.each<[string, CommandCategory]>([
		["npm test", "test"], ["npm run test:unit", "test"], ["npm run tests", "test"],
		["npm run build:web", "build"], ["npm run typecheck", "build"], ["npm run lint:fix", "lint"],
		["pnpm test", "test"], ["yarn run build", "build"],
		["node --test fixture.test.js", "test"], ["node --experimental-strip-types --test fixture.ts", "test"],
		["node app.js --test", "run"], ["node --test", "test"],
		["go test ./...", "test"], ["cargo test", "test"], ["cargo build", "build"], ["go build", "build"],
		["sed -n '1,5p' fixture", "read"], ["sed -i 's/a/b/' fixture", "other"],
		["cd '/tmp/a b' && CI=1 npm run test:unit | tail -5", "test"],
		["cd a && cd b && rg needle", "search"], ["cd a || npm test", "other"],
		["CI=1 FLAG='a b' sudo -u fixture npx --yes vitest run", "test"],
		["env CI=1 pnpm exec tsc", "build"], ["npm exec -- eslint fixture", "lint"],
		["/usr/bin/grep x | node a.js", "search"], ["'rg' 'a|b' file", "search"],
		["echo start && npm test", "other"], ["unknown-tool", "other"], ["npm run custom", "other"],
		["$PROGRAM test", "other"], ["$BIN/rg needle", "other"], ["VAR=$(custom) rg needle", "other"], ["sudo -y rg needle", "other"], ["sudo --unknown rg x", "other"], ["npx --package fixture tsc", "other"],
		["npm testicle", "other"], ["go version", "other"], ["", "other"], ["'unterminated", "other"],
		["cd", "other"], ["CI=1", "other"], ["npx", "other"],
		["cd a && \\\npytest", "test"],
	])("%s → %s", (command, category) => expect(commandCategory(command)).toBe(category));
});

it("fingerprints recursively normalize keys but preserve arrays, tool names and command bytes", () => {
	const a = callFingerprint("edit", { path: "fixture", edits: [{ oldText: "x", newText: "y" }], then_run: { command: "npm test" } });
	expect(a).toBe(callFingerprint("edit", { then_run: { command: "npm test" }, edits: [{ newText: "y", oldText: "x" }], path: "fixture" }));
	expect(a).toMatch(/^[a-f0-9]{64}$/u);
	expect(callFingerprint("bash", { command: "x" })).not.toBe(callFingerprint("bash", { command: "x " }));
	expect(callFingerprint("bash", [1, 2])).not.toBe(callFingerprint("bash", [2, 1]));
	expect(callFingerprint("bash", {})).not.toBe(callFingerprint("edit", {}));
});

const loopCall = (fingerprint: string, failed: boolean | null) => ({ fingerprint, failed });
describe("failure loops", () => {
	it("handles empty and singleton sessions", () => {
		expect(failureLoops([])).toEqual({ calls: 0, failures: 0, unknown: 0, retries: 0, longest: 0, looping: false });
		expect(failureLoops([loopCall("a", true)])).toMatchObject({ failures: 1, longest: 1, retries: 0 });
		expect(failureLoops([loopCall("a", false)])).toMatchObject({ failures: 0, longest: 0 });
	});
	it("counts non-adjacent repeats and resets the same fingerprint on success", () => {
		expect(failureLoops([loopCall("a", true), loopCall("b", false), loopCall("a", true), loopCall("a", false), loopCall("a", true)]))
			.toMatchObject({ retries: 1, longest: 1, failures: 3, looping: false });
	});
	it("unknown evidence breaks both a streak and that fingerprint's repeat chain", () => {
		expect(failureLoops([loopCall("a", true), loopCall("a", null), loopCall("a", true)])).toMatchObject({ retries: 0, longest: 1, unknown: 1 });
	});
	it("uses the two independent inclusive thresholds", () => {
		expect(failureLoops(Array.from({ length: 4 }, () => loopCall("a", true)))).toMatchObject({ retries: 3, longest: 4, looping: true });
		expect(failureLoops(Array.from({ length: 5 }, (_, i) => loopCall(String(i), true)))).toMatchObject({ retries: 0, longest: 5, looping: true });
		expect(failureLoops(Array.from({ length: 4 }, (_, i) => loopCall(String(i), true))).looping).toBe(false);
	});
});

describe("session evidence and aggregation", () => {
	it("prefers trace over isError, and separately counts fallback and missing results", () => {
		const branch = [call("a", "bash", { command: "rg fixture" }), result("a", false), call("b", "bash", { command: "npm test" }), result("b", true), call("c", "read", { path: "fixture" })];
		const row = sessionCommandFailures(branch, new Map([[digest("a"), { "pi.tool.outcome": "tool_error", "pi.tool.exit_code": 1 }]]));
		expect(row.sources).toEqual({ trace: 1, toolResult: 1, unknown: 1 });
		expect(row.categories.search.bash).toEqual({ calls: 1, failures: 1, unknown: 0, searchExit1: 1 });
		expect(row.categories.test.bash.failures).toBe(1);
		expect(row.loops).toMatchObject({ failures: 2, longest: 2, unknown: 1 });
		const ok = sessionCommandFailures([call("a", "bash", { command: "rg fixture" }), result("a", true)], new Map([[digest("a"), { "pi.tool.outcome": "ok" }]]));
		expect(ok.loops.failures).toBe(0);
	});
	it("uses isError when a span lacks an outcome, without storing input or hashes", () => {
		const row = sessionCommandFailures([call("a", "bash", { command: "rg SYNTHETIC_PRIVATE_COMMAND" }), result("a", true, { exitCode: 1 })], new Map([[digest("a"), {}]]));
		expect(row.sources.toolResult).toBe(1);
		expect(row.categories.search.bash.searchExit1).toBe(1);
		expect(JSON.stringify(row)).not.toMatch(/SYNTHETIC_PRIVATE_COMMAND|fingerprint|[a-f0-9]{64}/u);
	});
	it("uses fusion phase evidence; rejected edit and skipped commands stay unknown", () => {
		const branch = [
			call("a", "edit", { then_run: { command: "npm test" } }), result("a", true),
			call("b", "edit", { then_run: { command: "npm test" } }), result("b", true),
			call("c", "edit", { then_run: { command: "npm test" } }), result("c", true, { actionFusion: { version: 1, mutation: "applied", followup: "failed" } }),
			call("d", "edit", { then_run: { command: "npm test" } }), result("d", false, { codingPhases: { mutation: "applied", followup: "succeeded" } }),
		];
		const row = sessionCommandFailures(branch, new Map([
			[digest("a"), { "pi.tool.outcome": "followup_failed", "pi.tool.followup_status": "failed" }],
			[digest("b"), { "pi.tool.outcome": "tool_error", "pi.tool.followup_status": "skipped" }],
		]));
		expect(row.categories.test.then_run).toEqual({ calls: 4, failures: 2, unknown: 1, searchExit1: 0 });
		const rejected = sessionCommandFailures(branch.slice(0, 2), new Map());
		expect(rejected.categories.test.then_run).toMatchObject({ failures: 0, unknown: 1 });
	});
	it("aggregates rates, quantiles, provenance, contributions and labels without IDs", () => {
		const looping = sessionCommandFailures(Array.from({ length: 5 }, (_, i) => [call(String(i), "bash", { command: `rg fixture${i}` }), result(String(i), true)]).flat(), new Map());
		const good = sessionCommandFailures([call("a", "bash", { command: "npm test" }), result("a", false)], new Map());
		const data = aggregateCommandFailures([{ ...looping, verdict: "fail" }, { ...good, verdict: "pass" }, { ...good, verdict: "skip" }]);
		expect(data.categories.search.bash).toMatchObject({ calls: 5, failures: 5, rate: 1, share: 1 });
		expect(data.categories.test.bash).toMatchObject({ calls: 2, failures: 0, rate: 0, share: 0 });
		expect(data.loops).toMatchObject({ sessions: 3, retries: 0, loopingSessions: 1, longStreakSessions: 1, failures: 5, loopingFailures: 5, failureShare: 1, longest: { n: 3, median: 0, p90: 5 } });
		expect(data.labels).toEqual({ looping: { pass: 0, fail: 1 }, nonLooping: { pass: 1, fail: 0 }, n: 2 });
		expect(aggregateCommandFailures([]).loops.longest).toEqual({ n: 0, median: null, p90: null });
		expect(aggregateCommandFailures([]).categories.search.bash.rate).toBeNull();
	});
});
